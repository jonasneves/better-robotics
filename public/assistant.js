import { ask, askWithTools } from "./claude.js";
import { getTools, executor, setAskInChatHandler } from "./pip-tools.js";
import { shorten, labelTool, summarizeTool } from "./format.js";
import { settings, saveSettings } from "./settings.js";
import { createPip, renderMd } from "https://cdn.jsdelivr.net/npm/@jonasneves/pip@1.7.1/pip-core.esm.js";

// Match Buddy: 10s total show, fade at 7s (last 3s).
const SHOW_MS = 10000;
const FADE_MS = 7000;
const MIN_GAP_MS = 15000;
const HISTORY_LIMIT = 12;
// Inactivity after a turn before auto-dismiss resumes. Long enough to
// read a reply, short enough that an abandoned chat doesn't stick.
const IDLE_RESUME_MS = 20000;

// Rules the executor mechanically enforces (3-pulse stop, pulse duration
// cap, signed-pair clamp) live in pip-tools.js — Pip can't violate them,
// so restating in the prompt is token rent. System prompt carries voice +
// reasoning policy ONLY: choices the model makes where the executor can't.
const PIP_SYSTEM = [
  "You are Pip, a small assistant in a robotics dashboard for ESP32 and Raspberry Pi robots.",
  "",
  "VOICE: terse, specific, concrete — a colleague leaning over the user's shoulder,",
  "not a tour guide. Under 140 chars unprompted, under 200 when answering a question.",
  "No emoji, no sign-off, no preamble, no 'great question'. Prefer specifics",
  "(file paths, service names, flag values) over generalities.",
  "",
  "TOOLS: when a question depends on real robot state, call the right tool",
  "BEFORE answering. Don't guess robot ids or names; list_robots first if unsure.",
  "If the user references 'the robot' / 'it' and only one is connected, infer it.",
  "If a tool returns { error: ... }, surface it briefly — don't fabricate around it.",
  "",
  "SPATIAL REASONING: get_robot_scene / ask_robot_scene produce TEXT (what's in",
  "the frame, not WHERE). get_robot_detections returns bounding boxes and is",
  "the only reliable source of left/right/near/far. If a motor move depends on",
  "spatial position and no detector is available, call ask_human FIRST — never",
  "infer position from caption text. If two scene queries contradict each other",
  "about the target, ask_human — you don't know. ask_human routes to a paired",
  "phone if available, otherwise renders inline option buttons.",
  "",
  "VISION: if view_robot_frame is in your tool list, use it as the FIRST choice",
  "for fine visual-detail questions — colors, counts, readable text, condition",
  "('is it dirty', 'any scratches'). One look beats 3 ask_robot_scene follow-ups.",
  "get_robot_scene covers ambient 'what's there'; view_robot_frame covers 'what",
  "specifically'. Spatial still prefers get_robot_detections.",
  "",
  "When chatting: if you don't know AND no tool would help, say so in one line.",
  "Stay warm and curious. Off-topic asks (poems, jokes, small talk) — answer",
  "briefly in character. No scope-policing or capping ('that's the last one',",
  "'ask me something useful', 'not my thing').",
].join("\n");

// Single source of truth for "Hi, I'm Pip" — used by dashboard panel +
// phone Pip accordion so voice doesn't drift across surfaces.
export const PIP_INTRO = "Hi — I'm Pip. Ask me anything, or I'll pipe up when there's something worth knowing.";

let _pip = null;
let _fadeTimer = null, _closeTimer = null, _resumeTimer = null;
let _lastNotifyAt = 0;
let _abort = false;
let _activeTurnEl = null;

function cancelAutoDismiss() {
  if (_fadeTimer)   { clearTimeout(_fadeTimer);   _fadeTimer = null; }
  if (_closeTimer)  { clearTimeout(_closeTimer);  _closeTimer = null; }
  if (_resumeTimer) { clearTimeout(_resumeTimer); _resumeTimer = null; }
  _pip.panel.classList.remove("fading");
}

function scheduleAutoDismiss() {
  cancelAutoDismiss();
  _fadeTimer  = setTimeout(() => _pip.panel.classList.add("fading"), FADE_MS);
  _closeTimer = setTimeout(() => _pip.close(), SHOW_MS);
}

