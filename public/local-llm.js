import { settings, saveSettings } from "./settings.js";
import { showLoading, hideLoading } from "https://cdn.jsdelivr.net/npm/@jonasneves/pip@2.8.1/pip-core.esm.js";

// Loaded lazily — does not pay the ~1.2 GB Q4 download until the user
// clicks Install in Settings → Pip backend → Local.
//
// Tool calling: JSON mode (per https://docs.liquid.ai/lfm/key-concepts/tool-use).
// Tool schemas inject into the system prompt; calls emit between
// <|tool_call_start|> and <|tool_call_end|> as a JSON array. Reasoning
// between <think> ... </think> is stripped from the visible reply.
//
// Output ceiling: ONNX export caps generation at 512 new tokens — long
// replies WILL truncate. No chunking; downstream prompts that need more
// must split the request themselves.

// Keep in sync if perception.js bumps the URL — avoids loading two copies
// of the transformers runtime when both backends are active.
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers";
const MODEL_ID = "LiquidAI/LFM2.5-1.2B-Thinking-ONNX";
const DTYPE = "q4";
const MAX_NEW_TOKENS = 512;

// Tool-call delimiter tokens emitted by LFM2.5 in JSON-mode. Treat as opaque
// strings — the model writes them verbatim into the decoded text.
const TOOL_CALL_START = "<|tool_call_start|>";
const TOOL_CALL_END   = "<|tool_call_end|>";

let _tf = null;
let _tokenizer = null;
let _model = null;
let _loadingPromise = null;

const _state = { status: "idle", progress: 0, file: "", error: undefined };
const _listeners = new Set();

function setState(patch) {
  Object.assign(_state, patch);
  for (const cb of _listeners) {
    try { cb({ ..._state }); } catch (err) { console.warn("[local-llm] listener threw", err); }
  }
}

export function getLoadState() { return { ..._state }; }
export function isLoaded() { return !!_model; }

export function onLoadStateChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

export async function loadModel(turnEl) {
  if (_model) return;
  if (_loadingPromise) return _loadingPromise;
  setState({ status: "loading", progress: 0, file: "", error: undefined });
  if (turnEl) showLoading(turnEl, "loading runtime\u2026", 0);
  _loadingPromise = (async () => {
    _tf = await import(/* @vite-ignore */ TRANSFORMERS_URL);
    const onProgress = (p) => {
      if (p?.status === "progress") {
        const file = (p.file || "").split("/").pop() || "";
        const pct = Math.round(p.progress || 0);
        setState({ status: "loading", file, progress: pct });
        if (turnEl) showLoading(turnEl, `${file} ${pct}%`, pct);
      }
    };
    _tokenizer = await _tf.AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback: onProgress });
    _model = await _tf.AutoModelForCausalLM.from_pretrained(MODEL_ID, {
      device: "webgpu",
      dtype: DTYPE,
      progress_callback: onProgress,
    });
    setState({ status: "ready", progress: 100, file: "" });
    if (turnEl) hideLoading(turnEl);
    // Persist that weights are in IndexedDB now — enables silent fallback
    // from other backends on transport failure (claude.js ask/askWithTools).
    if (!settings.pipLocalInstalled) {
      settings.pipLocalInstalled = true;
      saveSettings();
    }
  })().catch((err) => {
    _loadingPromise = null;
    _model = null;
    _tokenizer = null;
    setState({ status: "error", error: err?.message || String(err) });
    if (turnEl) hideLoading(turnEl);
    throw err;
  });
  return _loadingPromise;
}

async function ensureLoaded(turnEl) {
  if (!_model) await loadModel(turnEl);
}

// Dispose the in-memory runtime and re-init from the IndexedDB cache.
// Useful when the model is wedged after a long session; the weights stay
// cached so the second load is fast (no 1.2 GB download).
export async function reloadModel() {
  _model = null;
  _tokenizer = null;
  _loadingPromise = null;
  setState({ status: "idle", progress: 0, file: "", error: undefined });
  return loadModel();
}

// Strip <think>...</think> reasoning blocks from visible text. The Thinking
// model uses these for chain-of-thought; surface only the final answer.
// MAX_NEW_TOKENS can cut the model off mid-thought — an unclosed <think> has
// no closing tag to match, so strip from the opening tag to end-of-string too.
function stripThinking(text) {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = out.indexOf("<think>");
  if (open !== -1) out = out.slice(0, open);
  return out.trim();
}

// True when the raw output opened a <think> that never closed — i.e. the model
// spent its entire token budget reasoning and never emitted a user-facing
// answer. Callers surface this as a specific fallback so the generic "no good
// answer" branch doesn't mask a recoverable "try a shorter prompt" state.
function thoughtRanLong(raw) {
  return raw.includes("<think>") && !raw.includes("</think>");
}
const OUT_OF_TOKENS_FALLBACK =
  "(local model used all 512 tokens reasoning — try a shorter / simpler prompt)";

