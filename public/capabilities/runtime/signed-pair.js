// Expected schema shape:
//   { name: "motors", char: "…d99", type: "signed-pair",
//     range: [-100, 100], unit?: "pct", labels?: {left: "L", right: "R"} }
// For name === "motors" the UI is a 2D joypad (throttle + turn, differential
// mixing done client-side) plus a global WASD/arrow-keys listener. Anything
// else falls back to two independent sliders so the raw signed-pair contract
// still serves future non-driving uses (e.g. pan/tilt).
//
// Write path is drop-intermediate-values (latest-intent-wins) because pointer
// moves and keyboard ticks fire faster than BLE writes can complete.
import { UUIDS_BY_CAP } from "../../ble.js";
import { escapeHtml } from "../../dom.js";
import { log, logFor } from "../../log.js";
import { state } from "../../state.js";
import { attachJoypad, mix } from "../../joypad.js";
import { capSection } from "./cap-section.js";

import { renderEntry } from "./render-bus.js";

// Clamp-on-write so callers don't have to check the declared range.
export async function setPairValue(entry, capName, left, right) {
  const ch = entry[`${capName}Char`];
  if (!ch) return;
  const range = entry.capSchema?.find(s => s.name === capName)?.range || [-100, 100];
  const [mn, mx] = range;
  const clamp = (v) => Math.max(mn, Math.min(mx, Math.round(Number(v) || 0)));
  entry[`${capName}Pending`] = [clamp(left), clamp(right)];
  if (entry[`${capName}Sending`]) return;
  entry[`${capName}Sending`] = true;
  try {
    while (entry[`${capName}Pending`]) {
      const [l, r] = entry[`${capName}Pending`];
      entry[`${capName}Pending`] = null;
      try {
        await ch.writeValueWithResponse(Uint8Array.of(l & 0xff, r & 0xff));
      } catch (err) {
        logFor(entry, `${capName} write failed: ${err.message}`);
        break;
      }
    }
  } finally {
    entry[`${capName}Sending`] = false;
  }
}

