// Talks to Claude through the AI Bridge Chrome extension. The extension injects
// a content script into `*.github.io/*` that proxies to `proxy.neevs.io/anthropic`
// with credentials pulled from Keychain via native messaging — so the browser
// never sees the OAuth token, and pages don't need an extension ID.
//
// Wire protocol (from ai-bridge/bridge-content.js):
//   page → document.dispatchEvent(new CustomEvent('ai-bridge-request', { detail: {...} }))
//   page ← document.addEventListener('ai-bridge-response', e => e.detail)
//
// If the extension isn't installed, nothing answers and the timeout fires —
// ask() returns null and callers fall through to their canned message.

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

// Only called after the retry path has been exhausted, so "null" here really
// does mean the bridge is unreachable — not just transiently busy.
function logBridgeError(label, res) {
  if (!res)           console.info(`[claude] ${label}: bridge unreachable after retry (is AI Bridge installed and running?)`);
  else if (res.error) console.warn(`[claude] ${label}: bridge error`, res.error);
  else                console.warn(`[claude] ${label}: HTTP ${res.status}`, res.body?.slice?.(0, 500) ?? res.body);
}

export async function ask(userText, { system, maxTokens = 200 } = {}) {
  const res = await bridgeRequest({
    type: "proxy",
    provider: "claude",
    path: "/v1/messages",
    method: "POST",
    body: {
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
      stream: false,
    },
  });
  if (!res || res.error) { logBridgeError("ask", res); return null; }
  if (res.status < 200 || res.status >= 300) { logBridgeError("ask", res); return null; }
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
export async function askWithTools(messages, { system, tools, executor, maxIterations = 5, maxTokens = 1024, onToolStart, onToolEnd, shouldAbort } = {}) {
  const convo = [...messages];
  for (let i = 0; i < maxIterations; i++) {
    if (shouldAbort?.()) return "(stopped)";
    const res = await bridgeRequest({
      type: "proxy", provider: "claude", path: "/v1/messages", method: "POST",
      body: {
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: convo,
        tools: tools?.map(sanitizeTool),
        stream: false,
      },
    });
    if (!res || res.error) { logBridgeError("askWithTools", res); return null; }
    if (res.status < 200 || res.status >= 300) { logBridgeError("askWithTools", res); return null; }
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
  }
  return "(reached max tool turns without a final answer — ask again)";
}
