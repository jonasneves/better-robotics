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

function bridgeRequest(detail) {
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
    const timer = setTimeout(() => { cleanup(); resolve(null); }, TIMEOUT_MS);
    document.dispatchEvent(new CustomEvent("ai-bridge-request", { detail: { _id: id, ...detail } }));
  });
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
  if (!res || res.error) return null;
  if (res.status < 200 || res.status >= 300) return null;
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
export async function askWithTools(messages, { system, tools, executor, maxIterations = 5, maxTokens = 1024 } = {}) {
  const convo = [...messages];
  for (let i = 0; i < maxIterations; i++) {
    const res = await bridgeRequest({
      type: "proxy", provider: "claude", path: "/v1/messages", method: "POST",
      body: {
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: convo,
        tools,
        stream: false,
      },
    });
    if (!res || res.error) return null;
    if (res.status < 200 || res.status >= 300) return null;
    let json;
    try { json = JSON.parse(res.body); } catch { return null; }

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
      try {
        const result = await executor(tu.name, tu.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ error: String(err.message || err) }),
          is_error: true,
        });
      }
    }
    convo.push({ role: "user", content: toolResults });
  }
  return "(reached max tool turns without a final answer — ask again)";
}
