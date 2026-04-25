// Expected schema shape:
//   { name: "ops", char: "…d9c", type: "command" }
// Op-name vocabulary must match the Pi's `_ops_handle_write` dispatcher.
import { UUIDS_BY_CAP, encodeJson } from "../../ble.js";
import { logFor } from "../../log.js";
import { state } from "../../state.js";

export async function sendCommand(entry, capName, msg) {
  const ch = entry?.[`${capName}Char`];
  if (!ch) return false;
  try {
    await ch.writeValueWithResponse(encodeJson(msg));
    return true;
  } catch (err) {
    logFor(entry, `${capName} write failed: ${err.message}`);
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
  if (await sendCommand(entry, "ops", { op: "restart-service" })) {
    logFor(entry, "service restart requested");
  }
}

export async function rebootRobot(id) {
  const entry = state.devices.get(id);
  if (!entry?.opsChar) return;
  if (!confirm(
    `Reboot the robot?\n\nFull system reboot — needed when a kernel-owned ` +
    `resource is stuck (camera, USB gadget, etc.) and a service restart ` +
    `can't clear it. BLE drops for 30–60 s.`
  )) return;
  if (await sendCommand(entry, "ops", { op: "reboot" })) {
    logFor(entry, "reboot requested");
  }
}

export async function installPackage(id, name, opts = {}) {
  const entry = state.devices.get(id);
  if (!entry?.opsChar) {
    logFor(entry || { name: "?", lastEvent: null }, "ops unavailable on this robot");
    return;
  }
  if (opts.confirm && !confirm(opts.confirm)) return;
  if (await sendCommand(entry, "ops", { op: "install-pkg", args: { name } })) {
    logFor(entry, `${name} install requested`);
  }
}

export async function enrollKey(id, pubkeyLine) {
  const entry = state.devices.get(id);
  if (!entry?.opsChar) return false;
  if (await sendCommand(entry, "ops", { op: "enroll-key", args: { pubkey: pubkeyLine } })) {
    logFor(entry, "enroll requested");
    return true;
  }
  return false;
}

export async function getLog(id, lines = 200, unit = "pi-robot") {
  const entry = state.devices.get(id);
  if (!entry?.opsChar) return false;
  return sendCommand(entry, "ops", { op: "get-log", args: { lines, unit } });
}

export async function getConfig(id) {
  const entry = state.devices.get(id);
  if (!entry?.opsChar) return false;
  return sendCommand(entry, "ops", { op: "get-config" });
}

export function makeCommandCap(schema) {
  const { name } = schema;
  const char = schema.char || UUIDS_BY_CAP[name];
  const charField = `${name}Char`;
  return {
    name,
    schema,
    initEntry: () => ({ [charField]: null }),
    async probe(entry, service) {
      try {
        entry[charField] = await service.getCharacteristic(char);
      } catch {
        entry[charField] = null;
      }
    },
    cleanup(entry) { entry[charField] = null; },
    renderSection() { return ""; },  // commands surface at the menu level, not per-card
    wireActions() {},
  };
}
