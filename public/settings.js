// Experimental options must gate on both the flag AND the underlying browser API.
const SETTINGS_KEY = "better-robotics:settings";

export const settings = Object.assign(
  { passiveScan: false, voice: false, perception: false },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"),
);

export function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
