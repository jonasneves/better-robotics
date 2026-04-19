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
const TIMEOUT_MS = 8000;

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
