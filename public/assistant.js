import { ask, askWithTools, activeModelForBackend, CLAUDE_VARIANTS } from "./claude.js";
import { getTools, executor, setAskInChatHandler } from "./pip-tools.js";
import { labelTool, summarizeTool } from "./format.js";
import { settings, saveSettings } from "./settings.js";
import { AUTH_URL } from "./endpoints.js";
import { createPip } from "https://cdn.jsdelivr.net/npm/@jonasneves/pip@2.9.5/pip-core.esm.js";

const HISTORY_LIMIT = 12;

// Executor-enforced rules (3-pulse stop, pulse cap, signed-pair clamp) live
// in pip-tools.js. Per-tool guidance (when to detect vs view, ask_human
// routing) lives in tool descriptions and ships on every turn. System
// prompt carries identity + discovery posture only.
const PIP_SYSTEM = [
  "You are an assistant in a browser robotics dashboard for ESP32 and Pi robots.",
  "Tools let you read robot state, see frames, detect objects, pulse motors, ask the human.",
  "Use tools to discover — don't guess robot state. list_robots first if ambiguous.",
  "If a tool returns { error: ... }, surface it; don't fabricate around it.",
  "Respond concisely.",
].join("\n");

export const PIP_INTRO = "Try: \"why isn't this robot connecting\" or \"what's in the camera\". /help for commands.";

let _pip = null;
let _abort = false;
let _activeTurnEl = null;

// Trace row, one per tool_use. Click the summary to expand input/result —
// makes Pip's reasoning auditable in-place instead of requiring DevTools.
// Long strings (e.g. base64 image data) get truncated in the detail view
// so a single view_robot_frame call doesn't dump 80KB into the panel.
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
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "pip-trace-summary";
  summary.textContent = `${labelTool(name)} …`;
  summary.setAttribute("aria-expanded", "false");
  const detail = document.createElement("pre");
  detail.className = "pip-trace-detail";
  detail.hidden = true;
  summary.addEventListener("click", () => {
    const willOpen = detail.hidden;
    detail.hidden = !willOpen;
    summary.setAttribute("aria-expanded", String(willOpen));
  });
  li.appendChild(summary);
  li.appendChild(detail);
  ul.appendChild(li);
  scrollPanelToBottom();
  return li;
}

function safeJson(obj, maxStr = 240) {
  return JSON.stringify(obj, (_k, v) => {
    if (typeof v === "string" && v.length > maxStr) {
      return v.slice(0, maxStr) + `… (${v.length} chars)`;
    }
    return v;
  }, 2);
}

