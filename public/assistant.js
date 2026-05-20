import { ask, askWithTools, askAboutFrame, activeModelForBackend, CLAUDE_VARIANTS } from "./claude.js";
import { getTools, executor, setAskInChatHandler, isVisionAvailable } from "./pip-tools.js";
import { labelTool, summarizeTool } from "./format.js";
import { settings, saveSettings } from "./settings.js";
import { state } from "./state.js";
import { isSupported as voiceInputSupported, startDictation } from "./voice-input.js";
import { tryMatchCommand, SAFETY_INTENTS } from "./voice-commands.js";
import { tryMatchDemo, DEMO_NAMES, STATIC_DEMO_PHRASES } from "./demos.js";
import { prewarmCache as prewarmTtsCache, onSpeakingChange, isSpeaking } from "./voice.js";
import { onWatcherFire, releaseAllGates, awaitReflexGate } from "./watcher.js";
import { AUTH_URL } from "./endpoints.js";
import { createPip, renderMd } from "https://cdn.jsdelivr.net/npm/@jonasneves/pip@2.9.5/pip-core.esm.js";

const HISTORY_LIMIT = 12;

// Executor-enforced rules (signed-pair clamp, firmware pulse caps) live
// in pip-tools.js. Per-tool guidance (when to detect vs view, ask_human
// routing) lives in tool descriptions and ships on every turn. Static
// system prompt carries identity + discovery posture; the current
// connected-robot snapshot is appended per-turn by buildSystem() so Pip
// can skip list_robots when ids are unambiguous.
// Trimmed via lens audit (signal-to-noise + attention-routing): every
// reactive single-incident patch removed. Tool descriptions carry
// per-tool guidance; the system prompt carries only identity + the rules
// the planner can't infer from schemas. Hardware constraints (dist_cm,
// firmware clip) live in get_robot_state / move_motor descriptions where
// the planner reads them at the moment of relevance.
const PIP_SYSTEM = [
  "You are an assistant in a browser robotics dashboard for ESP32 and Pi robots.",
  // Anti-narrate-without-acting — dominant failure mode in patrol runs;
  // Sonnet skips actual tool calls without it.
  "If you say you will call a tool, call it in the SAME turn. Don't promise tool calls for future turns. Don't describe actions you didn't take.",
  // Sensor freshness (arxiv 2510.23853 "Temporally Blind").
  "When get_robot_state returns motion_invalidated: true, telemetry was captured BEFORE the last motor action — re-read state or take a frame before trusting dist_cm.",
  // Loop anti-pattern guard — Nav2 recovery BTs reset on preempt, ours
  // doesn't, so otherwise the planner can keep retrying the same plan
  // against a continuous reflex (drive toward sign → halt → drive → halt).
  "If a [reflex-fire] reports the same class halting your motion twice in one turn, the floor is rejecting your plan — stop or call ask_human; don't retry the same approach.",
  // Reply shape constraints (the chat bubble's markdown subset).
  "REPLY FORMAT: concise plain-text summary. One short sentence is the default; never more than three lines unless the user asks for detail. No preamble, no recap, no narrating what you're about to do.",
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

// L2 reflex-fire injection — see watcher.js + claude.js. When the
// reflex watcher fires during an active Pip turn, we queue a synthetic
// observation here; askWithTools drains it via getPendingObservations
// between iterations so Pip sees the event on its next loop without
// having to poll. Bounded by fire-once-and-disable: at most one entry
// per arm cycle, so the queue can't pile up.
const _pendingObservations = [];

// Tool-call pill, hatch-style. Appended directly to turnEl in flow with
// the rest of the iteration's text — so a multi-step turn renders as
// [text 1] [pill 1] [text 2] [pill 2] [final text], not [stack of pills]
// [final text]. Clicking Details expands a pre with args + result.
// Compact chevron — pip-core's own slash/send buttons use 12×12 SVGs
// with stroke-width 1.6, so we match for visual consistency.
const CHEVRON_SVG =
  `<svg class="pip-step-chevron" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">` +
    `<path d="M4.5 3 L8 6 L4.5 9" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
  `</svg>`;

function appendStepPill(turnEl, name) {
  const el = document.createElement("div");
  el.className = "pip-step running";
  el.innerHTML =
    `<div class="pip-step-head">` +
      CHEVRON_SVG +
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
    el.classList.toggle("expanded", open);
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
  // null durationMs to summarizeTool — we render elapsed in its own
  // span so the label stays semantic (tool name + arg summary) and the
  // timing aligns to the right edge instead of being baked into the
  // sentence.
  el.querySelector(".pip-step-label").textContent =
    summarizeTool(name, input, result, error, null);
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

function pickRobotId() {
  return [...state.devices.values()].find(e => e.status === "connected")?.id;
}

// Voice-as-sensor injection: when a voice command (or any utterance)
// arrives mid-turn (Claude is in the askWithTools loop), we don't open
// a new turn — pip's input is disabled and a parallel turn would split
// the conversation. Instead we:
//   - render any tool we directly dispatch as a .pip-step pill in the
//     active turn so the operator sees the side-channel intervention
//   - push an observation into _pendingObservations so claude.js drains
//     it on the next iteration alongside the tool_results, making the
//     intervention visible to the planner
//   - on safety verbs (stop), also flip _abort so the loop yields after
//     the current iteration instead of continuing to plan around the
//     interrupt
//
// Match → direct dispatch. No-match utterances are still injected as
// informational observations ("user said: ...") so the user knows
// they were heard even when there's no actionable verb.
async function injectVoiceMidTurn(text) {
  if (!_activeTurnEl) return false;
  const cmd = tryMatchCommand(text);
  if (cmd) {
    const robotId = pickRobotId();
    if (!robotId) {
      _pendingObservations.push(`[user-voice] User said "${text}" — no robot connected.`);
      return true;
    }
    const input = { id: robotId, ...cmd.partialInput };
    const pill = appendStepPill(_activeTurnEl, cmd.tool);
    const startedAt = performance.now();
    let resultStr;
    try {
      const result = await executor(cmd.tool, input);
      const isErr = result && (result.error || result.ok === false);
      finishStepPill(pill, cmd.tool, input, result, isErr ? (result.error || "failed") : null, performance.now() - startedAt);
      resultStr = isErr ? `error: ${result.error || "failed"}` : "ok";
    } catch (err) {
      finishStepPill(pill, cmd.tool, input, null, err, performance.now() - startedAt);
      resultStr = `error: ${err?.message || err}`;
    }
    const ts = new Date().toISOString();
    _pendingObservations.push(
      `[user-voice ${ts}] User said "${text}" — direct-dispatched ${cmd.tool}(${JSON.stringify(input)}) → ${resultStr}. ` +
      (SAFETY_INTENTS.has(cmd.intent)
        ? "This is a safety override; stop your current plan."
        : "Adjust your plan if this affects what you were about to do.")
    );
    if (SAFETY_INTENTS.has(cmd.intent)) _abort = true;
    scrollPanelToBottom();
    return true;
  }
  // Non-command utterance: just inform the planner. Cheap and useful —
  // lets the user nudge Claude ("slow down", "head to the kitchen")
  // without taking over.
  _pendingObservations.push(
    `[user-voice ${new Date().toISOString()}] User said "${text}". Treat as live guidance; adjust your plan if relevant.`
  );
  return true;
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

  // Direct-command + demo paths: if the input matches a recognized
  // command verb (drive, turn, stop…) or a demo name, dispatch
  // immediately and skip the LLM round-trip. Mycroft / OpenVoiceOS
  // pattern: regex intent gate first, LLM fallback for everything else.
  const pickRobot = () =>
    [...state.devices.values()].find(e => e.status === "connected")?.id;
  // Shared step-executor that renders a pill per tool call — same
  // affordance as LLM-driven tool calls, so direct commands and demo
  // sequences are visually indistinguishable from agent work.
  const runStep = async (tool, input) => {
    const pill = appendStepPill(turnEl, tool);
    const startedAt = performance.now();
    try {
      const result = await executor(tool, input);
      const isErr = result && (result.error || result.ok === false);
      finishStepPill(pill, tool, input, result, isErr ? (result.error || "failed") : null, performance.now() - startedAt);
      return result;
    } catch (err) {
      finishStepPill(pill, tool, input, null, err, performance.now() - startedAt);
      throw err;
    }
  };
  const noRobot = () => {
    const el = appendReplyEl();
    el.textContent = "No robot connected — pair one first.";
    scrollPanelToBottom();
    return "";
  };

  const cmd = tryMatchCommand(text);
  if (cmd) {
    const robotId = pickRobot();
    if (!robotId) return noRobot();
    await runStep(cmd.tool, { id: robotId, ...cmd.partialInput }).catch(() => {});
    return "";
  }

  // Demo path. Each routine orchestrates a sequence of tool calls via
  // runStep, so the whole choreography renders in the chat as pills the
  // user can audit / replay through Details. shouldAbort lets the Stop
  // button cut a long demo (follow especially) mid-sequence.
  const demo = tryMatchDemo(text);
  if (demo) {
    const robotId = pickRobot();
    if (!robotId) return noRobot();
    const ctx = {
      id: robotId,
      exec: runStep,
      sleep: (ms) => new Promise(r => setTimeout(r, ms)),
      shouldAbort: () => _abort,
      // Subscribe to MediaPipe watcher fires so demos can react to
      // reflex events (e.g. stopsign demo halts its loop when the
      // watcher catches "stop sign"). Returns an unsubscribe fn.
      onWatcherFire,
      // Single-shot Claude observation about a frame (no tool loop).
      // Powers demos like `react` that want a personalized greeting
      // from what the robot actually saw. Null on non-Claude backends
      // or any failure — caller falls back to a canned line.
      askAboutFrame,
      // Wait until the reflex motor-gate is released (the operator
      // moves the trigger out of view, or the watcher's cool-down
      // expires). Lets demos pause-and-resume around reflex halts
      // instead of bailing out of the loop.
      awaitReflexGate,
      // Forward ultrasonic distance in cm (or null when telemetry
      // hasn't arrived yet). Demos use this to detect obstacles —
      // firmware silently clips pure-forward motion when dist_cm<15
      // and returns ok:true from move_motor, so an inattentive demo
      // happily "drives" into a wall forever. Polling between
      // segments lets the demo break the leg early and turn around.
      getDistCm: () => state.devices.get(robotId)?.telemetry?.dist_cm ?? null,
    };
    try { await demo.run(ctx); }
    catch (err) {
      const el = appendReplyEl();
      el.textContent = `Demo "${demo.label}" failed: ${err?.message || err}`;
      scrollPanelToBottom();
    }
    return "";
  }

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
      // Inline render of view_robot_frame's image — the perception Pip
      // actually saw should be visible in the chat, not buried in a
      // Details JSON pre. Matches Anthropic computer-use UX where every
      // screenshot lands inline next to the action that triggered it.
      if (name === "view_robot_frame" && !error && result?._pipContent) {
        const img = result._pipContent.find(b => b?.type === "image");
        if (img?.source?.data) {
          const el = document.createElement("img");
          el.className = "pip-tool-image";
          el.src = `data:${img.source.media_type};base64,${img.source.data}`;
          el.alt = "robot camera frame";
          el.loading = "lazy";
          turnEl.appendChild(el);
          scrollPanelToBottom();
          // Reset the iter-reply pointer so the next text delta lands in
          // a fresh bubble *below* the image (same shape as the tool-pill
          // boundary) — keeps "image then narration" order legible.
          currentReplyEl = null;
        }
      }
    },
    onDelta: (iterText) => {
      if (!currentReplyEl) currentReplyEl = appendReplyEl();
      currentReplyEl.innerHTML = renderMd(iterText);
      scrollPanelToBottom();
    },
    shouldAbort: () => _abort,
    getPendingObservations: () => _pendingObservations.splice(0),
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
  // /demo — scripted choreographies. Slash exists for tab-completion +
  // /help discoverability. The actual execution runs through onSubmit
  // (because demos need turn-scoped pill rendering, and slash handlers
  // don't get turnEl), so we synthesize `demo <name>` into the input
  // and requestSubmit. clearedUI:true keeps pip from also creating an
  // empty slash-response turn next to the real one.
  _pip.registerSlash({
    name: "demo",
    description: `run a scripted demo (${DEMO_NAMES.join(", ")})`,
    complete: (partial) => DEMO_NAMES.filter(n => n.startsWith(partial.toLowerCase())),
    handler: (argsString) => {
      const arg = argsString.trim();
      if (!arg) {
        return { reply: `Demos: ${DEMO_NAMES.map(n => `\`${n}\``).join(", ")}. Try \`/demo figure8\`.` };
      }
      const input = document.querySelector(".pip-input");
      const form  = input?.form || document.querySelector(".pip-form");
      if (!input || !form) return { reply: "Demo input not available." };
      input.value = `demo ${arg}`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      requestAnimationFrame(() => form.requestSubmit?.());
      return { clearedUI: true };
    },
  });

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
    // Stop button click — flag the askWithTools loop to abort between
    // iterations AND release any reflex motor-gate so a tool currently
    // awaiting "stop sign clears" unblocks immediately. Without the gate
    // release, Stop would wait up to 10s for the gate's timeout to fire
    // before the loop noticed _abort.
    onAbort: () => { _abort = true; releaseAllGates(); },
  });
  registerInitialSlashCommands();
  if (showIntro) { try { localStorage.setItem(seenKey, "1"); } catch {} }
  // Background-fetch the cached audio for every hardcoded demo phrase
  // on first load (cache hits skip the network entirely on subsequent
  // loads). No-op when no OpenAI key is configured. Runs after pip
  // boots so the user sees the dashboard immediately; finishes within
  // a few seconds, by which time the first demo audio is already
  // staged in Cache API and plays with zero network round-trip.
  prewarmTtsCache(STATIC_DEMO_PHRASES);
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
  wireWatcherFireBridge();
}

