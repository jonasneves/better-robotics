// Pip backend dispatch — picks how to reach the LLM based on user setting:
//   github    — GitHub Models inference (default; OAuth via neevs.io,
//               OpenAI-compatible request shape, no API key to manage).
//   bridge    — AI Bridge localhost proxy at 127.0.0.1:7337 (Keychain-backed
//               creds, token never visible to the page). Requires the proxy
//               launchd agent (`make install-proxy` in ai-bridge).
//   anthropic — direct fetch() to api.anthropic.com using the user's API key
//               from settings. Browser-stored, "user's responsibility" model.
//   openai    — direct fetch() to api.openai.com (chat/completions, function-
//               calling). Different protocol from Anthropic; translated below.
import { settings } from "./settings.js";

const BRIDGE_PROXY_URL = "http://127.0.0.1:7337";

// Claude variants available on the bridge + anthropic backends. Short aliases
// are what the user types into `/model`; the id is what goes on the wire.
export const CLAUDE_VARIANTS = [
  { alias: "opus",   id: "claude-opus-4-7" },
  { alias: "sonnet", id: "claude-sonnet-4-6" },
  { alias: "haiku",  id: "claude-haiku-4-5-20251001" },
];
const CLAUDE_DEFAULT = "claude-sonnet-4-6";
const CLAUDE_IDS = new Set(CLAUDE_VARIANTS.map(v => v.id));

function currentClaudeModel() {
  const id = settings.pipClaudeModel;
  return CLAUDE_IDS.has(id) ? id : CLAUDE_DEFAULT;
}

// User-facing model identifier per backend. Single source of truth for
// what name shows up in the Pip placeholder ("Ask Pip… · gpt-4o-mini")
// and in any future model picker. Keeps display logic out of assistant.js
// — model knowledge lives next to the actual API calls.
export function activeModelForBackend(backend) {
  if (backend === "bridge" || backend === "anthropic") return currentClaudeModel();
  if (backend === "openai") return "gpt-4o-mini";
  if (backend === "github") return "gpt-4o-mini";  // strip vendor prefix for display
  return backend;
}
// Per-Claude-call ceiling. Tool-using conversations make several requests in
// series; 20s covers typical Anthropic response time with headroom for slow
// networks and first-request cold-start.
const TIMEOUT_MS = 20000;

// Talks to the AI Bridge localhost proxy. The proxy injects the OAuth token
// and Claude-Max billing header; we just send the bare messages body. Returns
// the same {status, body} | null shape the rest of this file already consumes.
async function bridgeRequest({ path, method, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(BRIDGE_PROXY_URL + path, {
      method: method || "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return { status: resp.status, body: await resp.text() };
  } catch (err) {
    if (err.name === "AbortError") return null;
    return { status: 0, error: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Direct Anthropic API call. Returns the same {status, body} shape bridgeRequest
// uses so the rest of this file doesn't care which transport ran.
// `anthropic-dangerous-direct-browser-access` is required by Anthropic's CORS
// policy to allow fetch() from a browser origin (vs a server). Name is
// intentionally alarming because the alternative — a backend proxy — is the
// industry default for hiding keys; we accept the trade-off because the key
// stays on the user's machine and never crosses our infrastructure.
async function anthropicDirectRequest(body) {
  const key = settings.pipApiKey;
  if (!key) return { status: 401, body: '{"error":"no API key configured in Settings"}' };
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.text() };
  } catch (err) {
    return { status: 0, error: err.message || String(err) };
  }
}

async function callAnthropic(body) {
  if (settings.pipBackend === "anthropic") return anthropicDirectRequest(body);
  return bridgeRequest({ path: "/v1/messages", method: "POST", body });
}

// OpenAI-compatible chat-completions request. Used by two backends:
//   - "openai":  api.openai.com (user's key)
//   - "github":  models.github.ai/inference (GitHub OAuth token; vendor-
//                prefixed model id like "openai/gpt-4o-mini")
// Body shape is identical, only URL + auth + model id differ.
const OPENAI_MODEL = "gpt-4o-mini";        // cheap default for direct OpenAI
const GITHUB_MODEL = "openai/gpt-4o-mini"; // GitHub Models requires vendor prefix
function _activeOpenAiCompatModel() {
  return settings.pipBackend === "github" ? GITHUB_MODEL : OPENAI_MODEL;
}
async function callOpenai(body) {
  // GitHub Models requires the vendor-prefixed model id, so override body.model
  // when calling them.
  const isGithub = settings.pipBackend === "github";
  let url, token;
  if (isGithub) {
    const auth = settings.githubAuth;
    if (!auth?.token) return { status: 401, body: '{"error":"GitHub not signed in — open Settings and Sign in with GitHub"}' };
    url = "https://models.github.ai/inference/chat/completions";
    token = auth.token;
    body = { ...body, model: GITHUB_MODEL };  // override regardless of caller default
  } else {
    const key = settings.pipOpenaiKey;
    if (!key) return { status: 401, body: '{"error":"no OpenAI API key configured in Settings"}' };
    url = "https://api.openai.com/v1/chat/completions";
    token = key;
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.text() };
  } catch (err) {
    return { status: 0, error: err.message || String(err) };
  }
}

// Anthropic tool spec → OpenAI function spec. Anthropic uses
// {name, description, input_schema}; OpenAI wraps as
// {type:"function", function:{name, description, parameters}}.
// Both use JSON Schema for the parameters object so the schema body itself
// transfers verbatim — only the wrapper differs.
function anthropicToolToOpenai(t) {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } };
}

