// Browser-native TTS + opt-in OpenAI TTS upgrade. One module so the
// watcher's speak action, user scripts, and Pip's speak tool all share
// the same voice — flipping engines is a single-file change.
//
// Latency stack (top → bottom in saved-ms):
//   * Cache API hit (~0 ms)        — repeat phrases bypass network entirely
//   * AudioContext PCM streaming   — ~100 ms vs MediaSource MP3; skips
//                                    MP3 priming silence + decoder warmup
//   * <link rel=preconnect>        — TLS pre-open in index.html
//   * Warm GET on first speak()    — opens HTTP/2 connection for reuse
//   * gpt-4o-mini-tts              — ~150 ms lower TTFB than tts-1, plus
//                                    free-form `instructions` for voice
//                                    character
//   * cancel-on-new                — pre-empts stale playback so latest
//                                    thought wins on rapid speak() calls
//
// Falls back to Web Speech when no OpenAI key is configured OR any of
// the cloud paths fail (network blip, bad key, quota hit, codec issue).
// Demo never goes silent.
//
// Web Speech (the fallback) picks a voice by ordered name allowlist
// preferring natural-sounding male voices on each platform.

import { settings } from "./settings.js";

// ─ OpenAI TTS configuration ─────────────────────────────────────────

const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = "alloy";
const OPENAI_TTS_INSTRUCTIONS =
  "Speak with a peppy, youthful, slightly excited energy. " +
  "Sound like a young hero — quick, enthusiastic, friendly. " +
  "American accent, slightly higher pitched than a typical narrator.";
// PCM @ 24kHz int16 mono — no container, no decoder priming silence,
// each byte is audio the moment it lands. The AudioContext samples at
// 24000 to skip resampling.
const OPENAI_TTS_FORMAT = "pcm";
const OPENAI_TTS_SAMPLE_RATE = 24000;
const OPENAI_API = "https://api.openai.com";
// Bump on any change to model / voice / instructions / format, OR to
// invalidate accumulated bad renders (e.g. when peppy instructions
// cause gpt-4o-mini-tts to vocalize punctuation as "dot" — once a bad
// render is cached we replay it forever, so the cleanest invalidation
// is a fresh cache namespace).
const CACHE_NAME = "tts-v2";

// ─ AudioContext (lazy, gesture-bound) ───────────────────────────────

// Created lazily inside the first speak() call. AudioContext needs a
// user gesture to start producing audio in modern browsers — our first
// speak is almost always inside one (mic button click → onSubmit, demo
// slash command from typed input, etc.). resume() is idempotent and
// cheap if already running.
let _audioCtx = null;
let _nextStartTs = 0;
function audioCtx() {
  if (_audioCtx) return _audioCtx;
  try {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: OPENAI_TTS_SAMPLE_RATE,
      latencyHint: "interactive",
    });
  } catch {
    _audioCtx = null;
  }
  return _audioCtx;
}

// ─ Cancel-on-new state ──────────────────────────────────────────────

// Tracks every BufferSourceNode scheduled for the current utterance so
// a new speak() can stop them all + abort the in-flight fetch.
let _activeSources = [];
let _currentAbort = null;

function cancelOpenAIPlayback() {
  if (_currentAbort) { try { _currentAbort.abort(); } catch {} _currentAbort = null; }
  for (const node of _activeSources) {
    try { node.stop(); } catch {}
  }
  _activeSources = [];
  _nextStartTs = 0;
}

// ─ Connection pre-warm ──────────────────────────────────────────────