export function makeSignedPairCap(schema) {
  const { name } = schema;
  const char = schema.char || UUIDS_BY_CAP[name];
  const range = schema.range || [-100, 100];
  const labels = schema.labels || { left: "L", right: "R" };
  const charField = `${name}Char`;
  const leftField = `${name}Left`;
  const rightField = `${name}Right`;
  const actionLeft = `${name}-left`;
  const actionRight = `${name}-right`;
  const actionStop = `${name}-stop`;
  const label = name.length <= 3 ? name.toUpperCase()
    : name[0].toUpperCase() + name.slice(1);
  const isMotors = name === "motors";

  return {
    name,
    schema,
    initEntry: () => ({
      [charField]: null,
      [leftField]: 0, [rightField]: 0,
      [`${name}Sending`]: false, [`${name}Pending`]: null,
    }),

    async probe(entry, service) {
      try {
        entry[charField] = await service.getCharacteristic(char);
        const cur = await entry[charField].readValue();
        entry[leftField] = cur.getInt8(0);
        entry[rightField] = cur.getInt8(1);
        await entry[charField].startNotifications();
        entry[charField].addEventListener("characteristicvaluechanged", (e) => {
          const l = e.target.value.getInt8(0);
          const r = e.target.value.getInt8(1);
          if (l !== entry[leftField] || r !== entry[rightField]) {
            // Log the watchdog-cut transition — safety behavior operators want visible.
            if (l === 0 && r === 0 && (entry[leftField] || entry[rightField])) {
              log(`${name} stopped (watchdog)`, entry.name);
            }
            entry[leftField] = l;
            entry[rightField] = r;
            // Surgical patch — joypad updates fire 5x/s during drag; full
            // renderEntry would flash the whole card and rebuild the joypad
            // mid-drag. Update only the .cap-state text in place.
            const sec = entry.node?.querySelector(`.cap-section[data-cap-name="${name}"]`);
            const stateEl = sec?.querySelector(".cap-state");
            if (stateEl) {
              stateEl.textContent = `${labels.left}: ${l} · ${labels.right}: ${r}`;
            } else {
              renderEntry(entry);
            }
          }
        });
      } catch {
        entry[charField] = null;
      }
    },

    cleanup(entry) {
      entry[charField] = null;
      entry[leftField] = entry[rightField] = 0;
    },

    renderSection(entry, { sourceMember = null, alternativeMemberIds = [] } = {}) {
      if (entry.status !== "connected" || !entry[charField]) return "";
      const stateText = `${labels.left}: ${entry[leftField]} · ${labels.right}: ${entry[rightField]}`;
      const action = `<button class="secondary sm" data-action="${actionStop}">Stop</button>`;
      const body = isMotors
        ? `<div class="joypad-wrap" data-action="motors-joypad">
             <div class="joypad" title="Drag to drive — WASD / arrow keys also work"><div class="joypad-knob"></div></div>
           </div>`
        : `<div class="motor-sliders">
             <label>${escapeHtml(labels.left)} <input type="range" min="${range[0]}" max="${range[1]}" value="${entry[leftField]}" data-action="${actionLeft}"></label>
             <label>${escapeHtml(labels.right)} <input type="range" min="${range[0]}" max="${range[1]}" value="${entry[rightField]}" data-action="${actionRight}"></label>
           </div>`;
      return capSection({ name, label, state: stateText, action, body, sourceMember, alternativeMemberIds });
    },

    wireActions(entry, node) {
      let resetJoypad = null;
      if (isMotors) {
        const pad = node.querySelector(".joypad");
        const knob = pad?.querySelector(".joypad-knob");
        if (pad && knob) resetJoypad = wireJoypad(entry, pad, knob);
      }
      const stop = node.querySelector(`[data-action="${actionStop}"]`);
      if (stop) stop.addEventListener("click", () => {
        // Cancel any in-flight drag first — otherwise the joypad's 200ms
        // heartbeat would re-send the last non-zero values right after this
        // (0, 0) write and Stop would appear broken.
        resetJoypad?.();
        node.querySelectorAll("input[type='range']").forEach(el => { el.value = 0; });
        setPairValue(entry, name, 0, 0);
      });
      if (isMotors) return;
      const l = node.querySelector(`[data-action="${actionLeft}"]`);
      const r = node.querySelector(`[data-action="${actionRight}"]`);
      if (l && r) {
        const onInput = () => setPairValue(entry, name, l.value, r.value);
        l.addEventListener("input", onInput);
        r.addEventListener("input", onInput);
      }
    },
  };
}

// Thin wrapper around the shared joypad module: feeds motor writes for the
// entry. External reset (exposed to the Stop button) ends any in-flight drag
// without emitting its own (0, 0) — Stop button writes that itself.
function wireJoypad(entry, pad, knob) {
  const { reset } = attachJoypad(pad, knob, {
    onDrive: (l, r) => setPairValue(entry, "motors", l, r),
    onStop:  ()     => setPairValue(entry, "motors", 0, 0),
  });
  return reset;
}

// Matches the old sendMotors(id, l, r) shape that gamepad.js calls.
export async function sendPairById(id, capName, left, right) {
  const entry = state.devices.get(id);
  if (entry) await setPairValue(entry, capName, left, right);
}

