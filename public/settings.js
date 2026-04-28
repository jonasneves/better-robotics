// Experimental options must gate on both the flag AND the underlying browser API.
const SETTINGS_KEY = "better-robotics:settings";

export const settings = Object.assign(
  // pipBackend: "github" (GitHub Models, default — OAuth via neevs.io,
  //   no API key to manage) | "bridge" (AI Bridge Chrome extension,
  //   Keychain-backed creds) | "anthropic" (direct fetch to Anthropic API
  //   with user's key) | "openai" (direct fetch to OpenAI chat
  //   completions with user's key) | "local" (LFM2.5-1.2B-Thinking-ONNX
  //   in-browser).
  // pipApiKey:      Anthropic key — only used when pipBackend === "anthropic".
  // pipOpenaiKey:   OpenAI key    — only used when pipBackend === "openai".
  // pipGithubAuth:  { username, token } from the GitHub OAuth flow — only
  //   used when pipBackend === "github". Connected via the "Connect GitHub"
  //   button in Settings; persists across reloads. Tokens are short-lived;
  //   a 401 surfaces a re-connect prompt.
  // pipLocalInstalled: true once the local model has loaded successfully at
  //   least once. Weights are in IndexedDB cache after that; silent fallback
  //   to local is safe without a surprise download. Flipped by local-llm.js
  //   on its first "ready" state transition.
  // pipVisionEnabled: when true AND the active backend supports images
  //   (Claude via bridge or direct), Pip gets a view_robot_frame tool that
  //   sends the actual camera frame to the backend. Off by default — the
  //   project's baseline story is "frames stay local"; opting in is the
  //   user's call (cost + privacy, per .claude/CLAUDE.md → Model discipline).
  // Keys + tokens stored in localStorage — browser-only, never leaves origin,
  // but treat like passwords (don't share your browser).
  { pipBackend: "github", pipApiKey: "", pipOpenaiKey: "", pipGithubAuth: null, pipLocalInstalled: false, pipVisionEnabled: false },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"),
);

export function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