// L2 reflex-fire bridge. On every watcher fire-event:
//   - queue a synthetic observation for askWithTools to drain on the
//     next iteration (so Pip sees it without having to poll state)
//   - render a small inline notice in the active turn so the operator
//     sees what got injected
// `kind` is one of:
//   "fire"             — halt-mode target entered frame (motion gate engaged)
//   "clear"            — halt-mode target left frame (motion gate released)
//   "gesture-detected" — follow-mode classifier returned a high-confidence
//                        gesture; informational, no gate change
//   "follow-lost"      — follow-mode lost the hand for N consecutive ticks
//   "follow-reacquire" — follow-mode regained the hand after a lost streak
function wireWatcherFireBridge() {
  onWatcherFire((entry, det, kind = "fire") => {
    const ts = new Date(det?.ts || Date.now()).toISOString();
    const score = typeof det?.score === "number" ? det.score.toFixed(2) : "?";
    const action = entry?.watcher?.action || "?";
    // Terse fact-only observation — no "surface this / pause your plan"
    // prescriptions (the firmware-bounded reflex already gated motion;
    // planner narrates the fact, doesn't second-guess the safety floor).
    let obsText, noticeHtml, isReleaseShape;
    switch (kind) {
      case "clear":
        obsText = `[reflex-clear] "${det?.label}" no longer visible on ${entry.name} at ${ts}; motion gate released, your queued motor calls will proceed.`;
        noticeHtml = `Reflex clear: <strong>${escHtml(String(det?.label || ""))}</strong> left frame — motion resumed.`;
        isReleaseShape = true;
        break;
      case "gesture-detected":
        obsText = `[reflex-fire] operator gestured "${det?.gesture}" to ${entry.name} (score ${score}) at ${ts}; informational — follow tracking continues.`;
        noticeHtml = `Gesture: <strong>${escHtml(String(det?.gesture || ""))}</strong> (${score})`;
        isReleaseShape = false;
        break;
      case "follow-lost":
        obsText = `[reflex-fire] follow lost the operator's hand on ${entry.name} at ${ts}; robot is idle (not chasing) until the hand reappears.`;
        noticeHtml = `Follow: lost the hand — holding position until it reappears.`;
        isReleaseShape = false;
        break;
      case "follow-reacquire":
        obsText = `[reflex-clear] follow reacquired the operator's hand on ${entry.name} at ${ts}.`;
        noticeHtml = `Follow: hand reacquired — tracking resumed.`;
        isReleaseShape = true;
        break;
      default:  // "fire"
        obsText = `[reflex-fire] saw "${det?.label}" (${score}) on ${entry.name} at ${ts}; action ${action} ran${action === "halt" ? " and motion is now gated until the target leaves frame" : ""}.`;
        noticeHtml = `Reflex: saw <strong>${escHtml(String(det?.label || ""))}</strong> (${score}) — action <code>${escHtml(action)}</code> executed.`;
        isReleaseShape = false;
    }
    _pendingObservations.push(obsText);
    if (!_activeTurnEl) return;  // not mid-turn — planner sees it on the next user turn via convo replay
    const el = document.createElement("div");
    el.className = `pip-reflex-notice${isReleaseShape ? " pip-reflex-notice--clear" : ""}`;
    el.innerHTML =
      `<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">` +
        `<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
        `<circle cx="6" cy="6" r="1.8" fill="currentColor"/>` +
      `</svg> ` + noticeHtml;
    _activeTurnEl.appendChild(el);
    scrollPanelToBottom();
  });
}

// Web Speech dictation on pip's input. Injected post-init because pip-core
// doesn't expose an input-area hook; we sit alongside its pip-slash-key on
// the left edge using the same form-as-container pattern. Mic missing in
// the browser (Firefox, older Safari builds) → the button just isn't
// inserted, no broken affordance.
let _dictation = null;
// Sticky-mic flag: when true (user clicked the mic to enable), dictation
// auto-restarts after every commit (submit / mid-turn injection / safety
// verb). When false (user explicitly stopped, hit Escape, or never
// started), dictation stays off after the next end-event. The motivation
// is the "talk to your robot" loop — clicking the mic once should be
// enough to issue a sequence of commands without re-clicking between each.
let _micSticky = false;
function wireMicButton() {
  if (!voiceInputSupported()) return;
  const form = document.querySelector(".pip-form");
  const input = form?.querySelector(".pip-input");
  if (!form || !input) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pip-mic-btn";
  btn.setAttribute("aria-label", "Voice input");
  btn.title = "Voice input — click on; stays on across commands (click again or Escape to stop)";
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
    // Don't open the mic while TTS is currently speaking — the recognizer
    // would transcribe the robot's own voice as the next user command
    // (classic full-duplex problem; Alexa/Siri/Google all suspend mic
    // during their own TTS playback for this reason). The speaking-end
    // listener below will call start() again once audio finishes if
    // sticky is on.
    if (isSpeaking()) return;
    prefix = input.value.trim();
    setListening(true);
    // CSS hook for "sticky-mode armed" — a subtle persistent ring around
    // the mic so the operator knows clicking won't be needed between
    // commands.
    btn.classList.toggle("sticky", _micSticky);
    _dictation = startDictation({
      onInterim: writeTranscript,
      onFinal: (final) => { if (final) writeTranscript(final); },
      // Instant-fire for safety verbs. When Web Speech promotes a chunk
      // to final (typically at a natural pause), try the matcher. If
      // it's a safety intent (stop/halt), execute immediately without
      // waiting for the silence-commit window. Mid-turn injection
      // handles rendering + observation queueing.
      onFinalChunk: async (chunkedFinal) => {
        const m = tryMatchCommand(chunkedFinal);
        if (!m || !SAFETY_INTENTS.has(m.intent)) return;
        // Stop dictation immediately and clear the input — otherwise the
        // onEnd handler about to fire would re-dispatch the same command.
        // The empty-text short-circuit in onEnd (`if (!text) return`) is
        // what guards against the double-fire.
        stop();
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        if (_activeTurnEl) {
          await injectVoiceMidTurn(chunkedFinal);
        } else {
          // No active turn — open one ourselves via synth-submit so the
          // safety action still renders as a turn the user can audit.
          // We restore the transcript so the onSubmit matcher path can
          // dispatch it cleanly.
          input.value = chunkedFinal;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          requestAnimationFrame(() => form.requestSubmit?.());
        }
      },
      onError: (err) => {
        console.warn("[voice-input]", err);
        if (err === "not-allowed") {
          input.placeholder = "Microphone permission denied — check Site settings.";
        }
      },
      onEnd: async ({ reason }) => {
        // Chrome can fire onend on idle even with continuous=true — flip
        // the button back so the user can re-engage with one click instead
        // of two.
        _dictation = null;
        setListening(false);
        // Helper: re-arm dictation after a commit when the user's sticky
        // intent is still on. Small delay so (a) the form submit
        // dispatches before we re-grab the input element and (b) the
        // mic's audio buffer flushes the just-spoken utterance before
        // listening again (otherwise the next session can sometimes
        // pick up the tail of the prior one as a phantom command).
        const restartIfSticky = () => {
          if (!_micSticky) return;
          setTimeout(() => { if (_micSticky && !_dictation) start(); }, 400);
        };
        if (reason === "cancel") {
          // Escape: restore pre-dictation input so the user gets their
          // earlier draft back instead of the partial transcript. Escape
          // also clears sticky — explicit "stop listening" intent.
          _micSticky = false;
          input.value = prefix;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.focus();
          return;
        }
        const text = input.value.trim();
        if (!text) { input.focus(); restartIfSticky(); return; }

        // Mid-turn voice: don't go through pip-core's submit (input is
        // disabled during a running turn anyway). Inject as observation
        // — if it's a command, also execute it directly; either way the
        // planner sees it on its next iteration.
        if (_activeTurnEl) {
          await injectVoiceMidTurn(text);
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.focus();
          restartIfSticky();
          return;
        }

        // Idle path: normal submit through pip. Let the input event
        // flush + render before submit, so the user sees the final
        // transcript flash in the field for a beat.
        requestAnimationFrame(() => form.requestSubmit?.());
        restartIfSticky();
      },
    });
  };

  // Click toggles sticky-mode + dictation. First click → arm sticky AND
  // start listening; second click → disarm sticky AND stop. Auto-restart
  // in onEnd checks sticky; so submits / mid-turn injections don't drop
  // the mic between commands.
  btn.addEventListener("click", () => {
    if (_dictation) {
      _micSticky = false;
      stop();
    } else {
      _micSticky = true;
      start();
    }
  });
  // Escape from anywhere bails an in-progress dictation without sending
  // AND clears sticky — explicit "stop listening" intent.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _dictation) {
      _micSticky = false;
      stop({ cancel: true });
    }
  });

  // TTS feedback-gating. While the robot is speaking, kill the mic so
  // the recognizer can't transcribe its own voice back as the next
  // command. When TTS ends, restart if sticky is on. 300ms tail delay
  // before restart so audio-system AEC has a chance to settle (without
  // this, the very tail of the just-played utterance can be picked up
  // as a phantom one-syllable command).
  onSpeakingChange((speaking) => {
    if (speaking) {
      if (_dictation) stop({ cancel: true });  // drop the partial; don't commit phantom audio
    } else if (_micSticky && !_dictation) {
      setTimeout(() => { if (_micSticky && !_dictation && !isSpeaking()) start(); }, 300);
    }
  });
}

export function toggleDictation() {
  // Slash-command entrypoint — same start/stop semantics as the button.
  document.querySelector(".pip-mic-btn")?.click();
}