// Trace row, one per tool_use. .pending in flight, .error on tool error.
// finishTraceLine fills pendingMs/result/error. Deeper inspection in
// replay.js (IndexedDB).
function appendTraceLine(turnEl, name) {
  let ul = turnEl.querySelector(".pip-trace");
  if (!ul) {
    ul = document.createElement("ul");
    ul.className = "pip-trace";
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

function scrollPanelToBottom() {
  _pip.scroll.scrollTop = _pip.scroll.scrollHeight;
}

// Stop button while askWithTools iterates. Click sets abort flag the loop
// polls between iterations; current in-flight tool call still completes
// (firmware safety floor caps blast radius — .claude/CLAUDE.md → Control-loop invariants).
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
  const reply = turnEl.querySelector(".pip-reply");
  turnEl.insertBefore(btn, reply || null);
  return btn;
}

// Writes the ambient notify slot. Distinct from chat turns — notify is
// "hey, I noticed X" and doesn't accumulate as history.
export function speakMessage(text, { autoDismiss = true, fromAI = false } = {}) {
  if (!_pip) return;
  _pip.speak(text, { fromAI });
  _pip.history.push({ role: "assistant", content: text });
  if (_pip.history.length > HISTORY_LIMIT) _pip.history.splice(0, _pip.history.length - HISTORY_LIMIT);
  cancelAutoDismiss();
  if (autoDismiss) scheduleAutoDismiss();
}

const PIP_EVENT_TEMPLATES = {
  "robot.disconnected": ({ name }) =>
    `${name || "Robot"} just disconnected. Want me to look at the log?`,
  "robot.service_crashed": ({ name }) =>
    `Heads up — pi-robot.service went inactive on ${name || "the robot"}. The board is still reachable on wifi, but capabilities are offline until it restarts.`,
};
const PIP_EVENT_THROTTLE_MS = 60_000;
const _lastPipEmit = new Map();
export function emitPipEvent(name, data = {}) {
  if (_pip?.isPending()) return;
  const template = PIP_EVENT_TEMPLATES[name];
  if (!template) return;
  const key = `${name}:${data.id || data.name || ""}`;
  const now = Date.now();
  if (now - (_lastPipEmit.get(key) || 0) < PIP_EVENT_THROTTLE_MS) return;
  _lastPipEmit.set(key, now);
  const text = template(data);
  if (text) speakMessage(text, { autoDismiss: true });
}

async function notifyDialog(dialogEl) {
  const context = dialogEl.dataset.pipContext;
  if (!context) return;
  const fallback = dialogEl.dataset.pipFallback;
  const now = Date.now();
  if (_pip.isOpen()) return;
  if (now - _lastNotifyAt < MIN_GAP_MS) return;
  _lastNotifyAt = now;
  const prompt = [
    "The user just opened a dashboard panel.",
    "",
    `Panel context:\n${context}`,
    "",
    "Reply with ONE specific tip, gotcha, or symptom→cause the user wouldn't learn",
    "by reading this panel. If nothing genuinely useful comes to mind, reply with",
    "an empty string — silence beats narrating what they can see.",
  ].join("\n");
  _pip.setResponding(true);
  const reply = await ask(prompt, { system: PIP_SYSTEM });
  _pip.setResponding(false);
  if (reply === "") return;
  // Proactive notify tips are app voice even when Claude generated them — user
  // didn't ask anything, so no amber "live reply" tint (that's reserved for
  // direct answers to user questions).
  speakMessage(reply ?? fallback);
}

// Host onSubmit — runs askWithTools with trace + stop + max-iter continue/stop.
async function onSubmit(text, { turnEl }) {
  _activeTurnEl = turnEl;
  _abort = false;
  cancelAutoDismiss();
  const stopBtn = attachStopButton(turnEl);

  let pendingTraceLi = null;
  const messages = _pip.history.slice(-HISTORY_LIMIT)
    .map(m => ({ role: m.role, content: m.content }));
  const reply = await askWithTools(messages, {
    system: PIP_SYSTEM,
    tools: getTools(),
    executor,
    maxTokens: 1024,
    onToolStart: ({ name }) => { pendingTraceLi = appendTraceLine(turnEl, name); },
    onToolEnd: ({ name, input, result, error }) => {
      finishTraceLine(pendingTraceLi, summarizeTool(name, input, result, error), !!error);
      pendingTraceLi = null;
    },
    shouldAbort: () => _abort,
    onMaxIterations: async () => {
      const choice = await _pip.askInChat({
        question: "Pip's worked through several steps without finishing. Continue?",
        options: ["Continue", "Stop"],
      }, turnEl);
      return choice === "Continue" ? 5 : 0;
    },
  });
  stopBtn.remove();
  _activeTurnEl = null;
  _resumeTimer = setTimeout(scheduleAutoDismiss, IDLE_RESUME_MS);
  return reply;
}

// Re-enter the top layer so bubble+panel stack above a modal dialog that
// just joined the top layer. hide+show in the same task avoids a visible
// flicker. Order matters: panel last so it stacks above the bubble.
function rehoistPip() {
  if (_pip?.bubble.matches(":popover-open")) {
    _pip.bubble.hidePopover();
    _pip.bubble.showPopover();
  }
  if (_pip?.panel.matches(":popover-open")) {
    _pip.panel.hidePopover();
    _pip.panel.showPopover();
  }
}

// Slash commands registered on the pip handle. /clear and /help ship as
// pip-core built-ins (v1.7.0+); these are the dashboard-specific ones.
const PIP_BACKENDS = ["github", "bridge", "anthropic", "openai", "local"];

function registerInitialSlashCommands() {
  _pip.registerSlash({
    name: "connect",
    description: "open the BLE chooser to pair a robot",
    // Synthetic click on the scan button — keeps requestDevice's user-
    // activation chain (Enter keypress → click event) intact across browsers
    // without re-implementing the chooser flow here.
    handler: () => {
      const btn = document.getElementById("scan-btn");
      if (!btn) return { reply: "Pairing button isn't on this page." };
      btn.click();
      return { reply: "Opened the BLE chooser." };
    },
  });

  _pip.registerSlash({
    name: "model",
    description: "switch Pip's backend (github/bridge/anthropic/openai/local)",
    complete: (partial) => PIP_BACKENDS.filter(b => b.startsWith(partial.toLowerCase())),
    handler: (argsString) => {
      const arg = argsString.trim().toLowerCase();
      if (!arg) return { reply: `Current backend: \`${settings.pipBackend}\`` };
      if (!PIP_BACKENDS.includes(arg)) {
        return { reply: `Unknown backend \`${arg}\`. One of: ${PIP_BACKENDS.map(b => `\`${b}\``).join(", ")}` };
      }
      const KEY = "better-robotics:settings";
      const before = settings.pipBackend;
      const beforeRaw = localStorage.getItem(KEY);

      // 1. Mutate the in-memory settings object (live binding shared with claude.js).
      settings.pipBackend = arg;

      // 2. Try the canonical saveSettings path.
      let saveErr = null;
      try { saveSettings(); }
      catch (e) { saveErr = e.message || String(e); }

      // 3. If saveSettings didn't land the change, write localStorage directly
      //    using the same JSON shape settings.js expects.
      let directWriteErr = null;
      const afterFirst = JSON.parse(localStorage.getItem(KEY) || "{}").pipBackend;
      if (afterFirst !== arg) {
        try {
          const merged = { ...JSON.parse(beforeRaw || "{}"), ...settings };
          localStorage.setItem(KEY, JSON.stringify(merged));
        } catch (e) { directWriteErr = e.message || String(e); }
      }

      // 4. Sync the Settings UI dropdown.
      const sel = document.getElementById("setting-pip-backend");
      if (sel && sel.value !== arg) {
        sel.value = arg;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }

      const finalRaw = localStorage.getItem(KEY);
      const finalBackend = JSON.parse(finalRaw || "{}").pipBackend;
      const lines = [
        `**/model ${arg}** — diagnostic:`,
        `- before: in-memory=\`${before}\`, localStorage.pipBackend=\`${JSON.parse(beforeRaw || "{}").pipBackend ?? "(absent)"}\``,
        `- saveSettings(): ${saveErr ? `THREW \`${saveErr}\`` : "ok"}`,
        `- after saveSettings: localStorage.pipBackend=\`${afterFirst ?? "(absent)"}\``,
        directWriteErr ? `- direct write: THREW \`${directWriteErr}\`` : (afterFirst !== arg ? `- direct write: attempted` : `- direct write: skipped (already landed)`),
        `- final: in-memory=\`${settings.pipBackend}\`, localStorage.pipBackend=\`${finalBackend ?? "(absent)"}\`, dropdown=\`${sel?.value ?? "(no dropdown)"}\``,
        `- localStorage raw len: ${finalRaw?.length ?? 0} chars`,
      ];
      return { reply: lines.join("\n") };
    },
  });
}

