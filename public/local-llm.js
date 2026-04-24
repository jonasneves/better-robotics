// LFM2.5-1.2B-Thinking-ONNX in-browser backend for Pip. Loaded lazily — the
// dashboard does not pay the ~1.2 GB Q4 download until the user clicks
// Install in Settings → Pip backend → Local.
//
// Tool calling: per https://docs.liquid.ai/lfm/key-concepts/tool-use we use
// the JSON mode (cleaner to parse than the Pythonic shape). Tool schemas are
// injected into the system prompt; the model emits calls between
// <|tool_call_start|> and <|tool_call_end|> as a JSON array. Reasoning is
// emitted between <think> ... </think> blocks and stripped from the visible
// reply.
//
// Output ceiling: the ONNX export caps generation at 512 new tokens — long
// replies WILL truncate. We do not chunk; surface as a known limit. Any
// downstream prompt that needs more must split the request itself.

// Same CDN + transformers.js version as perception.js / grounding.js — keep
// in sync if perception.js bumps the URL (avoids loading two copies of the
// runtime when both backends are active in the same session).
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

export async function loadModel() {
  if (_model) return;
  if (_loadingPromise) return _loadingPromise;
  setState({ status: "loading", progress: 0, file: "", error: undefined });
  _loadingPromise = (async () => {
    _tf = await import(/* @vite-ignore */ TRANSFORMERS_URL);
    const onProgress = (p) => {
      if (p?.status === "progress") {
        setState({
          status: "loading",
          file: (p.file || "").split("/").pop() || "",
          progress: Math.round(p.progress || 0),
        });
      }
    };
    _tokenizer = await _tf.AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback: onProgress });
    _model = await _tf.AutoModelForCausalLM.from_pretrained(MODEL_ID, {
      device: "webgpu",
      dtype: DTYPE,
      progress_callback: onProgress,
    });
    setState({ status: "ready", progress: 100, file: "" });
  })().catch((err) => {
    _loadingPromise = null;
    _model = null;
    _tokenizer = null;
    setState({ status: "error", error: err?.message || String(err) });
    throw err;
  });
  return _loadingPromise;
}

async function ensureLoaded() {
  if (!_model) await loadModel();
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

export async function localAsk(userText, { system, maxTokens } = {}) {
  void maxTokens;  // model uses fixed MAX_NEW_TOKENS; honoring caller's value is not supported by this ONNX export
  try {
    await ensureLoaded();
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

export async function localAskWithTools(messages, { system, tools, executor, maxIterations = 5, maxTokens, onToolStart, onToolEnd, shouldAbort, onMaxIterations } = {}) {
  void maxTokens;
  try {
    await ensureLoaded();
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
