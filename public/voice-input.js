// Browser-native speech-to-text via the Web Speech API
// (SpeechRecognition / webkitSpeechRecognition). Counterpart to voice.js's
// TTS — both are browser-native, no install, no API key. Caveat: Chrome's
// implementation forwards audio to Google's cloud STT under the hood, so
// this is the one path in the dashboard where audio leaves the tab.
// For the strict no-data-leaving variant, swap to transformers.js + Whisper
// (~100MB model, ~500ms–2s latency) — same shape, different backend.
//
// Push-to-talk by design: caller controls start + stop. continuous=true so
// natural pauses don't auto-end the session; interimResults=true so the UI
// can show the live transcript as the user speaks.

const SR = typeof window !== "undefined"
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

export function isSupported() { return !!SR; }

export function startDictation({ onInterim, onFinal, onError, onEnd, lang = "en-US" } = {}) {
  if (!SR) {
    onError?.("not-supported");
    onEnd?.();
    return { stop: () => {} };
  }
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = lang;

  let finalText = "";
  let stopped = false;
  let cancelled = false;

  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    // Caller sees the running concatenation (finalized so far + current
    // interim) — same model used by Gboard/iOS dictation, lets the input
    // field grow smoothly instead of flickering.
    onInterim?.(finalText + interim);
  };

  rec.onerror = (e) => {
    onError?.(e.error || "unknown");
  };

  rec.onend = () => {
    // Chrome can fire onend on idle (~10s silence) even with continuous=true.
    // We surface three reasons so the caller can distinguish them:
    //   "auto"   — natural silence timeout (commit the transcript)
    //   "user"   — caller called stop() to commit (e.g. tapped the mic again)
    //   "cancel" — caller called stop({ cancel: true }) to abort (drop it)
    const reason = cancelled ? "cancel" : stopped ? "user" : "auto";
    if (finalText && reason !== "cancel") onFinal?.(finalText.trim(), { reason });
    onEnd?.({ reason });
  };

  try { rec.start(); }
  catch (err) {
    // start() throws if recognition is already running (rare on PTT but
    // possible if the caller double-clicks the mic button before onend).
    onError?.(`start-failed: ${err.message || err}`);
    onEnd?.({ reason: "error" });
    return { stop: () => {} };
  }

  return {
    stop: ({ cancel = false } = {}) => {
      stopped = true;
      cancelled = !!cancel;
      try { rec.stop(); } catch {}
    },
  };
}
