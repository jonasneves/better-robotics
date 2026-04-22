import { state } from "./state.js";
import { onOpsResponse } from "./ops-response.js";
import { getLog, getConfig, restartService } from "./capabilities/runtime/command.js";
import { listPhones, sendToPhone, askHuman } from "./phones.js";
import {
  getLatestScene as getRobotScene,
  isWatching as isWatchingRobot,
  observeOnce,
  captureFrameDataUrl,
} from "./perception.js";
import { detectOnce } from "./grounding.js";
import { wrapExecutor } from "./replay.js";

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
  // Phone-awareness tools (webmcp-style). Listing is read-only and idempotent;
  // sending a notice is open-world (there's no "unsend"), so annotated as
  // non-destructive but not idempotent.
  {
    name: "list_phones",
    description: "Returns phones currently paired with this desktop dashboard (WebRTC). Empty list means nobody's on mobile right now. Pip can check this to know if the user can receive a push notice.",
    input_schema: { type: "object", properties: {}, required: [] },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  // Perception: returns the robot's most recent VLM scene description, if the
  // user has enabled "Watch with Pip" on the camera section. No spatial
  // information (VLM can't localize); treat as semantic "I see X" only.
  {
    name: "get_robot_scene",
    description: "Returns the latest VLM scene description for a robot's camera, plus how many seconds ago it was observed. Only works when the user has enabled 'Watch with Pip' on that robot's camera (otherwise returns {watching:false}). VLM is semantic only — it can say 'I see a wall' but NOT where the wall is in the frame. If a specific detail (color, count, small feature) matters to your answer, cross-check it with ask_robot_scene using a neutrally-framed follow-up.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Robot id" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ask_robot_scene",
    description: "Runs ONE on-demand VLM inference on the robot's current camera frame with a question you supply. Use this to cross-examine a fact from get_robot_scene — VLM sometimes hallucinates (especially colors, small counts), and asking a second, NEUTRALLY-framed question often reveals the hallucination. IMPORTANT: prefer open questions over leading ones: 'what color is the wall?' not 'is the wall brown?'; 'how many doors are visible?' not 'are there two doors?'. Leading prompts prime the VLM and get the same confabulation echoed back. Requires Watch to already be on (model loaded); fails otherwise. Each call spends ~1-1.5s of GPU time, so use sparingly — don't cross-check trivia.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Robot id" },
        question: { type: "string", description: "Neutral, open-ended question about the scene." },
      },
      required: ["id", "question"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "send_to_phone",
    description: "Push a short text notice to a paired phone — shows up in place of the last reply on the phone screen. Use sparingly; it interrupts whatever the phone user was reading.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Phone id from list_phones" },
        text: { type: "string", description: "One short sentence, under 200 chars." },
      },
      required: ["id", "text"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "get_robot_detections",
    description: "Runs an open-vocabulary object detector (OWL-ViT) on the robot's current camera frame and returns bounding boxes for the queries you provide. Use this WHENEVER a decision depends on knowing where-in-the-frame something is — get_robot_scene and ask_robot_scene are text-only and do NOT reliably report left/right/near/far. Prefer this over guessing lateral position from scene captions. Returns {label, score, bbox:{x,y,w,h,cx,cy}} per hit, coordinates normalized to [0,1]: x=0 is left edge, x=1 is right edge, y=0 is top, y=1 is bottom. cx/cy is the center of the box — use cx to decide which way to turn (cx<0.45 = left of center, cx>0.55 = right of center). Empty array means nothing matching was found. Queries should be short concrete noun phrases (up to ~5 per call): 'yellow can', 'doorway', 'chair'. ~1-2s per call; first call after page load triggers a one-time model download (~300-600MB, cached).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Robot id" },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Up to ~5 short concrete noun phrases to locate in the frame.",
        },
      },
      required: ["id", "queries"],
    },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "ask_human_via_phone",
    description: "Ask the paired phone user a question, blocking until they answer or the ask times out (60s default). Preferred over guessing when spatial judgment matters: 'which door should I take?', 'is this the red book you meant?', directional disambiguation during navigation. Attach the robot's current camera frame when it helps the user answer ('include_robot_camera' + 'robot_id'). Provide 'options' for tappable answers when the choice is discrete; omit options to get a free-text response. Returns {answer, timed_out}: answer is the string the user tapped/typed, null if they skipped or timed out.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Phone id from list_phones." },
        question: { type: "string", description: "One short, specific question. Open-ended wording beats leading wording." },
        options: { type: "array", items: { type: "string" }, description: "Up to ~4 tappable answers. Omit or leave empty for a free-text response." },
        include_robot_camera: { type: "boolean", description: "Attach the robot's current camera frame. Default false." },
        robot_id: { type: "string", description: "Robot whose camera to capture. Required when include_robot_camera is true." },
      },
      required: ["id", "question"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
  },
];

