// Experimental options must gate on both the flag AND the underlying browser API.
const SETTINGS_KEY = "better-robotics:settings";

export const settings = Object.assign(
  // pipBackend: "bridge" (AI Bridge extension, default) | "anthropic" (direct
  //   API call from browser using user-supplied key). Future: "openai", "local".
  // pipApiKey: only used when pipBackend !== "bridge". Stored in localStorage —
  //   browser-only, never leaves origin, but treat like any password (don't
  //   share your browser).
  { passiveScan: false, voice: false, pipBackend: "bridge", pipApiKey: "" },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"),
);

export function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
