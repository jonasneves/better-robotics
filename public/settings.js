// User-tunable feature flags. Persisted in localStorage so toggles survive
// reloads. Experimental options gate on both the flag AND the underlying
// browser API — turning on something Chrome can't deliver is a no-op, not
// a crash. New toggles add their default here and gate their behavior in
// the relevant capability module.
const SETTINGS_KEY = "better-robotics:settings";

export const settings = Object.assign(
  { passiveScan: false, voice: false },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"),
);

export function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
