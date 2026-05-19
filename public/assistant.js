import { ask, askWithTools, activeModelForBackend, CLAUDE_VARIANTS } from "./claude.js";
import { getTools, executor, setAskInChatHandler, isVisionAvailable } from "./pip-tools.js";
import { labelTool, summarizeTool } from "./format.js";
import { settings, saveSettings } from "./settings.js";
import { state } from "./state.js";
import { isSupported as voiceInputSupported, startDictation } from "./voice-input.js";
import { AUTH_URL } from "./endpoints.js";
import { createPip, renderMd } from "https://cdn.jsdelivr.net/npm/@jonasneves/pip@2.9.5/pip-core.esm.js";

const HISTORY_LIMIT = 12;

// Executor-enforced rules (signed-pair clamp, firmware pulse caps) live
// in pip-tools.js. Per-tool guidance (when to detect vs view, ask_human
// routing) lives in tool descriptions and ships on every turn. Static
// system prompt carries identity + discovery posture; the current
// connected-robot snapshot is appended per-turn by buildSystem() so Pip
// can skip list_robots when ids are unambiguous.
const PIP_SYSTEM = [
  "You are an assistant in a browser robotics dashboard for ESP32 and Pi robots.",
  "Tools let you read robot state, see frames, detect objects, pulse motors, ask the human.",
  "Use tools to discover state — don't guess.",
  "If a tool returns { error: ... }, surface it; don't fabricate around it.",
  // Anti-narrate-without-acting — the dominant failure mode observed in
  // patrol runs (Claude Code's own discipline, mirrored from the
  // Piebald-AI/claude-code-system-prompts repo).
  "If you say you will call a tool, call it in the SAME turn. Don't promise tool calls for future turns. Don't describe actions you didn't take.",
  // Perception-first for visual tasks — ExploreVLM / Butter-Bench pattern.
  "For 'find X' / 'see X' / 'explore' tasks, your FIRST tool call must be view_robot_frame (when available) so you ground the plan in current pixels. Then arm a watcher if any COCO class plausibly matches; if no class fits (e.g. 'Roomba' isn't COCO), don't fake it — rely on view_robot_frame after each meaningful move.",
  // Sensor freshness — research-backed, ties staleness to motion events
  // not wall clock (arxiv 2510.23853 "Temporally Blind").
  "When get_robot_state returns motion_invalidated: true, telemetry was captured BEFORE the last motor action. Do NOT trust dist_cm in that state — issue another get_robot_state after letting the robot settle, or take a frame.",
  "telemetry.dist_cm (when present) is the forward-facing ultrasonic distance in centimeters.",
  "Firmware silently clips pure-forward motion when dist_cm < ~15 — turns and reverse always pass, so rotate away first if blocked.",
  "",
  // Hard-enforced format constraints. Pip renders into a small chat
  // bubble with a deliberately tiny markdown subset — anything outside
  // it ships as raw syntax to the user. Plain-text-summary keeps Claude
  // honest about length (see hatch agent-loop.js for prior art).
  "REPLY FORMAT: reply with a concise plain-text summary. One short sentence is the default; never more than three lines unless the user explicitly asks for detail. No preamble, no recap, no apology, no narrating what you're about to do.",
  "Supported markdown: **bold**, *italic*, `code`, - bullets, 1. numbered lists, ```code blocks```. Do NOT use headers (#, ##, ###), horizontal rules (---), tables, or decorative section emojis — those render as raw text.",
].join("\n");

// Per-turn context. Collapses the "you must call list_robots first" round
// trip when the id is already unambiguous from current state.
function currentRobotsLine() {
  const usable = [...state.devices.values()].filter(e =>
    e.status === "connected" || e.status === "firmware-down"
  );
  if (usable.length === 0) {
    return "No robots are connected. Tools requiring an id will return errors until the user pairs and connects one.";
  }
  if (usable.length === 1) {
    const r = usable[0];
    const note = r.status === "firmware-down" ? " (firmware down — only recovery ops work)" : "";
    return `Connected robot: id="${r.id}" name="${r.name}" type=${r.fwType || "unknown"}${note}. Use this id directly; list_robots is unnecessary.`;
  }
  const lines = usable.map(r => {
    const note = r.status === "firmware-down" ? " [firmware down]" : "";
    return `- id="${r.id}" name="${r.name}" type=${r.fwType || "unknown"}${note}`;
  }).join("\n");
  return `${usable.length} connected robots (use these ids directly; list_robots only to refresh status):\n${lines}`;
}

