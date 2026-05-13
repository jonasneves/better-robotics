// Experimental options must gate on both the flag AND the underlying browser API.
const SETTINGS_KEY = "better-robotics:settings";

export const settings = Object.assign(
  // pipBackend: "github" (GitHub Models, default — OAuth via auth.neevs.io)
  //   | "bridge" (AI Bridge Chrome extension, Keychain-backed)
  //   | "anthropic" (direct, user's key) | "openai" (direct, user's key)
  //   | "local" (LFM2.5-1.2B-Thinking-ONNX in-browser).
  // pipApiKey:    Anthropic key — only when pipBackend === "anthropic".
  // pipOpenaiKey: OpenAI key    — only when pipBackend === "openai".
  // githubAuth:   { username, token } from GitHub OAuth. Backs BOTH
  //   identity (avatar / robot labels) AND the GitHub Models Pip backend.
  //   One grant, two purposes; sign-out clears both. 401 → re-connect prompt.
  // pipLocalInstalled: true once the local model loaded successfully.
  //   Weights are in IndexedDB; silent fallback to local is safe after
  //   that. Flipped by local-llm.js on first "ready".
  // pipVisionEnabled: when true AND backend supports images, Pip gets
  //   view_robot_frame, sending the actual frame. Off by default —
  //   baseline is "frames stay local"; opt-in is the user's call (cost +
  //   privacy; .claude/CLAUDE.md → Model discipline).
  // Keys + tokens in localStorage — browser-only, never leaves origin,
  // but treat like passwords (don't share your browser).
  // arucoOverheadPhoneId / arucoOverheadLocalId: roomId of the phone, or
  //   deviceId of the local videoinput, designated as the overhead
  //   localizer. Mutually exclusive — only one is non-null at a time.
  // arucoMarkerSizeMm: printed marker side length, used by POS.Posit for
  //   metric pose. Defaults to the printable sheets' size (100 mm).
  { pipBackend: "github", pipApiKey: "", pipOpenaiKey: "", githubAuth: null, pipLocalInstalled: false, pipVisionEnabled: false, arucoOverheadPhoneId: null, arucoOverheadLocalId: null, arucoMarkerSizeMm: 100 },
  (() => {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    // Migration: pipGithubAuth → githubAuth (Identity + Pip share one OAuth
    // grant now). Drop old key so migration fires once.
    if (raw.pipGithubAuth && !raw.githubAuth) {
      raw.githubAuth = raw.pipGithubAuth;
      delete raw.pipGithubAuth;
    }
    return raw;
  })(),
);

export function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
