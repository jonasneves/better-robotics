// Pip core — floating assistant bubble + panel. Used by better-robotics
// and neves.io. Projects inject their own `ask` callable + system prompt;
// this module owns DOM, CSS, open/close, turn rendering, intro collapse.
// Hosts compose richer features (tool tracing, ambient dialog notify,
// proactive events, slash commands) around the returned handles.

const CSS = `
.pip-bubble {
  position: fixed;
  left: auto; top: auto;
  right: max(20px, env(safe-area-inset-right));
  bottom: max(20px, env(safe-area-inset-bottom));
  margin: 0;
  width: 44px; height: 44px;
  min-width: 44px; min-height: 44px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--pip-ink, currentColor);
  font-size: 36px;
  line-height: 1;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 20;
  transition: transform 0.15s ease-out;
  overflow: visible;
}
.pip-bubble:popover-open { display: inline-flex; }
.pip-bubble:hover { transform: translateY(-3px); }
.pip-bubble:active { transform: translateY(0); }
.pip-bubble.responding { color: var(--pip-accent, #d4b24e); }
.pip-bubble .pip-robot-icon { width: 100%; height: 100%; display: block; }

.pip-bubble .robot-eyes { animation: pip-robot-idle 8s step-end infinite; transform-origin: 12px 14px; }
.pip-bubble .robot-antenna-l { opacity: 1; animation: pip-antenna-l-idle 8s step-end infinite; }
.pip-bubble .robot-antenna-s { opacity: 0; animation: pip-antenna-s-idle 8s step-end infinite; }
.pip-bubble .robot-antenna-r { opacity: 0; }
.pip-bubble .robot-spark { opacity: 0; animation: pip-spark-flash 8s step-end infinite; }
.pip-bubble .robot-eye-r { animation: pip-robot-wink 12s step-end infinite; transform-origin: 15px 14px; }

@keyframes pip-antenna-l-idle { 0%, 100% { opacity: 1; } 58% { opacity: 0; } 67% { opacity: 1; } }
@keyframes pip-antenna-s-idle { 0%, 100% { opacity: 0; } 58% { opacity: 1; } 67% { opacity: 0; } }
@keyframes pip-spark-flash { 0%, 56%, 67%, 100% { opacity: 0; } 60% { opacity: 1; } 63% { opacity: 0.5; } }
@keyframes pip-robot-idle {
  0%, 32% { transform: scaleY(1) translateX(0); }
  34%     { transform: scaleY(0.15) translateX(0); }
  37%, 56% { transform: scaleY(1) translateX(0); }
  59%, 66% { transform: scaleY(1) translateX(0.8px); }
  69%, 78% { transform: scaleY(1) translateX(0); }
  80%     { transform: scaleY(0.15) translateX(0); }
  83%, 91% { transform: scaleY(1) translateX(0); }
  93%, 96% { transform: scaleY(1) translateX(-0.6px); }
  98%, 100% { transform: scaleY(1) translateX(0); }
}
@keyframes pip-robot-wink { 0%, 38%, 44%, 100% { transform: scaleY(1); } 40% { transform: scaleY(0.15); } }

.pip-bubble.responding .robot-eyes { animation: pip-robot-speak-eyes 2.4s step-end infinite; }
.pip-bubble.responding .robot-antenna-l { animation: pip-antenna-l-speak 1.2s step-end infinite; }
.pip-bubble.responding .robot-antenna-s { animation: pip-antenna-s-speak 1.2s step-end infinite; }
.pip-bubble.responding .robot-antenna-r { animation: pip-antenna-r-speak 1.2s step-end infinite; }
.pip-bubble.responding .robot-eye-r { animation: none; }
.pip-bubble.responding .robot-spark { animation: none; opacity: 0; }
@keyframes pip-robot-speak-eyes {
  0%, 50%, 100% { transform: scaleY(1) translateX(0); }
  20%           { transform: scaleY(1) translateX(0.4px); }
  28%           { transform: scaleY(0.2) translateX(0.4px); }
  32%           { transform: scaleY(1) translateX(0.4px); }
  70%           { transform: scaleY(1) translateX(-0.4px); }
  78%           { transform: scaleY(0.2) translateX(-0.4px); }
  82%           { transform: scaleY(1) translateX(-0.4px); }
}
@keyframes pip-antenna-l-speak { 0%, 100% { opacity: 1; } 25% { opacity: 0; } }
@keyframes pip-antenna-s-speak { 0%, 100% { opacity: 0; } 25% { opacity: 1; } 50% { opacity: 0; } 75% { opacity: 1; } }
@keyframes pip-antenna-r-speak { 0%, 100% { opacity: 0; } 50% { opacity: 1; } 75% { opacity: 0; } }

@media (prefers-reduced-motion: reduce) {
  .pip-bubble .robot-eyes,
  .pip-bubble .robot-eye-r,
  .pip-bubble .robot-spark,
  .pip-bubble .robot-antenna-l,
  .pip-bubble .robot-antenna-s,
  .pip-bubble .robot-antenna-r { animation: none; }
  .pip-bubble .robot-spark,
  .pip-bubble .robot-antenna-s,
  .pip-bubble .robot-antenna-r { opacity: 0; }
  .pip-bubble.responding .robot-eyes,
  .pip-bubble.responding .robot-antenna-l,
  .pip-bubble.responding .robot-antenna-s,
  .pip-bubble.responding .robot-antenna-r { animation: none; }
  .pip-panel.fading { transition: none; }
}

.pip-panel {
  position: fixed;
  right: max(20px, env(safe-area-inset-right));
  bottom: calc(72px + env(safe-area-inset-bottom));
  left: auto; top: auto;
  width: min(320px, calc(100vw - 40px));
  max-height: calc(100dvh - 96px - env(safe-area-inset-bottom) - env(safe-area-inset-top));
  overflow: visible;
  margin: 0;
  padding: 14px;
  border: 1px solid var(--pip-border, rgba(0,0,0,0.10));
  border-radius: 14px;
  background: var(--pip-surface, #fff);
  color: var(--pip-ink, inherit);
  box-shadow: 0 10px 30px rgba(0,0,0,0.15);
  transform-origin: bottom right;
}
/* Must be scoped to :popover-open — author-origin display:flex otherwise
   overrides the UA rule that hides un-open popovers, leaking the panel. */
.pip-panel:popover-open { display: flex; flex-direction: column; }
.pip-panel.fading { opacity: 0; transition: opacity 3s ease-out; }

.pip-close {
  position: absolute;
  top: 6px; right: 6px;
  min-width: 28px; min-height: 28px;
  width: 28px; height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  color: var(--pip-ink-muted, #6e6e73);
  background: var(--pip-surface, #fff);
  border-radius: 6px;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
}
.pip-close:hover { color: var(--pip-ink, inherit); }

/* Inner scroll region — min-height:0 is the flex-child escape hatch that
   lets overflow-y actually scroll instead of pushing the form out. Scroll
   moves here, not the outer .pip-panel, so the speech-bubble ::after tail
   (bottom:-7px) stays outside the clipping box. */
.pip-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--pip-border, rgba(0,0,0,0.10)) transparent;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
.pip-scroll::-webkit-scrollbar { width: 6px; }
.pip-scroll::-webkit-scrollbar-track { background: transparent; }
.pip-scroll::-webkit-scrollbar-thumb { background: var(--pip-border, rgba(0,0,0,0.10)); border-radius: 3px; }

.pip-notify {
  font-size: 13px;
  color: var(--pip-ink-muted, #6e6e73);
  margin: 0 32px 10px 0;
  padding: 8px 10px;
  border-left: 2px solid var(--pip-border, rgba(0,0,0,0.10));
  background: color-mix(in srgb, var(--pip-ink, currentColor) 3%, transparent);
  border-radius: 0 6px 6px 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.45;
  max-height: 200px;
  overflow: hidden;
  transition: opacity 0.4s ease, max-height 0.4s ease,
              margin-bottom 0.4s ease, padding 0.4s ease,
              border-left-width 0.4s ease;
}
.pip-notify[hidden] { display: none; }
.pip-notify.ai-generated { color: var(--pip-accent, #d4b24e); }
.pip-notify.dismissing {
  opacity: 0;
  max-height: 0;
  margin-bottom: 0;
  padding-top: 0;
  padding-bottom: 0;
  border-left-width: 0;
}
@media (prefers-reduced-motion: reduce) { .pip-notify { transition: none; } }

.pip-turns { display: flex; flex-direction: column; gap: 12px; }
.pip-turn { margin: 0; }
.pip-turn:first-child > .pip-echo { margin-right: 32px; }
.pip-echo {
  font-size: 13px;
  font-style: italic;
  color: var(--pip-ink-muted, #6e6e73);
  margin: 0 0 6px;
  padding-left: 8px;
  border-left: 2px solid var(--pip-border, rgba(0,0,0,0.10));
  white-space: pre-wrap;
  word-break: break-word;
}
.pip-reply { margin: 0; font-size: 13.5px; line-height: 1.5; }
.pip-reply.ai-generated { color: var(--pip-accent, #d4b24e); }
.pip-reply.ai-generated p { margin: 0 0 8px; }
.pip-reply.ai-generated p:last-child { margin-bottom: 0; }
.pip-reply.ai-generated code {
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--pip-accent, #d4b24e) 14%, transparent);
}
.pip-reply.ai-generated pre {
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--pip-accent, #d4b24e) 10%, transparent);
  overflow-x: auto;
}
.pip-reply.ai-generated pre code { padding: 0; background: transparent; font-size: 12px; }
.pip-reply.ai-generated strong { font-weight: 600; }
.pip-reply.ai-generated em { font-style: italic; }
.pip-reply.ai-generated ul,
.pip-reply.ai-generated ol { margin: 6px 0; padding-left: 20px; }
.pip-reply.ai-generated li { margin: 2px 0; }

.pip-form { margin: 10px 0 0; }
.pip-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 12px;
  border: 1px solid var(--pip-border, rgba(0,0,0,0.10));
  border-radius: 8px;
  background: var(--pip-surface, #fff);
  color: var(--pip-ink, inherit);
  font: inherit;
  font-size: 16px;  /* iOS Safari zooms on focus for any input under 16 */
}
.pip-input:focus { outline: none; border-color: var(--pip-accent, #d4b24e); }
.pip-input:disabled { opacity: 0.6; cursor: progress; }

/* Speech-bubble tail — rotated 14px square; top half hidden by panel, bottom corner sticks out. */
.pip-panel::after {
  content: "";
  position: absolute;
  bottom: -7px;
  right: 16px;
  width: 14px;
  height: 14px;
  background: var(--pip-surface, #fff);
  border-right: 1px solid var(--pip-border, rgba(0,0,0,0.10));
  border-bottom: 1px solid var(--pip-border, rgba(0,0,0,0.10));
  transform: rotate(45deg);
  pointer-events: none;
}

/* Inline ask — question + option buttons (or free-text input), answered
   in-place by the user. Used by ask_human tool-shape flows and by
   continue/stop budget prompts. */
.pip-ask {
  margin: 8px 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--pip-accent, #d4b24e) 50%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--pip-accent, #d4b24e) 6%, transparent);
}
.pip-ask-q { font-size: 13px; margin-bottom: 6px; color: var(--pip-ink, inherit); }
.pip-ask-options { display: flex; flex-wrap: wrap; gap: 6px; }
.pip-ask-form { display: flex; gap: 6px; align-items: stretch; }
.pip-ask-input {
  flex: 1;
  font-size: 13px;
  padding: 4px 8px;
  border: 1px solid var(--pip-border, rgba(0,0,0,0.10));
  border-radius: 4px;
  background: var(--pip-surface, #fff);
  color: var(--pip-ink, inherit);
  min-width: 0;
}
`;

