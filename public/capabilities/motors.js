// Motor capability. Two signed int8 values (left, right) ∈ [-100, 100]. The
// firmware runs a watchdog: every write resets a 500ms timer; silence reverts
// to (0, 0). Safe-default-on-disconnect is a firmware responsibility, not
// something the dashboard enforces.
import { MOTOR_CHAR_UUID } from "../ble.js";
import { log, logFor } from "../log.js";
import { state } from "../state.js";

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

export async function sendMotors(id, left, right) {
  const entry = state.devices.get(id);
  if (!entry || !entry.motorChar) return;
  const clamp = (v) => Math.max(-100, Math.min(100, Math.round(Number(v) || 0)));
  // Drop-intermediate-values: slider input fires faster than BLE writes can
  // complete ("GATT operation already in progress" otherwise). We always queue
  // the latest wanted value; while a write is in flight, newer calls update
  // the pending intent. Latest intent wins.
  entry.motorPending = [clamp(left), clamp(right)];
  if (entry.motorSending) return;
  entry.motorSending = true;
  try {
    while (entry.motorPending) {
      const [l, r] = entry.motorPending;
      entry.motorPending = null;
      try {
        await entry.motorChar.writeValueWithResponse(
          Uint8Array.of(l & 0xff, r & 0xff));
      } catch (err) {
        logFor(entry, `motors write failed: ${err.message}`);
        break;
      }
    }
  } finally {
    entry.motorSending = false;
  }
}

export const motors = {
  name: "motors",
  initEntry: () => ({
    motorChar: null, motorLeft: 0, motorRight: 0,
    motorSending: false, motorPending: null,
  }),

  async probe(entry, service) {
    try {
      entry.motorChar = await service.getCharacteristic(MOTOR_CHAR_UUID);
      const cur = await entry.motorChar.readValue();
      entry.motorLeft = cur.getInt8(0);
      entry.motorRight = cur.getInt8(1);
      await entry.motorChar.startNotifications();
      entry.motorChar.addEventListener("characteristicvaluechanged", (e) => {
        const l = e.target.value.getInt8(0);
        const r = e.target.value.getInt8(1);
        // Notify fires on changes only — most interesting when the watchdog
        // cuts motors to zero after silence.
        if (l !== entry.motorLeft || r !== entry.motorRight) {
          if (l === 0 && r === 0 && (entry.motorLeft || entry.motorRight)) {
            log("motors stopped (watchdog)", entry.name);
          }
          entry.motorLeft = l;
          entry.motorRight = r;
          renderEntry(entry);
        }
      });
    } catch {
      entry.motorChar = null;
    }
  },

  cleanup(entry) {
    entry.motorChar = null;
    entry.motorLeft = entry.motorRight = 0;
  },

  renderSection(entry) {
    if (entry.status !== "connected" || !entry.motorChar) return "";
    return `
      <div class="robot-controls row">
        <div>
          <div class="label">Motors</div>
          <div class="meta">L: ${entry.motorLeft} · R: ${entry.motorRight}</div>
        </div>
        <button class="secondary sm" data-action="motors-stop">Stop</button>
      </div>
      <div class="motor-sliders">
        <label>L <input type="range" min="-100" max="100" value="${entry.motorLeft}" data-action="motor-left"></label>
        <label>R <input type="range" min="-100" max="100" value="${entry.motorRight}" data-action="motor-right"></label>
      </div>
    `;
  },

  wireActions(entry, node) {
    const l = node.querySelector('[data-action="motor-left"]');
    const r = node.querySelector('[data-action="motor-right"]');
    const stop = node.querySelector('[data-action="motors-stop"]');
    if (l && r) {
      const onInput = () => sendMotors(entry.id, l.value, r.value);
      l.addEventListener("input", onInput);
      r.addEventListener("input", onInput);
    }
    if (stop) {
      stop.addEventListener("click", () => {
        if (l) l.value = 0;
        if (r) r.value = 0;
        sendMotors(entry.id, 0, 0);
      });
    }
  },
};
