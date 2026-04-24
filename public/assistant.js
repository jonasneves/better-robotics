import { $ } from "./dom.js";
import { ask, askWithTools } from "./claude.js";
import { TOOLS, executor, setAskInChatHandler } from "./pip-tools.js";
import { renderMd } from "./markdown.js";
import { shorten, labelTool, summarizeTool } from "./format.js";

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
  "SPATIAL REASONING: get_robot_scene and ask_robot_scene produce TEXT — they",
  "describe what's in the frame but not WHERE. You do NOT currently have a",
  "spatial-grounding tool (detector is out of service). When a decision depends",
  "on left/right/near/far, the only honest moves are: (a) make the smallest",
  "exploratory action that is safe to undo (tiny pulse, brief look), then",
  "re-observe, or (b) escalate to ask_human with a directional question.",
  "ask_human routes to a paired phone if available, otherwise renders option",
  "buttons inline in the dashboard chat — works regardless of phone presence.",
  "Never fabricate a position from scene-caption text and commit to a confident",
  "direction — a 'left of center' claim that the VLM didn't make is a",
  "hallucination even when it sounds plausible.",
  "",
  "RULES:",
  "- Prefer specifics (file paths, service names, flag values) over generalities.",
  "- No emoji, no sign-off, no preamble, no 'great question'.",
  "- When chatting: if you don't know AND no tool would help, say so in one line.",
  // Notify-mode behavior (volunteer a gotcha, silence-beats-noise, don't
  // restate panel copy) is carried entirely by notify()'s user prompt.
  // Keeping those directives here too primed chat-mode to append
  // unsolicited tips ('let me also flag the ONNX error...') alongside
  // direct answers — so we remove them from the shared system prompt
  // rather than add a 'don't volunteer advice' negation.
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

let _bubble, _panel, _notify, _turns, _input, _form;
let _fadeTimer = null, _closeTimer = null, _resumeTimer = null;
let _lastNotifyAt = 0;
let _pending = false;
let _abort = false;            // set by Stop button; checked between askWithTools iterations
let _activeTurnEl = null;      // turn currently being filled (live trace destination)
const _history = [];

// Cap the chat-turn stack so the bubble doesn't become a scrolling wall over
// time. Older turns drop entirely from the DOM (still in _history for Claude
// context). Notify slot is separate and never accumulates.
const MAX_CHAT_TURNS = 5;

// One row in a turn's trace list — a tool call.  pendingMs/result/error filled
// in by finishTrace once the call returns.  Kept terse; deeper inspection lives
// in replay.js (IndexedDB) — see CLAUDE.md → Replay.
function appendTraceLine(turnEl, name) {
  let ul = turnEl.querySelector(".pip-trace");
  if (!ul) {
    ul = document.createElement("ul");
    ul.className = "pip-trace";
    // Insert before the reply slot if it exists, otherwise append.
    const reply = turnEl.querySelector(".pip-reply");
    turnEl.insertBefore(ul, reply || null);
  }
  const li = document.createElement("li");
  li.className = "pip-trace-line pending";
  li.textContent = `${labelTool(name)} …`;
  ul.appendChild(li);
  scrollPanelToBottom();
  return li;
}

function finishTraceLine(li, summary, isError) {
  if (!li) return;
  li.classList.remove("pending");
  if (isError) li.classList.add("error");
  li.textContent = summary;
  scrollPanelToBottom();
}

// labelTool / shorten / summarizeTool live in format.js — pure, testable,
// imported above. Single source of truth for trace-line formatting.

function scrollPanelToBottom() {
  if (_panel) _panel.scrollTop = _panel.scrollHeight;
}