function watchDialogs() {
  for (const dlg of document.querySelectorAll("dialog")) {
    let wasOpen = dlg.hasAttribute("open");
    new MutationObserver(() => {
      const isOpen = dlg.hasAttribute("open");
      if (isOpen && !wasOpen) {
        if (dlg.dataset.pipContext) notifyDialog(dlg);
        rehoistPip();
      }
      wasOpen = isOpen;
    }).observe(dlg, { attributes: true, attributeFilter: ["open"] });
  }
}

export function initAssistant() {
  // Intro fires once per install; subsequent loads stay silent at idle.
  const seenKey = "better-robotics:pip-intro-seen";
  const showIntro = !localStorage.getItem(seenKey);
  _pip = createPip({
    container: document.body,
    ask,
    onSubmit,
    systemPrompt: PIP_SYSTEM,
    historyLimit: HISTORY_LIMIT,
    introText: showIntro ? PIP_INTRO : "",
    introDismissMs: 7000,
    placeholder: "Ask Pip…",
    maxLength: 4000,
    onOpen: cancelAutoDismiss,
  });
  registerInitialSlashCommands();
  if (showIntro) { try { localStorage.setItem(seenKey, "1"); } catch {} }
  // Typing cancels auto-dismiss so Pip doesn't vanish mid-thought.
  _pip.input.addEventListener("input", () => { if (_pip.input.value) cancelAutoDismiss(); });
  // Inject in-chat ask handler so pip-tools' ask_human can render option
  // buttons / free-text input inline in the active turn.
  setAskInChatHandler(({ question, options }) =>
    _pip.askInChat({ question, options }, _activeTurnEl));
  watchDialogs();
}
