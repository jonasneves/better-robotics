// Browser-native TTS + opt-in OpenAI TTS upgrade. One module so the
// watcher's speak action, user scripts, and Pip's speak tool all share
// the same voice — flipping engines is a single-file change.
//
// Branch: if settings.pipOpenaiKey is configured we POST to OpenAI's
// /v1/audio/speech and stream the response into a MediaSource for
// progressive playback. Otherwise — and on any OpenAI failure
// (network / key / quota) — fall back to Web Speech so the demo never
// goes silent.
//
// Latency optimizations layered in:
//   1. MediaSource streaming  — starts playback as soon as the first
//      chunk arrives instead of buffering the whole response. Saves
//      200-400ms time-to-first-audio.
//   2. gpt-4o-mini-tts        — lower TTFB than tts-1 (~250ms vs
//      ~400ms) AND supports a free-form `instructions` parameter for
//      custom voice character (no more picking from 6 fixed voices).
//   3. Connection pre-warm    — first speak() fires a parallel no-op
//      HEAD request to pay the TLS handshake once. Subsequent calls
//      reuse the keep-alive connection.
//   4. cancel-on-new          — aborts the in-flight fetch AND pauses
//      the in-flight Audio so a new speak() pre-empts cleanly instead
//      of queueing behind stale work. Latest thought wins.
//
// Web Speech (the fallback) picks a voice by ordered name allowlist
// preferring natural-sounding male voices on each platform (macOS
// Alex, Windows 11 Microsoft Guy, etc.), then anything tagged "male",
// then whatever's available.

import { settings } from "./settings.js";

// ─ OpenAI TTS configuration ─────────────────────────────────────────

// gpt-4o-mini-tts ships custom voice instructions — the base voice
// (alloy) is a neutral young-sounding starting point that the
// instructions then characterize. Switch to "tts-1" + a fixed voice
// (alloy/echo/fable/onyx/nova/shimmer) if you ever want the cheaper
// or simpler model — tts-1 ignores `instructions`.
const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = "alloy";
// Free-form voice direction — only honored by gpt-4o-mini-tts.
// Peppy young-hero vibe instead of the deep-narrator onyx default.
const OPENAI_TTS_INSTRUCTIONS =
  "Speak with a peppy, youthful, slightly excited energy. " +
  "Sound like a young hero — quick, enthusiastic, friendly. " +
  "American accent, slightly higher pitched than a typical narrator.";
// mp3 is the most reliable MediaSource codec across browsers (Chrome,
// Safari, Firefox all support audio/mpeg in MSE). Opus would be ~30%
// smaller but Safari's MSE doesn't accept OGG-wrapped Opus, which is
// what OpenAI returns. Stick with mp3 for now.
const OPENAI_TTS_FORMAT = "mp3";
const OPENAI_TTS_MIME = "audio/mpeg";
const OPENAI_API = "https://api.openai.com";

// ─ Cancel-on-new state ──────────────────────────────────────────────

let _currentAudio = null;
let _currentAbort = null;

function cancelOpenAIPlayback() {
  if (_currentAbort) { try { _currentAbort.abort(); } catch {} _currentAbort = null; }
  if (_currentAudio) {
    try { _currentAudio.pause(); } catch {}
    if (_currentAudio.src) { try { URL.revokeObjectURL(_currentAudio.src); } catch {} }
    _currentAudio = null;
  }
}

// ─ Connection pre-warm ──────────────────────────────────────────────

// Pay the TLS handshake cost (~150-250ms) on the first speak() instead
// of inside it. Subsequent speak()s reuse the kept-alive HTTP/2
// connection from the browser's connection pool. Once per page load.
let _warmedUp = false;
function warmupConnection(key) {
  if (_warmedUp) return;
  _warmedUp = true;
  // HEAD on a cheap endpoint — opens the connection, costs nothing.
  // Fire-and-forget; we just want the side effect of the open socket.
  fetch(`${OPENAI_API}/v1/models`, {
    method: "HEAD",
    headers: { "Authorization": `Bearer ${key}` },
  }).catch(() => { /* warmup is best-effort */ });
}

// ─ OpenAI TTS path ──────────────────────────────────────────────────