// In-bubble ask primitive — renders a question + option buttons (or a
// free-text input when options is empty) into the active turn, awaits a
// click/submit, removes the block. Returns the answer string. Also used by
// the Continue/Stop affordance when askWithTools hits its iteration budget.
function askInChat({ question, options = [] }) {
  return new Promise((resolve) => {
    const turnEl = _activeTurnEl || _turns.lastElementChild;
    if (!turnEl) { resolve(null); return; }

    const block = document.createElement("div");
    block.className = "pip-ask";

    const q = document.createElement("div");
    q.className = "pip-ask-q";
    q.textContent = question;
    block.appendChild(q);

    const finalize = (answer) => { block.remove(); resolve(answer); };

    if (options.length > 0) {
      const row = document.createElement("div");
      row.className = "pip-ask-options";
      for (const opt of options) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "secondary sm";
        btn.textContent = opt;
        btn.addEventListener("click", () => finalize(opt));
        row.appendChild(btn);
      }
      block.appendChild(row);
    } else {
      const form = document.createElement("form");
      form.className = "pip-ask-form";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "pip-ask-input";
      input.placeholder = "Your answer…";
      const send = document.createElement("button");
      send.type = "submit";
      send.className = "sm";
      send.textContent = "Send";
      form.appendChild(input);
      form.appendChild(send);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (v) finalize(v);
      });
      block.appendChild(form);
      // Defer focus so the dialog has finished its render.
      setTimeout(() => input.focus(), 0);
    }

    // Insert above the reply slot so it sits below the trace.
    const reply = turnEl.querySelector(".pip-reply");
    turnEl.insertBefore(block, reply || null);
    scrollPanelToBottom();
  });
}

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
  if (_panel.matches(":popover-open")) _panel.hidePopover();
  setPanelOpen(false);
  setResponding(false);  // cancel any in-flight response indicator on close
}

function open({ autoDismiss = false } = {}) {
  cancelAutoDismiss();
  if (!_panel.matches(":popover-open")) _panel.showPopover();
  setPanelOpen(true);
  if (autoDismiss) scheduleAutoDismiss();
}

// Collapse every previously-completed turn so only the current/active one is
// expanded. NON-DESTRUCTIVE: wraps existing children in .pip-turn-full and
// appends a .pip-turn-summary sibling — both stay in the DOM, CSS toggles
// which is visible. Click the summary to re-expand the original content
// (echo + trace + reply intact, including any tool-call detail).
function collapsePreviousTurns() {
  const turns = _turns.querySelectorAll(".pip-turn:not(.collapsed)");
  for (const t of turns) {
    if (t === _activeTurnEl) continue;
    if (!t.querySelector(".pip-reply")) continue;  // turn has no reply yet — skip
    if (!t.querySelector(".pip-turn-summary")) {
      const echo = t.querySelector(".pip-echo")?.textContent?.trim() || "";
      const replyText = t.querySelector(".pip-reply")?.textContent?.trim() || "";
      const traceCount = t.querySelectorAll(".pip-trace-line").length;
      const summary = echo
        ? `${shorten(echo, 50)}${traceCount ? ` · ${traceCount} action${traceCount === 1 ? "" : "s"}` : ""}`
        : shorten(replyText, 70);
      const sumBtn = document.createElement("button");
      sumBtn.type = "button";
      sumBtn.className = "pip-turn-summary";
      sumBtn.textContent = `▸ ${summary}`;
      const full = document.createElement("div");
      full.className = "pip-turn-full";
      while (t.firstChild) full.appendChild(t.firstChild);
      t.appendChild(sumBtn);
      t.appendChild(full);
    }
    t.classList.add("collapsed");
  }
  // Cap the stack — drop oldest beyond the limit. They stay in _history for
  // Claude context, just not in the DOM.
  while (_turns.children.length > MAX_CHAT_TURNS) _turns.removeChild(_turns.firstChild);
}

