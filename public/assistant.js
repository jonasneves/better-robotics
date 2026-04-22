import { $ } from "./dom.js";
import { ask, askWithTools } from "./claude.js";
import { TOOLS, executor } from "./pip-tools.js";

// Auto-dismiss timings match Buddy: 10s total show, fade begins at 7s (last 3s).
const SHOW_MS = 10000;
const FADE_MS = 7000;
// Don't spam Pip if the user opens/closes dialogs rapidly.
const MIN_GAP_MS = 15000;
// Keep recent turns for Claude context, but cap so the prompt stays short.
const HISTORY_LIMIT = 12;
// After a conversation turn, wait this long with no activity before the panel
// starts auto-dismissing again. Long enough to read a reply, short enough that
// an abandoned chat doesn't stick forever.
const IDLE_RESUME_MS = 20000;

const PIP_SYSTEM = [
  "You are Pip, a small assistant in a robotics dashboard for ESP32 and Raspberry Pi robots.",
  "",
  "VOICE: terse, specific, concrete — a colleague leaning over the user's shoulder,",
  "not a tour guide. Under 140 chars unprompted, under 200 when answering a question.",
  "",
  "TOOLS: in chat, you can inspect and control the user's robots through tool calls.",
  "When a question depends on real robot state — 'how's the camera bot?', 'why isn't",
  "the Pi advertising?', 'show me its log', 'restart the service' — call the right",
  "tool BEFORE answering. Don't guess robot ids or names; list_robots first if unsure.",
  "If the user references 'the robot' / 'it' and only one is connected, infer it.",
  "If a tool returns { error: ... }, surface it briefly — don't fabricate around it.",
  "",
  "SPATIAL GROUNDING: get_robot_scene and ask_robot_scene produce TEXT — they",
  "describe what's in the frame but not WHERE. Any decision that depends on left/",
  "right/near/far (turning toward a target, aligning on a doorway, judging approach)",
  "MUST use get_robot_detections. Never invent a position from a scene caption —",
  "if the VLM said 'a yellow can on the floor' and you need to know which way to",
  "turn, call get_robot_detections with that query and read cx. If the detector",
  "returns empty for a target you expected, that's a real signal (occluded, out",
  "of frame, or VLM hallucinated it) — don't paper over it by guessing.",
  "",
  "RULES:",
  "- NEVER restate what the panel already shows on screen. The user can read.",
  "- Offer a gotcha, war-story, exact command, or symptom→cause — something they",
  "  wouldn't get from the UI itself.",
  "- Prefer specifics (file paths, service names, flag values) over generalities.",
  "- No emoji, no sign-off, no preamble, no 'great question'.",
  "- If a tip would be generic or obvious, reply with an empty string. Silence beats noise.",
  "- When chatting: if you don't know AND no tool would help, say so in one line.",
].join("\n");

// Dialog id → { context Claude can reason from, fallback when Claude is unreachable }
// The context field is intentionally rich with real codebase gotchas so Claude has
// substrate to say something useful rather than paraphrase the panel label.
const CONTEXTS = {
  "setup-dialog": {
    context: "User is choosing between ESP32 (USB flash in ~30s, no camera) and Pi (camera-capable, longer setup, needs SD prep). Decision usually hinges on whether they want onboard video or heavy compute.",
    fallback: "ESP32 flashes in ~30s if you don't need video. Pi's the path if you want a camera or onboard compute.",
  },
  "prepare-dialog": {
    context: "User is about to stage firmware/runtime onto a Pi SD card. Known gotchas in this codebase: PEP-668 'externally-managed' marker blocks pip installs on recent Pi OS, Spotlight indexing silently stalls SD writes on macOS, rfkill blocks WiFi on fresh Trixie until unblocked.",
    fallback: "If the stage stalls, Spotlight is probably indexing the SD — wait for Finder's indicator to stop.",
  },
  "pinout-modal": {
    context: "User is looking at the Pi 40-pin header. Real-world gotchas: 5V sag under servo load (separate supply + common grounds), I2C needs pull-ups on pins 3/5 or nothing talks, SPI and I2C can't share the same pins, GPIO defaults are input with no pull.",
    fallback: "Servos twitching? Almost always 5V sag — put them on a separate supply and common the grounds.",
  },
  "recovery-modal": {
    context: "USB serial console to a Pi, used when BLE is dead or pi-robot.service has crashed. Typical rescue flow: check `journalctl -u pi-robot -n 50`, reset a stuck wifi (rfkill unblock), kill wedged capture processes.",
    fallback: "First thing to check on a broken Pi: `journalctl -u pi-robot -n 50` — tells you if the service crashed.",
  },
};