async function dispatch(name, input) {
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
    case "list_phones": {
      return listPhones();
    }
    case "get_robot_scene": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      if (!isWatchingRobot(input.id)) return { watching: false };
      const scene = getRobotScene(input.id);
      if (!scene) return { watching: true, text: null };
      return {
        watching: true,
        text: scene.text,
        observed_seconds_ago: Math.round((Date.now() - scene.at) / 1000),
      };
    }
    case "ask_robot_scene": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      if (!isWatchingRobot(input.id)) {
        return { error: "Watch isn't on for this robot — user needs to enable it first (camera card)" };
      }
      const q = String(input.question || "").trim();
      if (!q) return { error: "question is required" };
      try {
        const text = await observeOnce(e, q);
        return { text: text || null };
      } catch (err) {
        return { error: err.message || String(err) };
      }
    }
    case "send_to_phone": {
      const text = String(input.text || "").slice(0, 300);
      const ok = sendToPhone(input.id, text);
      return ok ? { ok: true } : { error: `no phone with id ${input.id}` };
    }
    case "get_robot_detections": {
      const entry = state.devices.get(input.id);
      if (!entry) return { error: `no robot with id ${input.id}` };
      if (!isWatchingRobot(input.id)) {
        return { error: "Watch isn't on for this robot — user needs to enable it first so the camera feed is live" };
      }
      const queries = Array.isArray(input.queries) ? input.queries.map(String).slice(0, 5) : [];
      if (queries.length === 0) return { error: "queries is required (up to 5 short noun phrases)" };
      try {
        const detections = await detectOnce(entry, queries);
        if (detections === null) return { error: "couldn't capture a frame — camera element missing or CORS-tainted" };
        return { detections };
      } catch (err) {
        return { error: `detector failed: ${String(err.message || err)}` };
      }
    }
    case "ask_human_via_phone": {
      const question = String(input.question || "").trim();
      if (!question) return { error: "question is required" };
      const options = Array.isArray(input.options) ? input.options.map(String).slice(0, 8) : [];
      let imageDataUrl = null;
      if (input.include_robot_camera) {
        if (!input.robot_id) return { error: "robot_id is required when include_robot_camera is true" };
        const entry = state.devices.get(input.robot_id);
        if (!entry) return { error: `no robot with id ${input.robot_id}` };
        imageDataUrl = captureFrameDataUrl(entry);
        if (!imageDataUrl) return { error: "couldn't capture a frame — no camera element, feed not started, or CORS-tainted" };
      }
      try {
        return await askHuman(input.id, { question, options, imageDataUrl });
      } catch (err) {
        return { error: String(err.message || err) };
      }
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

// replay.wrapExecutor persists every call (input + output + timing) to
// IndexedDB so a past session can be re-evaluated offline against a new
// prompt or model — comma.ai's replay-your-drive pattern, scoped down.
// Transparent to callers; wrapped executor has the same signature.
export const executor = wrapExecutor(dispatch);