// Anthropic's messages API rejects tool entries with unknown keys (annotations,
// etc). pip-tools.js carries webmcp-style annotations on some tool defs for
// documentation + future external MCP exposure; strip to the API-allowed shape
// before every request so extra metadata doesn't fail the call.
const TOOL_API_FIELDS = ["name", "description", "input_schema", "cache_control"];
function sanitizeTool(t) {
  const out = {};
  for (const k of TOOL_API_FIELDS) if (k in t) out[k] = t[k];
  return out;
}

// Logged after retry exhausted — null/error/non-2xx all mean we won't get
// useful content back. Names the active backend so the message points at the
// right thing to investigate.
function logBackendError(label, res) {
  const b = settings.pipBackend || "github";
  const which = b === "anthropic" ? "anthropic-direct"
              : b === "openai"    ? "openai-direct"
              : b === "github"    ? "github-models"
              :                     "bridge";
  if (!res)           console.info(`[claude/${which}] ${label}: unreachable`);
  else if (res.error) console.warn(`[claude/${which}] ${label}: ${res.error}`);
  else                console.warn(`[claude/${which}] ${label}: HTTP ${res.status}`, res.body?.slice?.(0, 500) ?? res.body);
}

export async function ask(userText, opts = {}) {
  if (settings.pipBackend === "openai" || settings.pipBackend === "github")
    return _openaiAsk(userText, opts);
  return _anthropicAsk(userText, opts);
}

async function _anthropicAsk(userText, { system, maxTokens = 200 } = {}) {
  const res = await callAnthropic({
    model: currentClaudeModel(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userText }],
    stream: false,
  });
  if (!res || res.error) { logBackendError("ask", res); return null; }
  if (res.status < 200 || res.status >= 300) { logBackendError("ask", res); return null; }
  try {
    const json = JSON.parse(res.body);
    // "" is distinct from null — empty means Pip chose silence; null means the call failed.
    return json?.content?.[0]?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

async function _openaiAsk(userText, { system, maxTokens = 200 } = {}) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: userText });
  const res = await callOpenai({
    model: OPENAI_MODEL,
    max_tokens: maxTokens,
    messages,
    stream: false,
  });
  if (!res || res.error) { logBackendError("ask", res); return null; }
  if (res.status < 200 || res.status >= 300) { logBackendError("ask", res); return null; }
  try {
    const json = JSON.parse(res.body);
    return json?.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

// Multi-turn loop that handles Anthropic's tool-use protocol. Sends `messages`
// + `tools`, executes any tool_use blocks via the caller-provided executor,
// loops until Claude returns a text-only reply (stop_reason !== "tool_use") or
// we hit maxIterations. Returns the final text, "" if Claude chose silence,
// or null on transport failure.
//
// Optional hooks for live UI tracing:
//   onToolStart({ name, input })           — fires before each tool dispatch
//   onToolEnd({ name, input, result, error, durationMs }) — after, with outcome
//   shouldAbort() → boolean                — checked between iterations; true
//                                             returns the aborted sentinel
//                                             "(stopped)" so the caller can
//                                             render it as a final reply
//   onMaxIterations() → Promise<number>    — when the iteration budget runs
//                                             out, caller decides whether to
//                                             extend it. Return N>0 to grant
//                                             N more iterations; 0/false to
//                                             stop and return the canned
//                                             "(reached iteration limit)".
export async function askWithTools(messages, opts = {}) {
  if (settings.pipBackend === "openai" || settings.pipBackend === "github")
    return _openaiAskWithTools(messages, opts);
  return _anthropicAskWithTools(messages, opts);
}

async function _anthropicAskWithTools(messages, { system, tools, executor, maxIterations = 10, maxTokens = 1024, onToolStart, onToolEnd, shouldAbort, onMaxIterations } = {}) {
  const convo = [...messages];
  let i = 0;
  let budget = maxIterations;
  while (i < budget) {
    if (shouldAbort?.()) return "(stopped)";
    const res = await callAnthropic({
      model: currentClaudeModel(),
      max_tokens: maxTokens,
      system,
      messages: convo,
      tools: tools?.map(sanitizeTool),
      stream: false,
    });
    if (!res || res.error) { logBackendError("askWithTools", res); return null; }
    if (res.status < 200 || res.status >= 300) { logBackendError("askWithTools", res); return null; }
    let json;
    try { json = JSON.parse(res.body); }
    catch (err) { console.warn("[claude] askWithTools: malformed JSON body", err); return null; }

    convo.push({ role: "assistant", content: json.content });

    if (json.stop_reason !== "tool_use") {
      const text = (json.content || [])
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n")
        .trim();
      return text;  // may be "" — caller decides what to do with silence
    }

    // Execute each tool_use block; pack all results into one user turn.
    const toolUses = json.content.filter(b => b.type === "tool_use");
    const toolResults = [];
    for (const tu of toolUses) {
      const startedAt = performance.now();
      onToolStart?.({ name: tu.name, input: tu.input });
      try {
        const result = await executor(tu.name, tu.input);
        onToolEnd?.({ name: tu.name, input: tu.input, result, error: null, durationMs: performance.now() - startedAt });
        // _pipContent sentinel — micro-protocol any executor can use.
        // Default contract: executor returns a JS object, we JSON-stringify
        // it. Opt-in: executor returns { _pipContent: [...blocks] } where
        // blocks follow Anthropic's tool_result content shape (text +
        // image are the useful ones). Used by view_robot_frame to attach
        // the actual image so Claude's next turn sees pixels, not base64.
        // Future tools that want the same: return { _pipContent: [...] };
        // no plumbing change needed.
        const content = (result && result._pipContent)
          ? result._pipContent
          : JSON.stringify(result);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content,
        });
      } catch (err) {
        const error = String(err.message || err);
        onToolEnd?.({ name: tu.name, input: tu.input, result: null, error, durationMs: performance.now() - startedAt });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ error }),
          is_error: true,
        });
      }
    }
    convo.push({ role: "user", content: toolResults });
    i++;
    if (i >= budget && onMaxIterations) {
      const more = await onMaxIterations();
      if (typeof more === "number" && more > 0) budget += more;
    }
  }
  return "(reached iteration limit)";
}

