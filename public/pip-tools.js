import { state } from "./state.js";
import { onOpsResponse } from "./ops-response.js";
import { getLog, getConfig, restartService } from "./capabilities/runtime/command.js";

// One-shot ops-response wait — register, wait for the response that targets
// our robot, unregister. Times out so a dropped response doesn't stall Pip.
function waitOpsResponse(op, robotId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unregister(); reject(new Error(`${op} timed out`)); }, timeoutMs);
    const unregister = onOpsResponse(op, (entry, msg) => {
      if (entry.id !== robotId) return;  // not for us — let other handlers see it
      clearTimeout(timer);
      unregister();
      resolve(msg);
    });
  });
}

export const TOOLS = [
  {
    name: "list_robots",
    description: "Returns the dashboard's known robots: id, name, type (pi|esp32), connection status (idle|connecting|connected|error), and whether Bluetooth is currently paired (so you know whether tool calls that need a BLE link will work).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_robot_state",
    description: "Returns full known state for one robot: fwInfo, wifiStatus (incl. ip), telemetry (uptime_s, mem_free_mb, temp_c), robotStatus (rebooting/installing/etc), capability schema. Cheap — uses already-cached BLE notify state, no new BLE write.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Robot id from list_robots" } },
      required: ["id"],
    },
  },
  {
    name: "get_log",
    description: "Fetches recent journalctl lines from a Pi robot via BLE. Use when diagnosing why a service is failing or to confirm what a robot did recently. Pi only — ESP32 has no journal. ~1-2 sec round trip.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Robot id" },
        lines: { type: "number", description: "Number of lines (default 50, cap 200)" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_config",
    description: "Fetches the robot's pi-robot.conf as JSON via BLE. Useful before suggesting pin or capability changes. Pi only.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Robot id" } },
      required: ["id"],
    },
  },
  {
    name: "restart_service",
    description: "Restarts pi-robot.service on a Pi. BLE drops briefly; the service comes back in ~5-10 sec. Use when a soft hang needs clearing or after a config change. The user will be prompted to confirm before the restart fires.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Robot id" } },
      required: ["id"],
    },
  },
];

export async function executor(name, input) {
  switch (name) {
    case "list_robots": {
      const out = [];
      for (const e of state.devices.values()) {
        out.push({
          id: e.id, name: e.name, type: e.fwType ?? null,
          status: e.status, paired: !!e.device,
        });
      }
      return out;
    }
    case "get_robot_state": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      return {
        id: e.id, name: e.name, type: e.fwType ?? null,
        status: e.status,
        fwInfo: e.fwInfo ?? null,
        wifiStatus: e.wifiStatus ?? null,
        telemetry: e.telemetry ?? null,
        robotStatus: e.robotStatus ?? null,
        capSchema: e.capSchema ?? null,
      };
    }
    case "get_log": {
      const id = input.id;
      const lines = Math.min(Math.max(input.lines || 50, 1), 200);
      const e = state.devices.get(id);
      if (!e) return { error: `no robot with id ${id}` };
      if (!e.opsChar) return { error: "robot doesn't expose the ops channel" };
      const wait = waitOpsResponse("get-log", id, 15000);
      await getLog(id, lines);
      try {
        const msg = await wait;
        return { text: msg.text || "", unit: msg.unit || "pi-robot" };
      } catch (err) {
        return { error: err.message };
      }
    }
    case "get_config": {
      const id = input.id;
      const e = state.devices.get(id);
      if (!e) return { error: `no robot with id ${id}` };
      if (!e.opsChar) return { error: "robot doesn't expose the ops channel" };
      const wait = waitOpsResponse("get-config", id, 10000);
      await getConfig(id);
      try {
        const msg = await wait;
        if (msg.err) return { error: msg.err };
        return { config: msg.text };
      } catch (err) {
        return { error: err.message };
      }
    }
    case "restart_service": {
      const id = input.id;
      const e = state.devices.get(id);
      if (!e) return { error: `no robot with id ${id}` };
      if (!e.opsChar) return { error: "robot doesn't expose the ops channel" };
      // restartService internally calls window.confirm() — kept as-is so an
      // LLM hallucination can't restart a robot without explicit user assent.
      await restartService(id);
      return { ok: true, note: "restart requested (subject to user confirm)" };
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}