// Returns a Promise that resolves when the audio FINISHES playing (or
// errors / is preempted). Callers can await it to schedule the next
// action — no need to estimate TTS duration. Non-awaiting callers get
// fire-and-forget behavior (the Promise is just discarded).
async function speakOpenAI(text, key) {
  cancelOpenAIPlayback();
  if (typeof speechSynthesis !== "undefined") {
    try { speechSynthesis.cancel(); } catch {}
  }

  warmupConnection(key);

  const controller = new AbortController();
  _currentAbort = controller;

  const body = {
    model: OPENAI_TTS_MODEL,
    voice: OPENAI_TTS_VOICE,
    input: text,
    response_format: OPENAI_TTS_FORMAT,
  };
  // tts-1 ignores instructions but the API doesn't error on the
  // extra field. Only send when we're on a model that honors it.
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

  // Stream into MediaSource so playback starts as soon as the first
  // chunk lands. Fallback to buffer-then-play if MediaSource isn't
  // supported or the codec mismatches (Safari versions vary).
  const mseOk = typeof MediaSource !== "undefined"
    && typeof MediaSource.isTypeSupported === "function"
    && MediaSource.isTypeSupported(OPENAI_TTS_MIME);
  if (mseOk) {
    return playStreamingMSE(res, controller);
  }
  const blob = await res.blob();
  if (controller.signal.aborted) return;
  return playBlob(blob);
}

// Progressive playback: read the response body chunk-by-chunk and
// append into a MediaSource. Audio starts as soon as the decoder has
// enough header data — typically within ~50-100ms of the first chunk.
function playStreamingMSE(res, controller) {
  return new Promise((resolve) => {
    const mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    const audio = new Audio(url);
    _currentAudio = audio;

    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      if (_currentAudio === audio) _currentAudio = null;
      try { URL.revokeObjectURL(url); } catch {}
      resolve();
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;

    mediaSource.addEventListener("sourceopen", async () => {
      let sourceBuffer;
      try {
        sourceBuffer = mediaSource.addSourceBuffer(OPENAI_TTS_MIME);
      } catch (err) {
        console.warn("[voice] MSE addSourceBuffer failed, aborting stream:", err);
        cleanup();
        return;
      }

      // Backpressure queue — appendBuffer is async and we can't call
      // it again until updateend fires. Reader can outrun the decoder.
      const queue = [];
      let reading = true;
      const drain = () => {
        if (controller.signal.aborted) {
          try { if (mediaSource.readyState === "open") mediaSource.endOfStream(); } catch {}
          return;
        }
        if (sourceBuffer.updating) return;
        if (queue.length > 0) {
          try { sourceBuffer.appendBuffer(queue.shift()); }
          catch (err) { console.warn("[voice] appendBuffer failed:", err); cleanup(); }
        } else if (!reading) {
          try { if (mediaSource.readyState === "open") mediaSource.endOfStream(); } catch {}
        }
      };
      sourceBuffer.addEventListener("updateend", drain);

      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) break;
          if (done) { reading = false; drain(); break; }
          queue.push(value);
          drain();
        }
      } catch (err) {
        if (!controller.signal.aborted) console.warn("[voice] stream read failed:", err);
        cleanup();
      }
    });

    audio.play().catch(cleanup);
  });
}

function playBlob(blob) {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  _currentAudio = audio;
  return new Promise((resolve) => {
    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      if (_currentAudio === audio) _currentAudio = null;
      try { URL.revokeObjectURL(url); } catch {}
      resolve();
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;
    audio.play().catch(cleanup);
  });
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

// Same Promise-on-end semantics as speakOpenAI so callers can uniformly
// await speak() regardless of which engine is active.
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

// ─ Public surface ───────────────────────────────────────────────────

export function speak(text) {
  if (!text) return Promise.resolve();
  const key = settings?.pipOpenaiKey;
  if (key) {
    return speakOpenAI(String(text), key).catch(err => {
      console.warn("[voice] OpenAI TTS failed, falling back to Web Speech:", err?.message || err);
      return speakWebSpeech(text);
    });
  }
  return speakWebSpeech(text);
}

export function currentVoice() {
  const usingOpenAI = !!settings?.pipOpenaiKey;
  if (usingOpenAI) {
    return {
      engine: "openai",
      model: OPENAI_TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      instructions: OPENAI_TTS_MODEL.startsWith("gpt-4o") ? OPENAI_TTS_INSTRUCTIONS : null,
      streaming: typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(OPENAI_TTS_MIME),
    };
  }
  return _voice
    ? { engine: "web-speech", name: _voice.name, lang: _voice.lang }
    : { engine: "web-speech", name: null };
}
if (typeof window !== "undefined") window.currentVoice = currentVoice;