// Build a fresh turn DOM for a new user prompt, append it, set as active.
// reply slot is created upfront so live trace can insertBefore() it cleanly.
function startNewTurn({ echo = null } = {}) {
  collapsePreviousTurns();
  const t = document.createElement("div");
  t.className = "pip-turn active";
  if (echo) {
    const e = document.createElement("div");
    e.className = "pip-echo";
    e.textContent = `"${echo}"`;
    t.appendChild(e);
  }
  // Reply slot is created empty; trace lines insertBefore it; setReplyText
  // populates it once Claude's final text arrives.
  const reply = document.createElement("div");
  reply.className = "pip-reply";
  t.appendChild(reply);
  _turns.appendChild(t);
  _activeTurnEl = t;
  scrollPanelToBottom();
  return t;
}

function setReplyText(turnEl, text, fromAI = false) {
  const reply = turnEl.querySelector(".pip-reply");
  if (!reply) return;
  if (fromAI) reply.innerHTML = renderMd(text);
  else        reply.textContent = text;
  reply.classList.toggle("ai-generated", !!fromAI);
  scrollPanelToBottom();
}

// Stop button rendered into the active turn while askWithTools is iterating.
// Click sets the abort flag the loop polls between iterations; current
// in-flight tool call still completes (firmware safety floor caps blast
// radius — see .claude/CLAUDE.md → Control-loop invariants).
function attachStopButton(turnEl) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary sm pip-stop";
  btn.textContent = "Stop";
  btn.addEventListener("click", () => {
    _abort = true;
    btn.disabled = true;
    btn.textContent = "Stopping…";
  });
  // Insert just before the reply slot so it sits at the bottom of the trace.
  const reply = turnEl.querySelector(".pip-reply");
  turnEl.insertBefore(btn, reply || null);
  return btn;
}

// Public API — Pip volunteering context (proactive tips, greetings, app voice).
// Writes to the ambient notify slot at the top of the bubble, replacing whatever
// was there. Distinct from chat turns, which live in their own stack below: notify
// is "hey, I noticed X" and doesn't accumulate as history.  `echo` is accepted but
// ignored (notify isn't a reply to a user prompt; nothing to quote).
export function speakMessage(text, { autoDismiss = true, fromAI = false } = {}) {
  if (!_notify) return;
  if (fromAI) _notify.innerHTML = renderMd(text);
  else        _notify.textContent = text;
  _notify.classList.toggle("ai-generated", !!fromAI);
  _notify.hidden = false;
  _history.push({ role: "assistant", content: text });
  if (_history.length > HISTORY_LIMIT) _history.splice(0, _history.length - HISTORY_LIMIT);
  open({ autoDismiss });
}

async function notify(dialogId) {
  const ctx = CONTEXTS[dialogId];
  if (!ctx) return;
  const now = Date.now();
  if (_panel.matches(":popover-open")) return;  // don't interrupt
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
  // Proactive notify tips are app voice even when Claude generated them —
  // user didn't ask anything, this is Pip volunteering context on the side.
  // Only chat replies get the amber 'live reply' tint (see setReplyText).
  speakMessage(reply ?? ctx.fallback);
}