function buildSystem() {
  // Per-turn time + capability injection. Research consensus is one "now"
  // per turn (Claude Code's UserPromptSubmit hook, OpenAI Codex's
  // turn_started_at_unix_ms) rather than per tool — surfaces wall-clock
  // context where the planner reasons. Vision availability flagged here
  // so Pip stops narrating "let me take a snapshot" when the tool is
  // filtered out of getTools().
  const now = new Date().toISOString();
  const vision = isVisionAvailable()
    ? "view_robot_frame is available — use it for visual queries."
    : "view_robot_frame is NOT available this turn (vision off, or backend doesn't accept inline images). Don't promise visual snapshots. If a frame is needed, tell the user to run /vision on or switch backend with /model.";
  return `${PIP_SYSTEM}\n\nCurrent time: ${now}\n${vision}\n\n${currentRobotsLine()}`;
}

export const PIP_INTRO = "Try: \"why isn't this robot connecting\" or \"what's in the camera\". /help for commands.";

let _pip = null;
let _abort = false;
let _activeTurnEl = null;

// Tool-call pill, hatch-style. Appended directly to turnEl in flow with
// the rest of the iteration's text — so a multi-step turn renders as
// [text 1] [pill 1] [text 2] [pill 2] [final text], not [stack of pills]
// [final text]. Clicking Details expands a pre with args + result.
function appendStepPill(turnEl, name) {
  const el = document.createElement("div");
  el.className = "pip-step running";
  el.innerHTML =
    `<div class="pip-step-head">` +
      `<span class="pip-step-icon">▸</span>` +
      `<span class="pip-step-label">${escHtml(labelTool(name))} …</span>` +
      `<span class="pip-step-elapsed"></span>` +
      `<button class="pip-step-toggle" type="button" hidden>Details</button>` +
    `</div>` +
    `<div class="pip-step-detail" hidden></div>`;
  turnEl.appendChild(el);
  const toggle = el.querySelector(".pip-step-toggle");
  const detail = el.querySelector(".pip-step-detail");
  toggle.addEventListener("click", () => {
    const open = detail.hidden;
    detail.hidden = !open;
    toggle.textContent = open ? "Hide" : "Details";
  });
  scrollPanelToBottom();
  return el;
}