let _bubble, _panel, _message, _echo, _input, _form;
let _fadeTimer = null, _closeTimer = null, _resumeTimer = null;
let _lastNotifyAt = 0;
let _pending = false;
const _history = [];

// Two distinct states on the mascot button:
//   .open        — panel is visible; icon lit amber ("attention"). No motion.
//   .responding  — Pip is actively generating a reply; antenna sways +
//                  eye cadence runs. Visible during the await.
// Separating them lets the antenna serve as the typing indicator, so the
// chat bubble doesn't need a "…" placeholder on top of that.
const setPanelOpen  = (on) => _bubble.classList.toggle("open", on);
const setResponding = (on) => _bubble.classList.toggle("responding", on);

function cancelAutoDismiss() {
  if (_fadeTimer)   { clearTimeout(_fadeTimer);   _fadeTimer = null; }
  if (_closeTimer)  { clearTimeout(_closeTimer);  _closeTimer = null; }
  if (_resumeTimer) { clearTimeout(_resumeTimer); _resumeTimer = null; }
  _panel.classList.remove("fading");
}

function scheduleAutoDismiss() {
  cancelAutoDismiss();
  _fadeTimer  = setTimeout(() => _panel.classList.add("fading"), FADE_MS);
  _closeTimer = setTimeout(close, SHOW_MS);
}

function close() {
  cancelAutoDismiss();
  _panel.close();
  setPanelOpen(false);
  setResponding(false);  // cancel any in-flight response indicator on close
}

function open({ autoDismiss = false } = {}) {
  cancelAutoDismiss();
  if (!_panel.open) _panel.show();
  setPanelOpen(true);
  if (autoDismiss) scheduleAutoDismiss();
}

function setEcho(text) {
  if (text) { _echo.textContent = `"${text}"`; _echo.hidden = false; }
  else      { _echo.textContent = "";          _echo.hidden = true;  }
}

// Set the message text and tag it as AI-generated vs static. The
// .ai-generated CSS class tints the text amber so the user can tell
// Claude output apart from hardcoded app copy (intro line, fallback
// replies when Claude is unreachable) — calibrates trust without adding
// UI chrome.
function setMessageText(text, fromAI = false) {
  _message.textContent = text;
  _message.classList.toggle("ai-generated", !!fromAI);
}

// Public API — any module can push a line from Pip. Auto-dismissing is the
// default for spontaneous speech; pass { autoDismiss: false } for sticky ones.
// Pass { fromAI: true } when the text came from a Claude call; defaults to
// static so ad-hoc speakMessage() calls from module code don't falsely
// advertise themselves as AI output.
export function speakMessage(text, { autoDismiss = true, echo = null, fromAI = false } = {}) {
  setEcho(echo);
  setMessageText(text, fromAI);
  _history.push({ role: "assistant", content: text });
  if (_history.length > HISTORY_LIMIT) _history.splice(0, _history.length - HISTORY_LIMIT);
  open({ autoDismiss });
}

async function notify(dialogId) {
  const ctx = CONTEXTS[dialogId];
  if (!ctx) return;
  const now = Date.now();
  if (_panel.open) return;                      // don't interrupt
  if (now - _lastNotifyAt < MIN_GAP_MS) return; // don't spam
  _lastNotifyAt = now;
  const prompt = [
    "The user just opened a dashboard panel.",
    "",
    `Panel context:\n${ctx.context}`,
    "",
    "Reply with ONE specific tip, gotcha, or symptom→cause the user wouldn't learn",
    "by reading this panel. If nothing genuinely useful comes to mind, reply with",
    "an empty string — silence beats narrating what they can see.",
  ].join("\n");
  setResponding(true);
  const reply = await ask(prompt, { system: PIP_SYSTEM });
  setResponding(false);
  if (reply === "") return;                     // Pip chose silence — respect it
  // reply non-null = Claude-generated, reply null = fallback static copy.
  speakMessage(reply ?? ctx.fallback, { fromAI: reply !== null });
}