function finishTraceLine(li, name, input, result, error, durationMs) {
  if (!li) return;
  li.classList.remove("pending");
  const isError = !!error;
  if (isError) li.classList.add("error");
  const summary = li.querySelector(".pip-trace-summary");
  summary.textContent = summarizeTool(name, input, result, error, durationMs);
  const detail = li.querySelector(".pip-trace-detail");
  const payload = { input: input ?? null };
  if (isError) payload.error = String(error?.message || error);
  else payload.result = result ?? null;
  detail.textContent = safeJson(payload);
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

// Lazy GitHub OAuth helper — shared between /model handler and the
// failure-recovery flow. Module-scope so both code paths reach it.
let _connectGitHubFn = null;
async function _loadConnectGitHub() {
  if (_connectGitHubFn) return _connectGitHubFn;
  const mod = await import(`${AUTH_URL}/connect.js`);
  _connectGitHubFn = mod.connectGitHub;
  return _connectGitHubFn;
}

// Bridge failure copy. github / anthropic / openai use the
// inline-button + main-input recovery path in actOnFailure, so they
// don't need text hints anymore.
function backendFailureHint(backend) {
  const hints = {
    bridge:
      "ai-bridge isn't responding. Check the local service is running, or `/model` to switch backends.",
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
    onToolStart: ({ name }) => { pendingTraceLi = appendTraceLine(turnEl, name); },
    onToolEnd: ({ name, input, result, error, durationMs }) => {
      finishTraceLine(pendingTraceLi, name, input, result, error, durationMs);
      pendingTraceLi = null;
    },
    shouldAbort: () => _abort,
    onMaxIterations: async () => {
      const choice = await _pip.askInChat({
        question: "Several steps in without finishing. Continue?",
        options: ["Continue", "Stop"],
      }, turnEl);
      return choice === "Continue" ? 5 : 0;
    },
  });
  _activeTurnEl = null;
  // Backend returned nothing usable → surface an actionable recovery
  // (button or repurposed main input) instead of pip-core's generic
  // "try again." See actOnFailure: github → Sign in button; anthropic/
  // openai → main input becomes the key-paste field; bridge falls back
  // to a text hint.
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
const PIP_BACKENDS = ["github", "bridge", "anthropic", "openai"];

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
  // backend or a Claude variant, the rest happens inline. Key entry
  // repurposes Pip's main input via _pip.collectSecret — same input the
  // user's already looking at.
  const CLAUDE_ALIASES = CLAUDE_VARIANTS.map(v => v.alias);
  const MODEL_CHOICES = [...PIP_BACKENDS, ...CLAUDE_ALIASES];
  _pip.registerSlash({
    name: "model",
    description: "switch Pip's backend (github/bridge/anthropic/openai) or Claude variant (opus/sonnet/haiku)",
    complete: (partial) => MODEL_CHOICES.filter(b => b.startsWith(partial.toLowerCase())),
    handler: async (argsString) => {
      const arg = argsString.trim().toLowerCase();
      if (!arg) {
        const others = PIP_BACKENDS.filter(b => b !== settings.pipBackend);
        return {
          reply: `Current backend: \`${settings.pipBackend}\` · model: \`${activeModelForBackend(settings.pipBackend)}\`. Switch backend with \`/model <name>\` (${others.map(b => `\`${b}\``).join(", ")}) or Claude variant with \`/model opus|sonnet|haiku\`.`,
        };
      }

      // Claude variant switch — sets pipClaudeModel; takes effect on
      // bridge + anthropic backends. On other backends we still save it so
      // it'll apply once they switch to a Claude-capable backend.
      const variant = CLAUDE_VARIANTS.find(v => v.alias === arg);
      if (variant) {
        settings.pipClaudeModel = variant.id;
        try { saveSettings(); } catch {}
        _pip.setModelLabel?.(activeModelForBackend(settings.pipBackend));
        const isClaudeBackend = settings.pipBackend === "bridge" || settings.pipBackend === "anthropic";
        const tail = isClaudeBackend ? "" : ` — takes effect after \`/model bridge\` or \`/model anthropic\`.`;
        return { reply: `Claude variant set to \`${variant.id}\`${tail}` };
      }

      if (!PIP_BACKENDS.includes(arg)) {
        return { reply: `Unknown choice \`${arg}\`. Backends: ${PIP_BACKENDS.map(b => `\`${b}\``).join(", ")}. Claude variants: ${CLAUDE_ALIASES.map(b => `\`${b}\``).join(", ")}.` };
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

      return { reply: `Backend set to \`${arg}\`.` };
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
      if (isOpen && !wasOpen) rehoistPip();
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
    placeholder: "Ask a question…",
    maxLength: 4000,
    // Model identifier surfaces in the input placeholder so the user
    // always knows which backend is live.
    modelLabel: activeModelForBackend(settings.pipBackend),
    // Stop button click — flag the askWithTools loop to abort between iterations.
    onAbort: () => { _abort = true; },
  });
  registerInitialSlashCommands();
  if (showIntro) { try { localStorage.setItem(seenKey, "1"); } catch {} }
  // Inject in-chat ask handler so pip-tools' ask_human can render option
  // buttons / free-text input inline in the active turn.
  setAskInChatHandler(({ question, options }) =>
    _pip.askInChat({ question, options }, _activeTurnEl));
  watchDialogs();
}
