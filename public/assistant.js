import { ask, askWithTools, activeModelForBackend } from "./claude.js";
import { getTools, executor, setAskInChatHandler } from "./pip-tools.js";
import { shorten, labelTool, summarizeTool } from "./format.js";
import { settings, saveSettings } from "./settings.js";
import { AUTH_URL } from "./endpoints.js";
import { createPip, renderMd } from "https://cdn.jsdelivr.net/npm/@jonasneves/pip@2.9.5/pip-core.esm.js";

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
// Send + stop buttons live in pip-core 2.1.0+; we just toggle responding
// state and provide an onAbort callback below.

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

// Lazy GitHub OAuth helper — shared between /model handler and the
// failure-recovery flow. Module-scope so both code paths reach it.
let _connectGitHubFn = null;
async function _loadConnectGitHub() {
  if (_connectGitHubFn) return _connectGitHubFn;
  const mod = await import(`${AUTH_URL}/connect.js`);
  _connectGitHubFn = mod.connectGitHub;
  return _connectGitHubFn;
}

// Bridge / local failure copy. github / anthropic / openai use the
// inline-button + main-input recovery path in actOnFailure, so they
// don't need text hints anymore.
function backendFailureHint(backend) {
  const hints = {
    bridge:
      "ai-bridge isn't responding. Check the local service is running, or `/model` to switch backends.",
    local:
      "Local LFM2 isn't loaded. `/install local` to download the model (~1.2 GB, one time), or `/model` to switch.",
  };
  return hints[backend] || "Can't think right now — try again?";
}

// When the backend returns null/empty, the failure copy already names a
// likely cause and a specific action. Surface that action as an inline
// button (sign-in) or repurpose the main input (key paste) rather than
// asking the user to type a slash command. Same input the user's already
// looking at — no browser modal, no fragmentation.
async function actOnFailure(backend, turnEl) {
  if (backend === "github") {
    const choice = await _pip.askInChat({
      question: "GitHub Models needs sign-in (or token expired).",
      options: ["Sign in", "Switch backend"],
    }, turnEl);
    if (choice === "Sign in") {
      try {
        const connect = await _loadConnectGitHub();
        const auth = await connect("read:user", "better-robotics");
        settings.githubAuth = { username: auth.username, token: auth.token };
        saveSettings();
        window.__syncIdentityUI?.();
        return `Signed in as \`@${auth.username}\`. Try sending again.`;
      } catch (err) {
        return `Sign-in failed: ${err.message || err}`;
      }
    }
    return "Run `/model` to pick a different backend.";
  }
  if (backend === "anthropic" || backend === "openai") {
    const isAnthropic = backend === "anthropic";
    const label = isAnthropic ? "Anthropic" : "OpenAI";
    const format = isAnthropic ? "sk-ant-…" : "sk-…";
    const has = isAnthropic ? !!settings.pipApiKey : !!settings.pipOpenaiKey;
    const question = has
      ? `${label} call failed — key may be invalid or out of quota.`
      : `${label} needs an API key.`;
    const choice = await _pip.askInChat({
      question,
      options: [has ? "Re-enter key" : "Enter key", "Switch backend"],
    }, turnEl);
    if (choice === "Enter key" || choice === "Re-enter key") {
      const key = await _pip.collectSecret({ label: `${label} API key`, format });
      if (!key) return "Cancelled.";
      if (isAnthropic) settings.pipApiKey = key;
      else settings.pipOpenaiKey = key;
      saveSettings();
      return "Key saved. Try sending again.";
    }
    return "Run `/model` to pick a different backend.";
  }
  return backendFailureHint(backend);
}