async function handleSubmit(e) {
  e.preventDefault();
  const text = _input.value.trim();
  if (!text || _pending) return;
  _pending = true;
  _input.disabled = true;
  cancelAutoDismiss();  // user is engaged — don't fade out under them

  _history.push({ role: "user", content: text });
  setEcho(text);
  // No "…" placeholder — the antenna sway (triggered by setResponding below)
  // is the typing indicator. Keep the previous reply visible as context
  // while Pip generates the next one.
  _input.value = "";
  setResponding(true);

  // Build a messages array for Claude from recent history. We pass the running
  // conversation so Pip can follow references ("the pin I mentioned?").
  const messages = _history.slice(-HISTORY_LIMIT)
    .map(m => ({ role: m.role, content: m.content }));
  const reply = await askWithTools(messages, {
    system: PIP_SYSTEM,
    tools: TOOLS,
    executor,
    maxTokens: 1024,
  });
  // In chat, empty means "I don't have anything useful" — surface that instead of silence,
  // since the user directly asked and expects an answer.
  const finalReply = reply === null
    ? "I can't reach my brain right now — try again in a sec?"
    : reply || "I don't have a good answer for that — tell me more?";
  // reply non-null/non-empty = Claude output; either fallback string is static.
  setMessageText(finalReply, reply !== null && reply !== "");
  _history.push({ role: "assistant", content: finalReply });
  if (_history.length > HISTORY_LIMIT) _history.splice(0, _history.length - HISTORY_LIMIT);

  setResponding(false);
  _input.disabled = false;
  _pending = false;
  // Keep the panel around for a beat so the user can read the reply, then fade.
  _resumeTimer = setTimeout(scheduleAutoDismiss, IDLE_RESUME_MS);
}

// Remote-chat entry point: runs the same askWithTools loop used by the on-
// desktop chat input but without touching any local UI. Returns the final
// text Pip wants to show (or a graceful fallback on transport failure).
// Wired from phones.js so paired phones can chat through Pip. Tool side
// effects still run locally on the desktop (where BLE + ai-bridge live);
// any window.confirm() prompts surface on the desktop operator's screen,
// which is intentional for physically-risky actions like restart_service.
export async function handleRemoteChat(text, { source = "phone" } = {}) {
  const t = text?.trim();
  if (!t) return "(empty message)";
  // Keep remote messages in the shared history so desktop context carries
  // through; tag the source so Pip knows the sender isn't local.
  _history.push({ role: "user", content: `[${source}] ${t}` });
  // Desktop mascot animates while the phone's chat is being processed, so
  // the operator at the desktop can see Pip is busy answering a remote user.
  setResponding(true);
  const messages = _history.slice(-HISTORY_LIMIT)
    .map(m => ({ role: m.role, content: m.content }));
  const reply = await askWithTools(messages, {
    system: PIP_SYSTEM,
    tools: TOOLS,
    executor,
    maxTokens: 1024,
  });
  setResponding(false);
  const finalReply = reply === null
    ? "I can't reach my brain right now — try again in a sec?"
    : reply || "I don't have a good answer for that — tell me more?";
  _history.push({ role: "assistant", content: finalReply });
  if (_history.length > HISTORY_LIMIT) _history.splice(0, _history.length - HISTORY_LIMIT);
  return finalReply;
}

// Fire notify() when a dialog's `open` attribute is added. Cheap, and lets other
// modules open dialogs however they want without knowing Pip exists.
function watchDialogs() {
  for (const id of Object.keys(CONTEXTS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    let wasOpen = el.hasAttribute("open");
    new MutationObserver(() => {
      const isOpen = el.hasAttribute("open");
      if (isOpen && !wasOpen) notify(id);
      wasOpen = isOpen;
    }).observe(el, { attributes: true, attributeFilter: ["open"] });
  }
}

export function initAssistant() {
  _bubble  = $("assistant-bubble");
  _panel   = $("assistant-panel");
  _message = $("assistant-message");
  _echo    = $("assistant-echo");
  _input   = $("assistant-input");
  _form    = $("assistant-form");

  // User-initiated open stays until user closes — auto-dismiss only for bot-initiated.
  _bubble.addEventListener("click", () => {
    if (_panel.open) close();
    else { open(); _input.focus(); }
  });
  $("assistant-close").addEventListener("click", close);
  _form.addEventListener("submit", handleSubmit);
  // Typing cancels the auto-dismiss so Pip doesn't vanish mid-thought.
  _input.addEventListener("input", () => { if (_input.value) cancelAutoDismiss(); });
  watchDialogs();
}
