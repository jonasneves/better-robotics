// Ops capability — one JSON-command channel for every admin-style action.
// Replaces the scattered per-purpose opcodes (ADMIN_OP_RESTART,
// CAM_OP_INSTALL) with a single op-name vocabulary:
//   restartService(id)     → {op:"restart-service"}
//   installPackage(id,"x") → {op:"install-pkg", args:{name:"x"}}
// Adding a new ops action is one new function here + one new branch in
// pi_robot.py's _ops_handle_write. No new characteristic, no opcode
// allocation, no protocol versioning per feature.
import { OPS_CHAR_UUID } from "../ble.js";
import { logFor } from "../log.js";
import { state } from "../state.js";

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

async function sendOp(entry, msg) {
  if (!entry?.opsChar) return false;
  const bytes = new TextEncoder().encode(JSON.stringify(msg));
  try {
    await entry.opsChar.writeValueWithResponse(bytes);
    return true;
  } catch (err) {
    logFor(entry, `ops write failed: ${err.message}`);
    return false;
  }
}

export async function restartService(id) {
  const entry = state.devices.get(id);
  if (!entry?.opsChar) {
    logFor(entry || { name: "?", lastEvent: null }, "restart unavailable on this robot");
    return;
  }
  if (!confirm(
    `Restart the robot's service?\n\nThis disconnects BLE briefly; the ` +
    `dashboard will reconnect once the service is back (~5–10 s).`
  )) return;
  if (await sendOp(entry, { op: "restart-service" })) {
    logFor(entry, "service restart requested");
  }
}

export async function installPackage(id, name, opts = {}) {
  const entry = state.devices.get(id);
  if (!entry?.opsChar) {
    logFor(entry || { name: "?", lastEvent: null }, "ops unavailable on this robot");
    return;
  }
  if (opts.confirm && !confirm(opts.confirm)) return;
  if (await sendOp(entry, { op: "install-pkg", args: { name } })) {
    logFor(entry, `${name} install requested`);
  }
}

export const ops = {
  name: "ops",
  initEntry: () => ({ opsChar: null }),
  async probe(entry, service) {
    try {
      entry.opsChar = await service.getCharacteristic(OPS_CHAR_UUID);
    } catch {
      entry.opsChar = null;
    }
  },
  cleanup(entry) { entry.opsChar = null; },
  renderSection() { return ""; },
  wireActions() {},
};
