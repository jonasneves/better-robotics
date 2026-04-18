// Voice commands (experimental). webkitSpeechRecognition → intent parser →
// capability dispatches. Grammar is intentionally tiny so we can match with
// case-insensitive string tests instead of building a parser; scales poorly
// past a dozen commands, fits the current verbs. Chrome's speech-to-text
// routes through Google's cloud, which bends the "no network" story — the
// toggle's status line flags that explicitly.
import { $ } from "./dom.js";
import { log } from "./log.js";
import { settings, saveSettings } from "./settings.js";
import { state } from "./state.js";
import { sendMotors } from "./capabilities/motors.js";
import { toggleLed } from "./capabilities/led.js";

let _recognition = null;
let _connectAll = () => {};  // injected by app.js init

function resolveRobotByName(fragment) {
  const norm = (s) => s.toLowerCase().replace(/[\s-]/g, "");
  const needle = norm(fragment);
  return [...state.devices.values()].find(e => norm(e.name).includes(needle))
    || [...state.devices.values()].find(e => norm(e.name).endsWith(needle.slice(-4)));
}

function dispatchVoice(transcript) {
  const t = transcript.toLowerCase().trim();
  log(`voice heard: "${transcript}"`);
  if (/\b(connect all|join all)\b/.test(t)) return _connectAll();
  if (/\b(stop|halt|emergency|e.?stop)\b/.test(t)) {
    for (const e of state.devices.values()) {
      if (e.motorChar && e.status === "connected") sendMotors(e.id, 0, 0);
    }
    return;
  }
  const ledOn = t.match(/\b(l.?e.?d|light)\s+on(?:\s+(\w[\w-]*))?/);
  if (ledOn) {
    const target = ledOn[2] ? resolveRobotByName(ledOn[2]) : null;
    const candidates = target ? [target] : [...state.devices.values()].filter(e => e.ledChar);
    for (const e of candidates) if (!e.ledOn) toggleLed(e.id);
    return;
  }
  const ledOff = t.match(/\b(l.?e.?d|light)\s+off(?:\s+(\w[\w-]*))?/);
  if (ledOff) {
    const target = ledOff[2] ? resolveRobotByName(ledOff[2]) : null;
    const candidates = target ? [target] : [...state.devices.values()].filter(e => e.ledChar);
    for (const e of candidates) if (e.ledOn) toggleLed(e.id);
    return;
  }
  log("voice: no match");
}

function startVoice() {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) { log("Voice unavailable — SpeechRecognition missing"); return; }
  if (_recognition) return;
  _recognition = new Rec();
  _recognition.continuous = true;
  _recognition.interimResults = false;
  _recognition.lang = "en-US";
  _recognition.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) dispatchVoice(e.results[i][0].transcript);
    }
  };
  _recognition.onerror = (e) => log(`voice error: ${e.error}`);
  _recognition.onend = () => {
    // Chrome auto-stops after silence; auto-resume if user still wants it.
    if (_recognition && settings.voice) { try { _recognition.start(); } catch {} }
  };
  try { _recognition.start(); } catch (err) { log(`voice start failed: ${err.message}`); }
  $("voice-btn").classList.add("listening");
}

function stopVoice() {
  if (!_recognition) return;
  _recognition.onend = null;
  try { _recognition.stop(); } catch {}
  _recognition = null;
  $("voice-btn").classList.remove("listening");
}

export function initVoice({ connectAll }) {
  _connectAll = connectAll;
  const voiceCheckbox = $("setting-voice");
  const voiceStatus = $("setting-voice-status");
  const voiceAvailable = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  voiceCheckbox.checked = settings.voice && voiceAvailable;
  voiceStatus.textContent = voiceAvailable
    ? "Commands: connect all · stop · LED on/off <name>. Chrome routes speech-to-text through Google's cloud."
    : "Unavailable — no SpeechRecognition in this browser.";
  if (!voiceAvailable) voiceCheckbox.disabled = true;
  const applyVoice = () => {
    const on = settings.voice && voiceAvailable;
    $("voice-btn").hidden = !on;
    if (!on) stopVoice();
  };
  applyVoice();
  voiceCheckbox.addEventListener("change", () => {
    settings.voice = voiceCheckbox.checked;
    saveSettings();
    applyVoice();
  });
  $("voice-btn").addEventListener("click", () => {
    if (_recognition) stopVoice(); else startVoice();
  });
}