// OpenAI tool-use loop. Different protocol from Anthropic:
// - system inside messages as {role:"system"}
// - tools wrapped as {type:"function", function:{...}}
// - finish_reason === "tool_calls" instead of stop_reason === "tool_use"
// - tool calls live on assistant.message.tool_calls; arguments is a JSON STRING
// - tool results sent back as {role:"tool", tool_call_id, content}
//
// arguments-as-string requires JSON.parse. Parse failures surface as a
// tool_result instead of crashing the loop.
async function _openaiAskWithTools(messages, { system, tools, executor, maxIterations = 10, maxTokens = 1024, onToolStart, onToolEnd, shouldAbort, onMaxIterations } = {}) {
  const convo = [];
  if (system) convo.push({ role: "system", content: system });
  for (const m of messages) convo.push({ role: m.role, content: m.content });

  let i = 0;
  let budget = maxIterations;
  while (i < budget) {
    if (shouldAbort?.()) return "(stopped)";
    const res = await callOpenai({
      model: OPENAI_MODEL,
      max_tokens: maxTokens,
      messages: convo,
      tools: tools?.map(anthropicToolToOpenai),
      tool_choice: tools?.length ? "auto" : undefined,
      stream: false,
    });
    if (!res || res.error) { logBackendError("askWithTools", res); return null; }
    if (res.status < 200 || res.status >= 300) { logBackendError("askWithTools", res); return null; }
    let json;
    try { json = JSON.parse(res.body); }
    catch (err) { console.warn("[claude/openai] askWithTools: malformed JSON body", err); return null; }

    const choice = json?.choices?.[0];
    const msg = choice?.message;
    if (!msg) { logBackendError("askWithTools", res); return null; }

    // Push assistant's response into the convo VERBATIM — OpenAI requires
    // the same message object back when feeding tool_results, so we can't
    // reshape it.
    convo.push(msg);

    if (choice.finish_reason !== "tool_calls" || !msg.tool_calls?.length) {
      return (msg.content || "").trim();  // "" is silence, same convention as Anthropic
    }

    for (const tc of msg.tool_calls) {
      const name = tc.function?.name;
      let input;
      try { input = JSON.parse(tc.function?.arguments || "{}"); }
      catch (err) { input = { _parseError: String(err.message || err), raw: tc.function?.arguments }; }
      const startedAt = performance.now();
      onToolStart?.({ name, input });
      try {
        const result = await executor(name, input);
        onToolEnd?.({ name, input, result, error: null, durationMs: performance.now() - startedAt });
        convo.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      } catch (err) {
        const error = String(err.message || err);
        onToolEnd?.({ name, input, result: null, error, durationMs: performance.now() - startedAt });
        convo.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error }) });
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