const ROBOT_SVG = `
<svg class="pip-robot-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path class="robot-spark" d="M12 1v1.5 M11.25 1.75h1.5"/>
  <g class="robot-antenna">
    <path class="robot-antenna-l" d="M12 8V4H8"/>
    <path class="robot-antenna-s" d="M12 8V2"/>
    <path class="robot-antenna-r" d="M12 8V4H16"/>
  </g>
  <rect width="16" height="12" x="4" y="8" rx="2"/>
  <path d="M2 14h2"/>
  <path d="M20 14h2"/>
  <g class="robot-eyes">
    <path class="robot-eye robot-eye-l" d="M9 13v2"/>
    <path class="robot-eye robot-eye-r" d="M15 13v2"/>
  </g>
</svg>`.trim();

let _cssInjected = false;
function injectCss() {
  if (_cssInjected) return;
  const style = document.createElement("style");
  style.setAttribute("data-pip-core", "");
  style.textContent = CSS;
  // Prepend to <head> so host stylesheets (loaded later in document order)
  // cascade-win over the module's defaults on equal specificity.
  document.head.insertBefore(style, document.head.firstChild);
  _cssInjected = true;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Bold/italic/inline code, fenced code blocks, bullet+ordered lists, paragraphs.
// Safety: escHtml first, then only a fixed tag vocabulary is inserted — no
// generic HTML passthrough, no link parsing (not needed; would invite sanitation).
export function renderMd(text) {
  if (text == null) return "";
  let src = escHtml(text);
  src = src.replace(/```(?:[\w-]*)\n?([\s\S]*?)```/g, (_m, code) =>
    `<pre><code>${code.replace(/\n$/, "")}</code></pre>`);
  const lines = src.split("\n");
  const out = [];
  let listTag = null;
  const closeList = () => { if (listTag) { out.push(`</${listTag}>`); listTag = null; } };
  for (const line of lines) {
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul) {
      if (listTag !== "ul") { closeList(); out.push("<ul>"); listTag = "ul"; }
      out.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (listTag !== "ol") { closeList(); out.push("<ol>"); listTag = "ol"; }
      out.push(`<li>${ol[1]}</li>`);
    } else {
      closeList();
      out.push(line);
    }
  }
  closeList();
  src = out.join("\n");
  src = src
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  const blocks = src.split(/\n{2,}/).map(b => {
    const trimmed = b.trim();
    if (!trimmed) return "";
    if (/^<(pre|ul|ol|p)\b/.test(trimmed)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
  });
  return blocks.filter(Boolean).join("\n");
}

// createPip — mounts bubble + panel into `container`, wires open/close/dismiss,
// returns handles + methods for host-layer composition (ambient notify, proactive
// events, tool tracing, slash commands). All transport (ask, tools, executor)
// is injected by the host so this module has no backend knowledge.
export function createPip(opts = {}) {
  const {
    container = document.body,
    ask,
    systemPrompt = "",
    historyLimit = 10,
    introText = "",
    introDismissMs = 7000,
    autoOpen = false,
    autoOpenDelayMs = 700,
    onSubmit = null,            // optional host handler; receives (text, turnApi) — if present, bypasses `ask`
    onSlash = null,             // optional (text) -> { reply?, clearedUI? } | null — intercepts /-prefixed input
    placeholder = "Ask Pip…",
    maxLength = 4000,
    onOpen = null,
    onClose = null,
  } = opts;
  if (!ask && !onSubmit) throw new Error("createPip: require ask() or onSubmit()");

  injectCss();

  const bubble = document.createElement("button");
  bubble.type = "button";
  bubble.className = "pip-bubble";
  bubble.setAttribute("popover", "manual");
  bubble.setAttribute("aria-label", "Open assistant");
  bubble.innerHTML = ROBOT_SVG;

  const panel = document.createElement("div");
  panel.className = "pip-panel";
  panel.setAttribute("popover", "manual");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Assistant");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "pip-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";

  const scroll = document.createElement("div");
  scroll.className = "pip-scroll";

  const notify = document.createElement("div");
  notify.className = "pip-notify";
  if (introText) notify.textContent = introText;
  else notify.hidden = true;

  const turns = document.createElement("div");
  turns.className = "pip-turns";

  scroll.appendChild(notify);
  scroll.appendChild(turns);

  const form = document.createElement("form");
  form.className = "pip-form";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "pip-input";
  input.autocomplete = "off";
  input.placeholder = placeholder;
  input.maxLength = maxLength;
  input.setAttribute("aria-label", placeholder);
  form.appendChild(input);

  panel.appendChild(closeBtn);
  panel.appendChild(scroll);
  panel.appendChild(form);

  container.appendChild(bubble);
  container.appendChild(panel);

  let pending = false;
  let introHandled = false;
  let introTimer = null;
  const history = [];

  const scrollToBottom = () => { scroll.scrollTop = scroll.scrollHeight; };
  const setResponding = (on) => bubble.classList.toggle("responding", !!on);

  function dismissIntro() {
    if (!notify || notify.hidden || notify.classList.contains("dismissing")) return;
    notify.classList.add("dismissing");
    setTimeout(() => {
      notify.hidden = true;
      notify.classList.remove("dismissing");
    }, 420);
  }
  function armIntroTimer() {
    if (introHandled || notify.hidden) return;
    introHandled = true;
    introTimer = setTimeout(dismissIntro, introDismissMs);
  }
  function killIntro() {
    if (introTimer) { clearTimeout(introTimer); introTimer = null; }
    introHandled = true;
    dismissIntro();
  }

  function open({ focus = true } = {}) {
    if (!panel.matches(":popover-open")) panel.showPopover();
    bubble.classList.add("open");
    armIntroTimer();
    if (focus) setTimeout(() => input.focus(), 0);
    if (onOpen) onOpen();
  }
  function close() {
    if (panel.matches(":popover-open")) panel.hidePopover();
    bubble.classList.remove("open");
    setResponding(false);
    if (onClose) onClose();
  }

  bubble.addEventListener("click", () => {
    if (panel.matches(":popover-open")) close();
    else open();
  });
  closeBtn.addEventListener("click", close);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.matches(":popover-open")) close();
  });
  // Capture phase so stopPropagation elsewhere can't swallow the dismiss.
  document.addEventListener("click", (e) => {
    if (!panel.matches(":popover-open")) return;
    if (panel.contains(e.target)) return;
    if (bubble.contains(e.target)) return;
    close();
  }, true);

  function speak(text, { fromAI = false } = {}) {
    if (fromAI) notify.innerHTML = renderMd(text);
    else notify.textContent = text;
    notify.classList.toggle("ai-generated", !!fromAI);
    notify.classList.remove("dismissing");
    notify.hidden = false;
    open({ focus: false });
  }

  function startTurn({ echo = null } = {}) {
    const t = document.createElement("div");
    t.className = "pip-turn";
    if (echo != null) {
      const e = document.createElement("div");
      e.className = "pip-echo";
      e.textContent = `"${echo}"`;
      t.appendChild(e);
    }
    const reply = document.createElement("div");
    reply.className = "pip-reply";
    t.appendChild(reply);
    turns.appendChild(t);
    scrollToBottom();
    return t;
  }

  function setReplyText(turnEl, text, fromAI = false) {
    const reply = turnEl.querySelector(".pip-reply");
    if (!reply) return;
    if (fromAI) reply.innerHTML = renderMd(text);
    else reply.textContent = text;
    reply.classList.toggle("ai-generated", !!fromAI);
    scrollToBottom();
  }

  // Inline ask — render question + option buttons (or free-text input) inside
  // the given turn, await user interaction, remove the block, resolve answer.
  // Host wires this to tool-shape "ask_human" flows + iteration-budget prompts.
  function askInChat({ question, options = [] }, turnEl = null) {
    return new Promise((resolve) => {
      const host = turnEl || turns.lastElementChild;
      if (!host) { resolve(null); return; }
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
          btn.className = "pip-ask-btn";
          btn.textContent = opt;
          btn.addEventListener("click", () => finalize(opt));
          row.appendChild(btn);
        }
        block.appendChild(row);
      } else {
        const af = document.createElement("form");
        af.className = "pip-ask-form";
        const ainput = document.createElement("input");
        ainput.type = "text";
        ainput.className = "pip-ask-input";
        ainput.placeholder = "Your answer…";
        const send = document.createElement("button");
        send.type = "submit";
        send.textContent = "Send";
        af.appendChild(ainput);
        af.appendChild(send);
        af.addEventListener("submit", (e) => {
          e.preventDefault();
          const v = ainput.value.trim();
          if (v) finalize(v);
        });
        block.appendChild(af);
        setTimeout(() => ainput.focus(), 0);
      }

      const reply = host.querySelector(".pip-reply");
      host.insertBefore(block, reply || null);
      scrollToBottom();
    });
  }

  async function submit(text) {
    if (!text || pending) return;
    if (onSlash && text.startsWith("/")) {
      const r = onSlash(text);
      if (r && !r.passThrough) {
        if (r.clearedUI) { scrollToBottom(); return; }
        const t = startTurn({ echo: text });
        if (r.reply) setReplyText(t, r.reply, true);
        return;
      }
    }
    pending = true;
    input.disabled = true;
    killIntro();
    history.push({ role: "user", content: text });
    if (history.length > historyLimit * 2) history.splice(0, history.length - historyLimit * 2);
    const turnEl = startTurn({ echo: text });
    setResponding(true);

    let reply = null;
    try {
      if (onSubmit) {
        reply = await onSubmit(text, { turnEl, history, systemPrompt, setReplyText, askInChat });
      } else {
        reply = await ask(text, { history: history.slice(0, -1), systemPrompt, turnEl, askInChat });
      }
    } catch (err) {
      reply = `(couldn't reach the model: ${err?.message || err})`;
    }

    const final = reply == null
      ? "I can't reach my brain right now — try again in a sec?"
      : reply || "I don't have a good answer for that — tell me more?";
    setReplyText(turnEl, final, reply != null && reply !== "");
    history.push({ role: "assistant", content: final });
    if (history.length > historyLimit * 2) history.splice(0, history.length - historyLimit * 2);

    setResponding(false);
    input.disabled = false;
    pending = false;
    input.focus();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    input.value = "";
    submit(text);
  });

  bubble.showPopover();  // hoist into top layer so the bubble floats above any modal dialog
  if (autoOpen) setTimeout(() => open({ focus: false }), autoOpenDelayMs);

  return {
    bubble, panel, notify, turns, input, form, scroll,
    history,
    open, close,
    speak,
    ask: submit,              // programmatic chat-turn entry
    startTurn,
    setReplyText,
    setResponding,
    askInChat,
    dismissIntro: killIntro,
    isOpen: () => panel.matches(":popover-open"),
    isPending: () => pending,
    destroy() {
      bubble.remove();
      panel.remove();
    },
  };
}