// LLM pulse-motor write — 4-byte payload [l, r, dur_hi, dur_lo]. Firmware
// parses the wider length as a time-bounded pulse and auto-stops at
// duration. Dashboard-side clamps are defense-in-depth; the firmware
// enforces the actual LLM caps (magnitude 40, duration 2000ms) regardless.
// See .claude/CLAUDE.md → Control-loop invariants.
export async function pulseMotors(id, left, right, durationMs) {
  const entry = state.devices.get(id);
  if (!entry?.motorsChar) return { ok: false, error: "no motors characteristic on this robot" };
  const l = Math.max(-40, Math.min(40, Math.round(Number(left) || 0)));
  const r = Math.max(-40, Math.min(40, Math.round(Number(right) || 0)));
  const d = Math.max(50, Math.min(2000, Math.round(Number(durationMs) || 0)));
  const buf = new Uint8Array(4);
  buf[0] = l & 0xff;
  buf[1] = r & 0xff;
  buf[2] = (d >> 8) & 0xff;
  buf[3] = d & 0xff;
  try {
    await entry.motorsChar.writeValueWithResponse(buf);
    return { ok: true, applied: { l, r, duration_ms: d } };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ─── Keyboard (WASD / arrows) ────────────────────────────────────────────
// Global listener. Sends motor commands to the first connected robot that
// exposes the motors cap. Ignores keydown while a text input / textarea /
// select has focus so dialog text fields still work normally.
const KEY_MAP = {
  "w": "throttle+", "arrowup":    "throttle+",
  "s": "throttle-", "arrowdown":  "throttle-",
  "d": "turn+",     "arrowright": "turn+",
  "a": "turn-",     "arrowleft":  "turn-",
};
const _heldKeys = new Set();
let _keyHoldTimer = null;
let _keyboardWired = false;

export function pickMotorsTarget() {
  // Composite-robot routing: when multiple members of the same robot
  // expose motors, honor the user's per-cap source pref. Falls through
  // to first-connected-with-motors (the prior behavior) when nothing
  // explicit applies — single-robot or no-pref cases.
  for (const r of state.robots?.values?.() || []) {
    const pref = r.capSourcePrefs?.motors;
    if (pref) {
      const e = state.devices.get(pref);
      if (e && e.motorsChar && e.status === "connected") return e;
    }
    // No pref: first member that has motors wins (matches the cap-fan-out
    // dedup in renderEntry, so the phone joypad hits whatever the dashboard
    // is currently showing).
    for (const mid of r.members || []) {
      const e = state.devices.get(mid);
      if (e && e.motorsChar && e.status === "connected") return e;
    }
  }
  return null;
}

function keyboardTick() {
  const entry = pickMotorsTarget();
  if (!entry) return;
  let throttle = 0, turn = 0;
  for (const k of _heldKeys) {
    const axis = KEY_MAP[k];
    if (axis === "throttle+") throttle = 100;
    else if (axis === "throttle-") throttle = -100;
    else if (axis === "turn+") turn = 100;
    else if (axis === "turn-") turn = -100;
  }
  const [l, r] = mix(throttle, turn);
  setPairValue(entry, "motors", l, r);
}

function stopKeyboardMotors() {
  const entry = pickMotorsTarget();
  if (entry) setPairValue(entry, "motors", 0, 0);
}

export function initMotorsKeyboard() {
  if (_keyboardWired) return;
  _keyboardWired = true;

  window.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (!(k in KEY_MAP)) return;
    e.preventDefault();
    if (_heldKeys.has(k)) return;  // ignore OS auto-repeat
    _heldKeys.add(k);
    keyboardTick();
    if (!_keyHoldTimer) _keyHoldTimer = setInterval(keyboardTick, 200);
  });

  window.addEventListener("keyup", (e) => {
    const k = e.key.toLowerCase();
    if (!_heldKeys.has(k)) return;
    _heldKeys.delete(k);
    if (_heldKeys.size === 0) {
      if (_keyHoldTimer) { clearInterval(_keyHoldTimer); _keyHoldTimer = null; }
      stopKeyboardMotors();
    } else {
      keyboardTick();
    }
  });

  // Lost window focus: treat all keys as released so the robot doesn't keep
  // driving into a wall while the user alt-tabs.
  window.addEventListener("blur", () => {
    if (_heldKeys.size === 0) return;
    _heldKeys.clear();
    if (_keyHoldTimer) { clearInterval(_keyHoldTimer); _keyHoldTimer = null; }
    stopKeyboardMotors();
  });
}