// Host onSubmit — runs askWithTools with trace + stop + max-iter continue/stop.
async function onSubmit(text, { turnEl }) {
  _activeTurnEl = turnEl;
  _abort = false;
  cancelAutoDismiss();
  // pip-core auto-toggles responding state around onSubmit, which morphs
  // the right-edge slot (send → stop). Just clear the abort flag here.

  let pendingTraceLi = null;
  const messages = _pip.history.slice(-HISTORY_LIMIT)
    .map(m => ({ role: m.role, content: m.content }));
  const reply = await askWithTools(messages, {
    system: PIP_SYSTEM,
    tools: getTools(),
    executor,
    maxTokens: 1024,
    turnEl,                  // local-llm uses this to paint download progress on first load
    onToolStart: ({ name }) => { pendingTraceLi = appendTraceLine(turnEl, name); },
    onToolEnd: ({ name, input, result, error, durationMs }) => {
      finishTraceLine(pendingTraceLi, summarizeTool(name, input, result, error, durationMs), !!error);
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
  _activeTurnEl = null;
  _resumeTimer = setTimeout(scheduleAutoDismiss, IDLE_RESUME_MS);
  // Backend returned nothing usable → surface an actionable recovery
  // (button or repurposed main input) instead of pip-core's generic
  // "try again." See actOnFailure: github → Sign in button; anthropic/
  // openai → main input becomes the key-paste field; bridge/local fall
  // back to text hints.
  if (reply == null || reply === "") return actOnFailure(settings.pipBackend, turnEl);
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
    name: "scan",
    description: "open the BLE chooser to pair a robot",
    // Synthetic click on the scan button — keeps requestDevice's user-
    // activation chain (Enter keypress → click event) intact across browsers
    // without re-implementing the chooser flow here.
    handler: () => {
      const btn = document.getElementById("scan-btn");
      if (!btn) return { reply: "Scan button isn't on this page." };
      btn.click();
      return { reply: "Opened the BLE chooser." };
    },
  });

  // /model handles both *switching* the backend and *setting it up* if the
  // chosen one needs auth or a key. One slash, one mental model: pick a
  // backend, the rest happens inline. Key entry repurposes Pip's main
  // input via _pip.collectSecret — same input the user's already looking at.
  _pip.registerSlash({
    name: "model",
    description: "switch Pip's backend (github/bridge/anthropic/openai/local)",
    complete: (partial) => PIP_BACKENDS.filter(b => b.startsWith(partial.toLowerCase())),
    handler: async (argsString) => {
      const arg = argsString.trim().toLowerCase();
      if (!arg) {
        const others = PIP_BACKENDS.filter(b => b !== settings.pipBackend);
        return {
          reply: `Current backend: \`${settings.pipBackend}\`. Switch with \`/model <name>\` — try ${others.map(b => `\`${b}\``).join(", ")}.`,
        };
      }
      if (!PIP_BACKENDS.includes(arg)) {
        return { reply: `Unknown backend \`${arg}\`. One of: ${PIP_BACKENDS.map(b => `\`${b}\``).join(", ")}` };
      }

      // Contextual setup: backends that need auth/keys get prompted inline
      // before we commit the switch. Cancellation leaves the existing
      // backend selection untouched. Re-running `/model <current>` is the
      // documented re-auth / re-key path, so we re-prompt even when the
      // credential already exists.
      const isReSetup = arg === settings.pipBackend;
      if (arg === "github" && (!settings.githubAuth?.username || isReSetup)) {
        try {
          const connect = await _loadConnectGitHub();
          const auth = await connect("read:user", "better-robotics");
          settings.githubAuth = { username: auth.username, token: auth.token };
          window.__syncIdentityUI?.();
        } catch (err) {
          return { reply: `Sign-in failed: ${err.message || err}` };
        }
      }
      if (arg === "anthropic" && (!settings.pipApiKey || isReSetup)) {
        const key = await _pip.collectSecret({ label: "Anthropic API key", format: "sk-ant-…" });
        if (!key) return { reply: "Cancelled — Anthropic needs an API key. Run `/model anthropic` to try again." };
        settings.pipApiKey = key;
      }
      if (arg === "openai" && (!settings.pipOpenaiKey || isReSetup)) {
        const key = await _pip.collectSecret({ label: "OpenAI API key", format: "sk-…" });
        if (!key) return { reply: "Cancelled — OpenAI needs an API key. Run `/model openai` to try again." };
        settings.pipOpenaiKey = key;
      }

      const KEY = "better-robotics:settings";
      const beforeRaw = localStorage.getItem(KEY);

      // Mutate the live binding shared with claude.js, then save.
      settings.pipBackend = arg;
      try { saveSettings(); } catch {}

      // Direct-write fallback if saveSettings didn't land — kept as cheap
      // insurance in case the canonical path silently no-ops.
      const after = JSON.parse(localStorage.getItem(KEY) || "{}").pipBackend;
      if (after !== arg) {
        try {
          const merged = { ...JSON.parse(beforeRaw || "{}"), ...settings };
          localStorage.setItem(KEY, JSON.stringify(merged));
        } catch {}
      }

      _pip.setModelLabel?.(activeModelForBackend(arg));

      // Local LFM2 still needs a separate install step (large download).
      const extra = arg === "local" && !settings.pipLocalInstalled
        ? " `/install local` to download the model (~1.2 GB, one time)."
        : "";
      return { reply: `Backend set to \`${arg}\`.${extra}` };
    },
  });

  // /vision on|off — toggle whether Pip can see camera frames directly.
  // Tool wires the Anthropic image-in-tool_result content shape; only the
  // bridge + anthropic backends ship the right content-block packing.
  _pip.registerSlash({
    name: "vision",
    description: "let Pip see camera frames directly (on/off)",
    complete: (partial) => ["on", "off"].filter(s => s.startsWith(partial.toLowerCase())),
    handler: (argsString) => {
      const arg = argsString.trim().toLowerCase();
      if (!arg) {
        return { reply: `Vision is currently \`${settings.pipVisionEnabled ? "on" : "off"}\`. Use \`/vision on\` or \`/vision off\`.` };
      }
      if (arg !== "on" && arg !== "off") {
        return { reply: "Usage: `/vision on` or `/vision off`." };
      }
      settings.pipVisionEnabled = arg === "on";
      saveSettings();
      return { reply: `Vision ${arg}.` };
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
    // Model identifier surfaces in the input placeholder ("Ask Pip… ·
    // gpt-4o-mini") so the user always knows which backend is live.
    modelLabel: activeModelForBackend(settings.pipBackend),
    onOpen: cancelAutoDismiss,
    // Stop button click — flag the askWithTools loop to abort between iterations.
    onAbort: () => { _abort = true; },
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