function safeJson(obj, maxStr = 240) {
  return JSON.stringify(obj, (_k, v) => {
    if (typeof v === "string" && v.length > maxStr) {
      return v.slice(0, maxStr) + `… (${v.length} chars)`;
    }
    return v;
  }, 2);
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function finishStepPill(el, name, input, result, error, durationMs) {
  if (!el) return;
  el.classList.remove("running");
  const isError = !!error;
  if (isError) el.classList.add("error");
  el.querySelector(".pip-step-label").textContent =
    summarizeTool(name, input, result, error, durationMs);
  if (durationMs != null) {
    const ms = Math.round(durationMs);
    el.querySelector(".pip-step-elapsed").textContent =
      ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }
  const detail = el.querySelector(".pip-step-detail");
  const sections = [
    input ? `<div class="pip-step-section"><span class="pip-step-detail-label">args</span><pre class="pip-step-pre">${escHtml(safeJson(input))}</pre></div>` : "",
    isError
      ? `<div class="pip-step-section"><span class="pip-step-detail-label">error</span><pre class="pip-step-pre">${escHtml(String(error?.message || error))}</pre></div>`
      : (result != null ? `<div class="pip-step-section"><span class="pip-step-detail-label">result</span><pre class="pip-step-pre">${escHtml(safeJson(result))}</pre></div>` : ""),
  ].filter(Boolean).join("");
  if (sections) {
    detail.innerHTML = sections;
    el.querySelector(".pip-step-toggle").hidden = false;
  }
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

// Host onSubmit — runs askWithTools with hatch-style inline pill flow.
// We render text + tool pills directly into turnEl in arrival order
// instead of stuffing the final text into pip's single .pip-reply.
async function onSubmit(text, { turnEl }) {
  _activeTurnEl = turnEl;
  _abort = false;
  // pip-core auto-toggles responding state around onSubmit, which morphs
  // the right-edge slot (send → stop). Just clear the abort flag here.

  // Hide pip's default empty reply slot — we own the flow now.
  const defaultReply = turnEl.querySelector(".pip-reply");
  if (defaultReply) defaultReply.hidden = true;

  let currentReplyEl = null;   // active iteration's text bubble; null between iterations
  let pendingStepEl = null;    // active tool pill awaiting onToolEnd
  // pip-iter-reply is our marker; pip-reply + ai-generated pull in
  // pip-core's markdown styling (p margins, code, ul/ol). pip's own
  // setReplyText queries the first .pip-reply (the hidden default we
  // leave at the top), so adding the class here doesn't trip on it.
  const appendReplyEl = () => {
    const el = document.createElement("div");
    el.className = "pip-iter-reply pip-reply ai-generated";
    turnEl.appendChild(el);
    return el;
  };

  const messages = _pip.history.slice(-HISTORY_LIMIT)
    .map(m => ({ role: m.role, content: m.content }));
  const reply = await askWithTools(messages, {
    system: buildSystem(),
    tools: getTools(),
    executor,
    maxTokens: 1024,
    // High budget + no interrupt prompt: trust the planner to stop when
    // done (stop_reason !== "tool_use") or the user to hit Stop. The old
    // "Continue?" prompt cut Claude mid-thought on multi-step tasks the
    // 10-iteration default couldn't fit. Stop button + firmware-level
    // safety floors (pulse caps, watchdog, ultrasonic clip) bound blast
    // radius — no executor-imposed observation cadence layered on top.
    maxIterations: 50,
    onToolStart: ({ name }) => {
      // Close out the current iteration's text bubble so the next
      // iteration's deltas land in a fresh one below the pill.
      currentReplyEl = null;
      pendingStepEl = appendStepPill(turnEl, name);
    },
    onToolEnd: ({ name, input, result, error, durationMs }) => {
      finishStepPill(pendingStepEl, name, input, result, error, durationMs);
      pendingStepEl = null;
    },
    onDelta: (iterText) => {
      if (!currentReplyEl) currentReplyEl = appendReplyEl();
      currentReplyEl.innerHTML = renderMd(iterText);
      scrollPanelToBottom();
    },
    shouldAbort: () => _abort,
  });
  _activeTurnEl = null;

  // Backend returned nothing usable → render the failure inline since
  // we've hidden pip's default reply. actOnFailure can also drive an
  // inline askInChat (sign-in / key prompt), which appends its own
  // block to turnEl independently.
  if (reply == null || reply === "") {
    const failureText = await actOnFailure(settings.pipBackend, turnEl);
    if (failureText) {
      const el = appendReplyEl();
      el.innerHTML = renderMd(failureText);
      scrollPanelToBottom();
    }
  } else if (!currentReplyEl) {
    // Non-streaming path (e.g. backend != bridge) had no deltas — render
    // the full reply once now so the user actually sees it.
    const el = appendReplyEl();
    el.innerHTML = renderMd(reply);
    scrollPanelToBottom();
  }
  // Return "" so pip's setReplyText writes to the hidden default reply
  // — invisible, but it keeps pip's responding-state teardown happy.
  return "";
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
    name: "voice",
    description: "start / stop voice dictation into the input",
    handler: () => {
      if (!voiceInputSupported()) {
        return { reply: "Voice input isn't supported in this browser. Chrome / Edge / Safari only." };
      }
      toggleDictation();
      return { reply: "" };
    },
  });

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
  _pip.registerSlash({
    name: "model",
    description: "switch Pip's backend (github/bridge/anthropic/openai) or Claude variant (opus/sonnet/haiku)",
    // Context-aware completion: on a Claude-capable backend, variants come
    // first (that's the next decision you'd most likely make); otherwise
    // backends lead.
    complete: (partial) => {
      const isClaude = settings.pipBackend === "bridge" || settings.pipBackend === "anthropic";
      const ordered = isClaude ? [...CLAUDE_ALIASES, ...PIP_BACKENDS] : [...PIP_BACKENDS, ...CLAUDE_ALIASES];
      return ordered.filter(b => b.startsWith(partial.toLowerCase()));
    },
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
  //
  // pip-core's askInChat does `host.insertBefore(block, host.querySelector(".pip-reply"))`,
  // intended for single-reply turns. Our per-iteration setup emits multiple
  // `.pip-iter-reply pip-reply` bubbles, so that anchor finds the FIRST
  // reply and shoves the question above it — i.e. at the top of the turn.
  // Wrapping in a trailing empty div with no `.pip-reply` descendants makes
  // pip-core's querySelector return null and `insertBefore(block, null)`
  // fall through to appendChild, landing the question at the bottom of the
  // turn where chat UX expects it. Anchor is removed after the answer
  // resolves so it doesn't leak DOM per ask_human call.
  setAskInChatHandler(({ question, options }) => {
    if (!_activeTurnEl) return Promise.resolve(null);
    const anchor = document.createElement("div");
    anchor.className = "pip-ask-anchor";
    _activeTurnEl.appendChild(anchor);
    return _pip.askInChat({ question, options }, anchor)
      .finally(() => anchor.remove());
  });
  watchDialogs();
  wireMicButton();
}

// Web Speech dictation on pip's input. Injected post-init because pip-core
// doesn't expose an input-area hook; we sit alongside its pip-slash-key on
// the left edge using the same form-as-container pattern. Mic missing in
// the browser (Firefox, older Safari builds) → the button just isn't
// inserted, no broken affordance.
let _dictation = null;
function wireMicButton() {
  if (!voiceInputSupported()) return;
  const form = document.querySelector(".pip-form");
  const input = form?.querySelector(".pip-input");
  if (!form || !input) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pip-mic-btn";
  btn.setAttribute("aria-label", "Voice input");
  btn.title = "Voice input (press to start/stop)";
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM19 11a7 7 0 0 1-14 0M12 18v3M8 21h8"
          stroke="currentColor" stroke-width="1.6" fill="none"
          stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  // Append so the button lives at the right edge of the form alongside
  // pip-core's send button. CSS pins it absolutely at right:32, so DOM
  // order is incidental — appendChild keeps the form-control tab order
  // intuitive (input → mic → send).
  form.appendChild(btn);
  form.classList.add("pip-form--mic");

  const setListening = (on) => {
    btn.classList.toggle("listening", on);
    btn.setAttribute("aria-pressed", String(!!on));
  };

  // Snapshot whatever's in the input when dictation starts so the
  // transcript appends to existing text rather than nuking it. Cancel
  // restores this prefix so the user gets their pre-dictation state back.
  let prefix = "";
  const writeTranscript = (text) => {
    input.value = (prefix ? prefix + " " : "") + text;
    // Dispatch input event so pip-core's send-button visibility logic runs.
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const stop = ({ cancel = false } = {}) => {
    if (!_dictation) return;
    _dictation.stop({ cancel });
    _dictation = null;
    setListening(false);
  };

  const start = () => {
    if (_dictation) { stop(); return; }
    prefix = input.value.trim();
    setListening(true);
    _dictation = startDictation({
      onInterim: writeTranscript,
      onFinal: (final) => { if (final) writeTranscript(final); },
      onError: (err) => {
        console.warn("[voice-input]", err);
        if (err === "not-allowed") {
          input.placeholder = "Microphone permission denied — check Site settings.";
        }
      },
      onEnd: ({ reason }) => {
        // Chrome can fire onend on idle even with continuous=true — flip
        // the button back so the user can re-engage with one click instead
        // of two.
        _dictation = null;
        setListening(false);
        if (reason === "cancel") {
          // Escape: restore pre-dictation input so the user gets their
          // earlier draft back instead of the partial transcript.
          input.value = prefix;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.focus();
          return;
        }
        // Commit: tap-mic-again ("user") or silence-timeout ("auto") both
        // ship the transcript. requestSubmit fires pip-core's submit
        // handler — same path the send button uses.
        if (input.value.trim()) {
          // Let the input event flush + render before submit, so the user
          // sees the final transcript flash in the field for a beat.
          requestAnimationFrame(() => form.requestSubmit?.());
        } else {
          input.focus();
        }
      },
    });
  };

  btn.addEventListener("click", () => (_dictation ? stop() : start()));
  // Escape from anywhere bails an in-progress dictation without sending.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _dictation) stop({ cancel: true });
  });
}

export function toggleDictation() {
  // Slash-command entrypoint — same start/stop semantics as the button.
  document.querySelector(".pip-mic-btn")?.click();
}
