// Pip backend dispatch — picks how to reach Claude based on user setting:
//   bridge    — AI Bridge Chrome extension (default; Keychain-backed creds,
//               token never visible to the page).
//   anthropic — direct fetch() to api.anthropic.com using the user's API key
//               from settings. Browser-stored, "user's responsibility" model.
// Future:
//   openai    — Phase 2, different protocol (function_calling).
//   local     — Phase 3, LFM2.5-1.2B-Thinking-ONNX via transformers.js,
//               Pythonic-tool-call adapter required.
//
// Both current backends speak Anthropic's /v1/messages protocol so they share
// the same request body shape. Only the transport differs — extracted into
// callAnthropic() below; everything above (ask, askWithTools, sanitizeTool)
// stays untouched.
//
// Wire protocol of the bridge (from ai-bridge/bridge-content.js):
//   page → document.dispatchEvent(new CustomEvent('ai-bridge-request', { detail: {...} }))
//   page ← document.addEventListener('ai-bridge-response', e => e.detail)
import { settings } from "./settings.js";

const MODEL = "claude-sonnet-4-6";
// Per-Claude-call ceiling. Tool-using conversations make several bridgeRequests
// in series (one per tool round); 8s was fine for the no-tools notify path but
// tight for tool loops and cold-start proxy latency. 20s covers typical
// Anthropic response time with headroom for slow networks / first request.
const TIMEOUT_MS = 20000;
// Shorter ceiling for the auto-retry — if the first attempt hung for the full
// 20s we're fairly sure the bridge is wedged, not just slow; a quick retry
// either reaches a recovered bridge or confirms it's gone.
const RETRY_TIMEOUT_MS = 10000;

function bridgeRequestOnce(detail, timeoutMs) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const cleanup = () => {
      document.removeEventListener("ai-bridge-response", onResponse);
      clearTimeout(timer);
    };
    const onResponse = (e) => {
      if (e.detail?._id !== id) return;
      cleanup();
      resolve(e.detail);
    };
    document.addEventListener("ai-bridge-response", onResponse);
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
    document.dispatchEvent(new CustomEvent("ai-bridge-request", { detail: { _id: id, ...detail } }));
  });
}

// One silent retry on null covers the common transient case: bridge extension
// reloaded, network blip to proxy.neevs.io, content script momentarily between
// tabs. If both attempts return null the bridge is really gone — then we log.
async function bridgeRequest(detail) {
  const first = await bridgeRequestOnce(detail, TIMEOUT_MS);
  if (first !== null) return first;
  return await bridgeRequestOnce(detail, RETRY_TIMEOUT_MS);
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

// Single dispatch point — chooses backend per request from current settings.
// Lets the user switch backends mid-session without page reload (next
// askWithTools call picks the new backend). bridgeRequest expects a
// {type:"proxy", provider, path, method, body} envelope; the direct call
// just takes the body. Both return the same {status, body} shape.
async function callAnthropic(body) {
  if (settings.pipBackend === "anthropic") return anthropicDirectRequest(body);
  return bridgeRequest({ type: "proxy", provider: "claude", path: "/v1/messages", method: "POST", body });
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
  const which = settings.pipBackend === "anthropic" ? "anthropic-direct" : "bridge";
  if (!res)           console.info(`[claude/${which}] ${label}: unreachable (${which === "bridge" ? "is AI Bridge installed?" : "no API key configured?"})`);
  else if (res.error) console.warn(`[claude/${which}] ${label}: ${res.error}`);
  else                console.warn(`[claude/${which}] ${label}: HTTP ${res.status}`, res.body?.slice?.(0, 500) ?? res.body);
}

export async function ask(userText, { system, maxTokens = 200 } = {}) {
  const res = await callAnthropic({
    model: MODEL,
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
export async function askWithTools(messages, { system, tools, executor, maxIterations = 5, maxTokens = 1024, onToolStart, onToolEnd, shouldAbort, onMaxIterations } = {}) {
  const convo = [...messages];
  let i = 0;
  let budget = maxIterations;
  while (i < budget) {
    if (shouldAbort?.()) return "(stopped)";
    const res = await callAnthropic({
      model: MODEL,
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
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
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