// Extract any tool-call JSON arrays from a generated string. May contain
// multiple call blocks; each parses to an array of {name, arguments}. Returns
// a flat list plus the cleaned visible text (with the call blocks removed).
function parseToolCalls(text) {
  const calls = [];
  let visible = text;
  let idx;
  while ((idx = visible.indexOf(TOOL_CALL_START)) !== -1) {
    const end = visible.indexOf(TOOL_CALL_END, idx + TOOL_CALL_START.length);
    if (end === -1) break;
    const inner = visible.slice(idx + TOOL_CALL_START.length, end).trim();
    visible = visible.slice(0, idx) + visible.slice(end + TOOL_CALL_END.length);
    try {
      const parsed = JSON.parse(inner);
      if (Array.isArray(parsed)) calls.push(...parsed);
      else if (parsed && typeof parsed === "object") calls.push(parsed);
    } catch (err) {
      calls.push({ _parseError: String(err.message || err), raw: inner });
    }
  }
  return { calls, visible: stripThinking(visible) };
}

// Anthropic-style tools → LFM2.5 JSON-mode tool schema.
function toolsForSystemPrompt(tools) {
  return (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

function buildSystem(userSystem, tools) {
  const parts = [];
  if (userSystem) parts.push(userSystem);
  if (tools?.length) {
    parts.push(`List of tools: ${JSON.stringify(toolsForSystemPrompt(tools))}`);
    parts.push("Output function calls as JSON.");
  }
  return parts.join("\n\n");
}

async function generate(convo) {
  const inputs = _tokenizer.apply_chat_template(convo, {
    add_generation_prompt: true,
    return_tensors: "pt",
  });
  const outputs = await _model.generate({
    ...(inputs.input_ids ? inputs : { input_ids: inputs }),
    max_new_tokens: MAX_NEW_TOKENS,
    do_sample: false,
  });
  // generate() returns the full sequence including the prompt; slice off the
  // prompt tokens before decoding.
  const promptIds = inputs.input_ids || inputs;
  const promptLen = promptIds.dims ? promptIds.dims.at(-1) : promptIds.length;
  const decoded = _tokenizer.batch_decode(
    outputs.slice(null, [promptLen, null]),
    { skip_special_tokens: false },
  );
  return decoded[0] || "";
}

export async function localAsk(userText, { system, maxTokens, turnEl } = {}) {
  void maxTokens;  // model uses fixed MAX_NEW_TOKENS; honoring caller's value is not supported by this ONNX export
  try {
    await ensureLoaded(turnEl);
  } catch (err) {
    console.warn("[claude/local-llm] ask: load failed", err);
    return null;
  }
  const convo = [];
  if (system) convo.push({ role: "system", content: system });
  convo.push({ role: "user", content: userText });
  try {
    const raw = await generate(convo);
    const visible = stripThinking(raw);
    if (!visible && thoughtRanLong(raw)) return OUT_OF_TOKENS_FALLBACK;
    return visible;
  } catch (err) {
    console.warn("[claude/local-llm] ask: generate failed", err);
    return null;
  }
}

export async function localAskWithTools(messages, { system, tools, executor, maxIterations = 10, maxTokens, onToolStart, onToolEnd, shouldAbort, onMaxIterations, turnEl } = {}) {
  void maxTokens;
  try {
    await ensureLoaded(turnEl);
  } catch (err) {
    console.warn("[claude/local-llm] askWithTools: load failed", err);
    return null;
  }

  const convo = [];
  const sysPrompt = buildSystem(system, tools);
  if (sysPrompt) convo.push({ role: "system", content: sysPrompt });
  for (const m of messages) convo.push({ role: m.role, content: m.content });

  let i = 0;
  let budget = maxIterations;
  while (i < budget) {
    if (shouldAbort?.()) return "(stopped)";
    let raw;
    try { raw = await generate(convo); }
    catch (err) {
      console.warn("[claude/local-llm] askWithTools: generate failed", err);
      return null;
    }
    const { calls, visible } = parseToolCalls(raw);
    convo.push({ role: "assistant", content: raw });

    if (!calls.length) {
      if (!visible && thoughtRanLong(raw)) return OUT_OF_TOKENS_FALLBACK;
      return visible;
    }

    for (const call of calls) {
      const name = call?.name;
      const input = call?.arguments ?? {};
      const startedAt = performance.now();
      onToolStart?.({ name, input });
      try {
        const result = await executor(name, input);
        onToolEnd?.({ name, input, result, error: null, durationMs: performance.now() - startedAt });
        // LFM2.5 expects tool results back as role:"tool" turns. Content is
        // the JSON-stringified result so the model can re-tokenize it cleanly.
        convo.push({ role: "tool", content: JSON.stringify(result) });
      } catch (err) {
        const error = String(err.message || err);
        onToolEnd?.({ name, input, result: null, error, durationMs: performance.now() - startedAt });
        convo.push({ role: "tool", content: JSON.stringify({ error }) });
      }
    }
    i++;
    if (i >= budget && onMaxIterations) {
      const more = await onMaxIterations();
      if (typeof more === "number" && more > 0) budget += more;
    }
  }
  return "(reached iteration limit)";
}
