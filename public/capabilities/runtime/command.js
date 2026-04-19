// Generic typed-characteristic runtime for `command` capabilities.
// One write-only char that accepts JSON commands like {op, args}. No UI
// section (commands are surfaced by callers wherever they make sense —
// menu items, settings, voice, future LLM tool calls).
//
// Expected schema shape:
//   { name: "ops", char: "…d9c", type: "command" }
//
// Generic writer: `sendCommand(entry, capName, msg)`. Named wrappers at
// the bottom (restartService, rebootRobot, installPackage) encode the
// specific op-name vocabulary the Pi's `_ops_handle_write` dispatcher
// understands. Adding a new op is one new wrapper here + one new branch
// on the firmware side — still zero chars, zero opcodes.
import { logFor } from "../../log.js";
import { state } from "../../state.js";

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

export async function sendCommand(entry, capName, msg) {
  const ch = entry?.[`${capName}Char`];
  if (!ch) return false;
  const bytes = new TextEncoder().encode(JSON.stringify(msg));
  try {
    await ch.writeValueWithResponse(bytes);
    return true;
  } catch (err) {
    logFor(entry, `${capName} write failed: ${err.message}`);
    return false;
  }
}

// Named op wrappers — keep the caller-side vocabulary stable while the
// underlying transport migrates. Each wrapper encodes exactly one op name.

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

export function makeCommandCap(schema) {
  const { name, char } = schema;
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
