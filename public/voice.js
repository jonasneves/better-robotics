// Browser-native TTS + opt-in OpenAI TTS upgrade. One module so the
// watcher's speak action, user scripts, and Pip's speak tool all share
// the same voice — flipping engines is a single-file change.
//
// Branch: if settings.pipOpenaiKey is configured we POST to OpenAI's
// /v1/audio/speech (much more natural quality, ~$0.0009 per typical
// demo line at tts-1 pricing). Otherwise — and on any OpenAI failure
// (network / key / quota) — fall back to Web Speech so the demo never
// goes silent. Net: zero-config users keep the current voice, users
// who set an OpenAI key get the upgrade automatically.
//
// Web Speech has no gender field. Voice is picked by an ordered name
// allowlist that prefers the natural-sounding male voices on each
// platform (macOS Alex, Windows 11 Microsoft Guy, etc.), then falls
// back to anything tagged "male", then to whatever's available.
//
// cancel() before each utterance because queued speech feels broken
// during a fast reflex loop — the user hears the third detection
// announce only after the first two finish. Latest thought wins.

import { settings } from "./settings.js";

// ─ OpenAI TTS path ──────────────────────────────────────────────────

// fable = young, expressive, lightly British — closest tts-1 voice to a
// "Spiderman" peppy-young-hero vibe. Onyx (the previous default) reads
// as a deep-adult narrator and felt slightly sensual / wrong for a
// small robot. Other options to try: alloy (neutral, younger than
// onyx), echo (warm), nova (young female), shimmer (young female).
// tts-1 is the fast/cheap model; tts-1-hd is ~2× quality and cost.
const OPENAI_TTS_MODEL = "tts-1";
const OPENAI_TTS_VOICE = "fable";

// Cancel-on-new state: we pause the in-flight Audio element AND abort
// the in-flight fetch so a new speak() pre-empts cleanly instead of
// queueing audio behind a stale request.
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

// Returns a Promise that resolves when the audio FINISHES playing (or
// errors / is preempted). Callers can await it to schedule the next
// action — no need to estimate TTS duration. Non-awaiting callers get
// fire-and-forget behavior (the Promise is just discarded).
async function speakOpenAI(text, key) {
  cancelOpenAIPlayback();
  if (typeof speechSynthesis !== "undefined") {
    try { speechSynthesis.cancel(); } catch {}
  }

  const controller = new AbortController();
  _currentAbort = controller;

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      input: text,
      response_format: "mp3",
    }),
    signal: controller.signal,
  });
  if (controller.signal.aborted) return;
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI TTS ${res.status}: ${errText.slice(0, 200)}`);
  }

  const blob = await res.blob();
  if (controller.signal.aborted) return;
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  _currentAudio = audio;
  return new Promise((resolve) => {
    const cleanup = () => {
      if (_currentAudio === audio) _currentAudio = null;
      try { URL.revokeObjectURL(url); } catch {}
      resolve();
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;
    // play() returns a Promise that rejects if playback is interrupted
    // (cancelOpenAIPlayback called pause()). That's a normal preempt,
    // not a failure — resolve cleanly in either case.
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
  // Generic name tag — e.g. "English (United Kingdom)+m" (espeak), "...Male" suffixes.
  const maleTagged = (vs) => vs.find(v => /\bmale\b/i.test(v.name) && !/female/i.test(v.name));
  return maleTagged(en) || maleTagged(voices) || en[0] || voices[0] || null;
}

function refreshVoice() {
  if (typeof speechSynthesis === "undefined") return;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;   // Chrome lazy-loads; voiceschanged fires later
  _voice = pickVoice(voices);
  _voiceResolved = true;
}

if (typeof speechSynthesis !== "undefined") {
  refreshVoice();
  // voiceschanged fires once on Chrome after the remote-voice list arrives,
  // and any time the OS voice catalog changes. addEventListener is the
  // standardized hook; older Safari only exposed onvoiceschanged.
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

// Returns a Promise that resolves when the utterance has actually
// finished playing (audio.onended / utterance.onend). Callers that
// don't await get the old fire-and-forget behavior. On any OpenAI
// failure we silently fall back to Web Speech so the demo never goes
// silent.
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

// Diagnostic — exposed on window so the user can audit voice selection
// from DevTools without having to introspect the module.
export function currentVoice() {
  const usingOpenAI = !!settings?.pipOpenaiKey;
  if (usingOpenAI) return { engine: "openai", model: OPENAI_TTS_MODEL, voice: OPENAI_TTS_VOICE };
  return _voice
    ? { engine: "web-speech", name: _voice.name, lang: _voice.lang }
    : { engine: "web-speech", name: null };
}
if (typeof window !== "undefined") window.currentVoice = currentVoice;
