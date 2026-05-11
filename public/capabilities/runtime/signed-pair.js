// Schema: { name: "motors", char: "…d99", type: "signed-pair",
//           range: [-100, 100], labels?: {left: "L", right: "R"} }
// For motors: 2D joypad (throttle + turn, client-side differential mix) +
// global WASD/arrows. Anything else gets two sliders so the raw signed-pair
// contract still serves future non-driving uses (pan/tilt).
//
// Drop-intermediate-values write path: pointer moves and keyboard ticks
// fire faster than BLE writes can complete.
import { UUIDS_BY_CAP } from "../../ble.js";
import { escapeHtml } from "../../dom.js";
import { log, logFor } from "../../log.js";
import { state } from "../../state.js";
import { attachJoypad, mix } from "../../joypad.js";
import { capSection } from "./cap-section.js";

import { renderEntry } from "./render-bus.js";

// Clamp-on-write — callers don't have to check declared range.
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
            // Log watchdog-cut transition — safety behavior operators want visible.
            if (l === 0 && r === 0 && (entry[leftField] || entry[rightField])) {
              log(`${name} stopped (watchdog)`, entry.name);
            }
            entry[leftField] = l;
            entry[rightField] = r;
            // Surgical patch — joypad fires 5x/s during drag; full re-render
            // would flash the card and rebuild the joypad mid-drag.
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

    renderSection(entry) {
      if (entry.status !== "connected" || !entry[charField]) return "";
      const stateText = `${labels.left}: ${entry[leftField]} · ${labels.right}: ${entry[rightField]}`;
      const action = `<button class="secondary sm" data-action="${actionStop}">Stop</button>`;
      const body = isMotors
        ? `<div class="joypad-wrap" data-action="motors-joypad">
             <div class="joypad"><div class="joypad-knob"></div></div>
           </div>`
        : `<div class="motor-sliders">
             <label>${escapeHtml(labels.left)} <input type="range" min="${range[0]}" max="${range[1]}" value="${entry[leftField]}" data-action="${actionLeft}"></label>
             <label>${escapeHtml(labels.right)} <input type="range" min="${range[0]}" max="${range[1]}" value="${entry[rightField]}" data-action="${actionRight}"></label>
           </div>`;
      return capSection({ name, label, state: stateText, action, body, transport: "ble" });
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
        // Cancel any in-flight drag — otherwise the joypad's 200ms
        // heartbeat re-sends last non-zero values right after this (0, 0)
        // and Stop appears broken.
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

// External reset (exposed to Stop button) ends any in-flight drag without
// emitting (0, 0) — Stop button writes that itself.
function wireJoypad(entry, pad, knob) {
  const { reset } = attachJoypad(pad, knob, {
    onDrive: (l, r) => setPairValue(entry, "motors", l, r),
    onStop:  ()     => setPairValue(entry, "motors", 0, 0),
  });
  return reset;
}

// Matches the sendMotors(id, l, r) shape gamepad.js calls.
export async function sendPairById(id, capName, left, right) {
  const entry = state.devices.get(id);
  if (entry) await setPairValue(entry, capName, left, right);
}

// LLM pulse — 4-byte [l, r, dur_hi, dur_lo]. Firmware parses the wider
// length as a time-bounded pulse and auto-stops at duration. Dashboard
// clamps are defense-in-depth; firmware enforces the actual caps
// (magnitude 40, duration 2000ms). See .claude/CLAUDE.md → Control-loop
// invariants.
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

// Global WASD/arrows. Sends to the first connected robot with motors.
// Skips keydown when a text input/textarea/select has focus.
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
  // Map.values() insertion order on ties — first-paired wins. Fine with
  // one robot; a footgun with multiple (phone joypad + WASD silently
  // drive whichever was paired first). When multi-robot lands, surface
  // an explicit "active robot" picker or require a target argument.
  for (const e of state.devices.values()) {
    if (e.motorsChar && e.status === "connected") return e;
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
  setPairValue(entry, "motors", throttle, turn);
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

  // Lost window focus → release all keys. Otherwise the robot keeps
  // driving into a wall while the user alt-tabs.
  window.addEventListener("blur", () => {
    if (_heldKeys.size === 0) return;
    _heldKeys.clear();
    if (_keyHoldTimer) { clearInterval(_keyHoldTimer); _keyHoldTimer = null; }
    stopKeyboardMotors();
  });
}