async function handleSubmit(e) {
  e.preventDefault();
  const text = _input.value.trim();
  if (!text || _pending) return;
  _pending = true;
  _abort = false;
  _input.disabled = true;
  cancelAutoDismiss();  // user is engaged — don't fade out under them

  _history.push({ role: "user", content: text });
  // Open the new turn FIRST — collapsing prior turns and clearing the active
  // visual context happens before Claude is even contacted, so there's no
  // moment where the old reply sits next to the new prompt.
  const turnEl = startNewTurn({ echo: text });
  const stopBtn = attachStopButton(turnEl);
  _input.value = "";
  setResponding(true);

  let pendingTraceLi = null;

  const messages = _history.slice(-HISTORY_LIMIT)
    .map(m => ({ role: m.role, content: m.content }));
  const reply = await askWithTools(messages, {
    system: PIP_SYSTEM,
    tools: TOOLS,
    executor,
    maxTokens: 1024,
    onToolStart: ({ name }) => { pendingTraceLi = appendTraceLine(turnEl, name); },
    onToolEnd: ({ name, input, result, error }) => {
      finishTraceLine(pendingTraceLi, summarizeTool(name, input, result, error), !!error);
      pendingTraceLi = null;
    },
    shouldAbort: () => _abort,
    // Hit the budget? Ask the user instead of slamming into the wall — same
    // primitive ask_human uses (renders Continue/Stop buttons inline).
    onMaxIterations: async () => {
      const choice = await askInChat({
        question: "Pip's worked through several steps without finishing. Continue?",
        options: ["Continue", "Stop"],
      });
      return choice === "Continue" ? 5 : 0;
    },
  });

  stopBtn.remove();
  // In chat, empty means "I don't have anything useful" — surface that instead of silence,
  // since the user directly asked and expects an answer.
  const finalReply = reply === null
    ? "I can't reach my brain right now — try again in a sec?"
    : reply || "I don't have a good answer for that — tell me more?";
  // reply non-null/non-empty = Claude output; either fallback string is static.
  setReplyText(turnEl, finalReply, reply !== null && reply !== "");
  _history.push({ role: "assistant", content: finalReply });
  if (_history.length > HISTORY_LIMIT) _history.splice(0, _history.length - HISTORY_LIMIT);

  _activeTurnEl = null;
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

// Re-enter the top layer as the most-recently-shown popover so the bubble +
// panel sit above a modal dialog that just joined the top layer. hide+show
// in the same task avoids a visible flicker. Order matters: panel last so
// it stacks above the bubble.
function rehoistPip() {
  if (_bubble?.matches(":popover-open")) {
    _bubble.hidePopover();
    _bubble.showPopover();
  }
  if (_panel?.matches(":popover-open")) {
    _panel.hidePopover();
    _panel.showPopover();
  }
}

// Fire notify() for dialogs with Pip context, and rehoist the bubble on any
// dialog opening so it stays reachable above modal content. Single observer
// per dialog; other modules don't need to know Pip exists.
function watchDialogs() {
  const contextual = new Set(Object.keys(CONTEXTS));
  for (const dlg of document.querySelectorAll("dialog")) {
    let wasOpen = dlg.hasAttribute("open");
    new MutationObserver(() => {
      const isOpen = dlg.hasAttribute("open");
      if (isOpen && !wasOpen) {
        if (contextual.has(dlg.id)) notify(dlg.id);
        rehoistPip();
      }
      wasOpen = isOpen;
    }).observe(dlg, { attributes: true, attributeFilter: ["open"] });
  }
}

export function initAssistant() {
  _bubble  = $("assistant-bubble");
  _panel   = $("assistant-panel");
  _notify  = $("assistant-notify");
  _turns   = $("assistant-turns");
  _input   = $("assistant-input");
  _form    = $("assistant-form");

  // User-initiated open stays until user closes — auto-dismiss only for bot-initiated.
  _bubble.addEventListener("click", () => {
    if (_panel.matches(":popover-open")) close();
    else { open(); _input.focus(); }
  });
  $("assistant-close").addEventListener("click", close);
  _form.addEventListener("submit", handleSubmit);
  // Inject the chat-bubble ask handler so pip-tools' ask_human can render
  // option buttons / free-text input inline in the active turn.
  setAskInChatHandler(askInChat);
  // Typing cancels the auto-dismiss so Pip doesn't vanish mid-thought.
  _input.addEventListener("input", () => { if (_input.value) cancelAutoDismiss(); });
  // Click a collapsed turn's summary line to re-expand it. Collapse is now
  // non-destructive (full DOM hidden via CSS), so expansion restores the
  // original echo + trace + reply intact.
  _turns.addEventListener("click", (e) => {
    const sum = e.target.closest(".pip-turn-summary");
    if (!sum) return;
    sum.closest(".pip-turn")?.classList.toggle("collapsed");
  });
  watchDialogs();
  // Hoist the bubble into the top layer so it floats above any modal dialog
  // — user can ask Pip proactively about what they're currently looking at.
  _bubble.showPopover();
}