// Pay the TLS handshake cost on first speak() instead of inside the
// first user-visible request. <link rel=preconnect> already covers
// the very first cold-start (HTML parse → connection open in parallel),
// but the connection can be evicted before any speak runs. The warmup
// GET re-opens it within the keep-alive window.
let _warmedUp = false;
function warmupConnection(key) {
  if (_warmedUp) return;
  _warmedUp = true;
  // GET /v1/models negotiates the same ALPN / cipher path as the POST
  // we'll soon make to /v1/audio/speech, unlike HEAD which can take a
  // different path and not actually warm the right socket.
  fetch(`${OPENAI_API}/v1/models`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${key}` },
  }).catch(() => { /* warmup is best-effort */ });
}

// ─ Cache API (repeat-phrase shortcut) ───────────────────────────────

// Identity key = (model, voice, instructions, format, text). Hashed
// via SubtleCrypto SHA-256 so the URL key stays a fixed length
// regardless of phrase length. Cached value: the raw PCM bytes that
// came back from the API, stored as a Response wrapping a Blob so the
// Cache API accepts it.
async function cacheKeyFor(text) {
  const canonical = JSON.stringify({
    m: OPENAI_TTS_MODEL,
    v: OPENAI_TTS_VOICE,
    i: OPENAI_TTS_INSTRUCTIONS,
    f: OPENAI_TTS_FORMAT,
    t: text,
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `/tts-cache/${hex}.pcm`;
}

async function cacheGet(text) {
  if (!("caches" in self)) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const key = await cacheKeyFor(text);
    const res = await cache.match(key);
    if (!res) return null;
    return await res.arrayBuffer();
  } catch { return null; }
}

async function cachePut(text, bytes) {
  if (!("caches" in self)) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const key = await cacheKeyFor(text);
    // gpt-4o-mini-tts is NOT documented as deterministic across calls
    // — but once cached, we replay the cached bytes forever, which is
    // fine. Determinism would just mean a build-time pre-bake could
    // also seed the same cache; without it, the first runtime call
    // seeds it.
    await cache.put(key, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
  } catch { /* cache is best-effort */ }
}

// ─ Audio scheduling helpers ─────────────────────────────────────────

// int16 PCM bytes → AudioBuffer + scheduled BufferSource on the
// shared AudioContext. Returns the source node so callers can stash it
// for cancel-on-new. nextStart is tracked at module scope so chained
// chunks play head-to-tail without gaps.
function scheduleInt16Chunk(ctx, int16Bytes) {
  const i16 = new Int16Array(int16Bytes.buffer, int16Bytes.byteOffset, int16Bytes.byteLength / 2);
  if (i16.length === 0) return null;
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  const buf = ctx.createBuffer(1, f32.length, OPENAI_TTS_SAMPLE_RATE);
  buf.copyToChannel(f32, 0);
  const node = ctx.createBufferSource();
  node.buffer = buf;
  node.connect(ctx.destination);
  if (_nextStartTs < ctx.currentTime) _nextStartTs = ctx.currentTime + 0.02;
  node.start(_nextStartTs);
  _nextStartTs += buf.duration;
  _activeSources.push(node);
  return node;
}

// Resolves when all scheduled chunks for this utterance have finished
// playing. We attach onended to the LAST node we scheduled.
function awaitPlaybackEnd(lastNode) {
  if (!lastNode) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    lastNode.onended = finish;
    // Safety net in case onended doesn't fire (e.g. context closed):
    // wait up to the buffer duration + 100ms past schedule.
    setTimeout(finish, Math.max(500, (_nextStartTs - lastNode.context.currentTime) * 1000 + 500));
  });
}

// ─ OpenAI TTS path ──────────────────────────────────────────────────

// Returns a Promise that resolves when audio FINISHES playing (or
// errors / is preempted). Non-awaiting callers get fire-and-forget.
async function speakOpenAI(text, key) {
  cancelOpenAIPlayback();
  if (typeof speechSynthesis !== "undefined") {
    try { speechSynthesis.cancel(); } catch {}
  }

  const ctx = audioCtx();
  if (!ctx) throw new Error("AudioContext unavailable");
  if (ctx.state === "suspended") {
    try { await ctx.resume(); } catch {}
  }

  warmupConnection(key);

  // Cache hit: full PCM bytes already on disk — schedule + play
  // instantly, no network, no decoder. ~0ms TTFA.
  const cached = await cacheGet(text);
  if (cached) {
    const lastNode = scheduleInt16Chunk(ctx, new Uint8Array(cached));
    return awaitPlaybackEnd(lastNode);
  }

  // Miss: stream the PCM body and schedule chunks as they arrive.
  // Cache the full body after success for the next call.
  const controller = new AbortController();
  _currentAbort = controller;

  const body = {
    model: OPENAI_TTS_MODEL,
    voice: OPENAI_TTS_VOICE,
    input: text,
    response_format: OPENAI_TTS_FORMAT,
  };
  if (OPENAI_TTS_MODEL.startsWith("gpt-4o")) {
    body.instructions = OPENAI_TTS_INSTRUCTIONS;
  }

  const res = await fetch(`${OPENAI_API}/v1/audio/speech`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  if (controller.signal.aborted) return;
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI TTS ${res.status}: ${errText.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const buffered = [];     // for cache write
  let lastNode = null;
  // The first chunk often arrives as fewer bytes than 1 sample (PCM
  // chunk boundaries don't align to int16 boundaries). Accumulate into
  // a 1-sample-aligned buffer and flush in even-byte slices.
  let tail = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) break;
      if (done) break;
      buffered.push(value);
      // Merge tail + new value, then split off any trailing odd byte.
      const merged = new Uint8Array(tail.length + value.length);
      merged.set(tail, 0);
      merged.set(value, tail.length);
      const evenLen = merged.length - (merged.length % 2);
      if (evenLen > 0) {
        lastNode = scheduleInt16Chunk(ctx, merged.subarray(0, evenLen)) || lastNode;
      }
      tail = merged.subarray(evenLen);
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  }
  if (controller.signal.aborted) return;

  // Stitch all chunks back together for the cache (cheaper than
  // re-fetching, and gpt-4o-mini-tts isn't documented deterministic so
  // we can't assume a re-fetch would match).
  const total = buffered.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of buffered) { merged.set(c, off); off += c.length; }
  cachePut(text, merged);

  return awaitPlaybackEnd(lastNode);
}

// ─ Web Speech path (the fallback) ───────────────────────────────────

const MALE_NAME_PREFS = [
  "Alex",                    // macOS, premium quality
  "Microsoft Guy Online",    // Windows 11 neural
  "Microsoft Guy",
  "Microsoft David Desktop",
  "Microsoft David",
  "Microsoft Mark",
  "Google UK English Male",
  "Google US English Male",
  "Daniel",                  // macOS UK male
  "Tom", "Aaron", "Fred", "Reed", "Eddy", "James",
];

let _voice = null;
let _voiceResolved = false;

function pickVoice(voices) {
  if (!voices?.length) return null;
  const en = voices.filter(v => v.lang?.toLowerCase().startsWith("en"));
  for (const name of MALE_NAME_PREFS) {
    const hit = en.find(v => v.name === name) || voices.find(v => v.name === name);
    if (hit) return hit;
  }
  const maleTagged = (vs) => vs.find(v => /\bmale\b/i.test(v.name) && !/female/i.test(v.name));
  return maleTagged(en) || maleTagged(voices) || en[0] || voices[0] || null;
}

function refreshVoice() {
  if (typeof speechSynthesis === "undefined") return;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  _voice = pickVoice(voices);
  _voiceResolved = true;
}

if (typeof speechSynthesis !== "undefined") {
  refreshVoice();
  if ("addEventListener" in speechSynthesis) {
    speechSynthesis.addEventListener("voiceschanged", refreshVoice);
  } else {
    speechSynthesis.onvoiceschanged = refreshVoice;
  }
}

function speakWebSpeech(text) {
  if (!text || typeof speechSynthesis === "undefined") return Promise.resolve();
  if (!_voiceResolved) refreshVoice();
  return new Promise((resolve) => {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      if (_voice) u.voice = _voice;
      const done = () => resolve();
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    } catch { resolve(); }
  });
}

// ─ Speaking-state broadcast (for mic-input feedback gating) ─────────

// All major voice assistants (Alexa, Siri, Google) suspend the mic
// while TTS is speaking — Web Speech Recognition can't accept a custom
// getUserMedia stream so we can't apply browser-level echo cancellation
// at the recognizer; and on mobile, hardware AEC is unreliable. So
// assistant.js subscribes to these events and stops/restarts dictation
// around every utterance. Without this, the recognizer transcribes the
// robot's own voice back as the next user command.
const _speakingListeners = new Set();
let _speakingCount = 0;

function setSpeaking(on) {
  if (on) {
    _speakingCount++;
    if (_speakingCount === 1) emitSpeaking(true);
  } else {
    _speakingCount = Math.max(0, _speakingCount - 1);
    if (_speakingCount === 0) emitSpeaking(false);
  }
}

function emitSpeaking(speaking) {
  for (const fn of _speakingListeners) {
    try { fn(speaking); } catch (err) { console.warn("[voice] speaking-listener:", err); }
  }
}

export function onSpeakingChange(fn) {
  _speakingListeners.add(fn);
  return () => _speakingListeners.delete(fn);
}

export function isSpeaking() { return _speakingCount > 0; }

// ─ Public surface ───────────────────────────────────────────────────

export function speak(text) {
  if (!text) return Promise.resolve();
  setSpeaking(true);
  const key = settings?.pipOpenaiKey;
  const p = key
    ? speakOpenAI(String(text), key).catch(err => {
        console.warn("[voice] OpenAI TTS failed, falling back to Web Speech:", err?.message || err);
        return speakWebSpeech(text);
      })
    : speakWebSpeech(text);
  // Decrement on resolve OR reject — utterance played, was cancelled,
  // or errored; either way it's no longer producing audio. Both paths
  // resolve their promise even on cancellation (cancel-on-new fires
  // onended on the buffer source nodes, Web Speech utterance.onend fires
  // on cancel + on error).
  p.then(() => setSpeaking(false), () => setSpeaking(false));
  return p;
}

// Pre-warm the TTS cache for hardcoded phrases. Called from
// assistant.js on dashboard init — runs in the background so the first
// time any demo speaks a stock phrase, the audio is already in Cache
// API and plays instantly with zero network. Skipped silently if no
// OpenAI key is configured (Web Speech path doesn't benefit from
// caching — utterances render in-engine).
//
// Sequential rather than concurrent so we don't slam the API with 30
// parallel requests on every page load — adds a few seconds of
// background work but no visible latency. Cache hits skip the fetch
// entirely, so subsequent reloads only fetch genuinely new phrases.
export async function prewarmCache(phrases) {
  const key = settings?.pipOpenaiKey;
  if (!key || !Array.isArray(phrases) || phrases.length === 0) return { cached: 0, fetched: 0, skipped: 0 };
  if (!("caches" in self)) return { cached: 0, fetched: 0, skipped: phrases.length };
  let cached = 0, fetched = 0, failed = 0;
  for (const text of phrases) {
    const t = String(text || "").trim();
    if (!t) continue;
    if (await cacheGet(t)) { cached++; continue; }
    try {
      const body = {
        model: OPENAI_TTS_MODEL,
        voice: OPENAI_TTS_VOICE,
        input: t,
        response_format: OPENAI_TTS_FORMAT,
      };
      if (OPENAI_TTS_MODEL.startsWith("gpt-4o")) body.instructions = OPENAI_TTS_INSTRUCTIONS;
      const res = await fetch(`${OPENAI_API}/v1/audio/speech`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { failed++; continue; }
      const bytes = new Uint8Array(await res.arrayBuffer());
      await cachePut(t, bytes);
      fetched++;
    } catch {
      failed++;
    }
  }
  const result = { cached, fetched, failed, total: phrases.length };
  console.info("[voice] cache prewarm:", result);
  return result;
}

export function currentVoice() {
  const usingOpenAI = !!settings?.pipOpenaiKey;
  if (usingOpenAI) {
    return {
      engine: "openai",
      model: OPENAI_TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      instructions: OPENAI_TTS_MODEL.startsWith("gpt-4o") ? OPENAI_TTS_INSTRUCTIONS : null,
      streaming: typeof AudioContext !== "undefined" || typeof webkitAudioContext !== "undefined",
      format: OPENAI_TTS_FORMAT,
      cache: "caches" in self ? CACHE_NAME : null,
    };
  }
  return _voice
    ? { engine: "web-speech", name: _voice.name, lang: _voice.lang }
    : { engine: "web-speech", name: null };
}
if (typeof window !== "undefined") window.currentVoice = currentVoice;
