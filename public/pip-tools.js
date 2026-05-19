import { state } from "./state.js";
import { settings } from "./settings.js";
import { waitOpsResponse } from "./ops-response.js";
import { getLog, getConfig, restartService } from "./capabilities/runtime/command.js";
import { listPhones, askHuman } from "./phones.js";
import {
  listHelpers, startHelperCamera, stopHelperCamera, takeHelperSnapshot,
} from "./helpers.js";
import { pulseMotors } from "./capabilities/runtime/signed-pair.js";
import {
  listCameraSources,
  captureFrameDataUrl,
  drawFrameToCanvas,
} from "./camera-frame.js";

// Injected from assistant.js so dispatch can render an in-bubble question
// with options or free-text. Falls back to the phone path; ask_human
// surfaces an error if neither transport is available.
let _askInChat = null;
export function setAskInChatHandler(fn) { _askInChat = fn; }
import { detectOnce, GROUNDING_ENABLED, isGroundingFailed } from "./grounding.js";
import { isMediapipeFailed } from "./mediapipe.js";
import { startWatcher, stopWatcher, ACTION_NAMES, watcherStatus } from "./watcher.js";
import { speak as voiceSpeak } from "./voice.js";

const ALL_TOOLS = [
  {
    name: "list_robots",
    description: "Known robots: id, name, type (pi|esp32), status, paired (BLE).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_robot_state",
    description: "Cached state for one robot: fwInfo, wifiStatus, telemetry, robotStatus, capability schema. No BLE write.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "get_log",
    description: "Recent journalctl lines from a Pi over BLE. Pi only.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        lines: { type: "number", description: "Default 50, cap 200." },
      },
      required: ["id"],
    },
  },
  {
    name: "get_config",
    description: "pi-robot.conf as JSON via BLE. Pi only.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "restart_service",
    description: "Restart pi-robot.service (user confirms). BLE drops ~5-10s.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_phones",
    description: "Phones paired with this dashboard via WebRTC.",
    input_schema: { type: "object", properties: {}, required: [] },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "view_robot_frame",
    description: "Attach one robot camera frame to your next step. Use for fine visual detail (colors, counts, readable text, condition). For spatial position, prefer get_robot_detections — bbox estimates from raw frames are not pixel-accurate.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        camera: { type: "string", description: "'primary' (default) or 'phone'." },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "list_helpers",
    description: "Paired phones available as external camera viewpoints (id 'phone:<id>').",
    input_schema: { type: "object", properties: {}, required: [] },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "take_helper_snapshot",
    description: "One JPEG frame from a paired phone's shared camera. Returns { imageDataUrl, width, height }.",
    input_schema: {
      type: "object",
      properties: {
        helper_id: { type: "string" },
      },
      required: ["helper_id"],
    },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "start_helper_camera",
    description: "Prompt the user to tap Share camera on the phone (desktop can't flip it remotely). Idempotent.",
    input_schema: {
      type: "object",
      properties: {
        helper_id: { type: "string" },
      },
      required: ["helper_id"],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "stop_helper_camera",
    description: "Release the helper's camera. Idempotent.",
    input_schema: {
      type: "object",
      properties: {
        helper_id: { type: "string" },
      },
      required: ["helper_id"],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_robot_detections",
    description: "Open-vocab detector on the robot's camera frame. Returns {label, score, bbox:{x,y,w,h,cx,cy}} per hit; coords normalized to [0,1], x=0 left, y=0 top. cx<0.45 = left of center, cx>0.55 = right of center. Empty array = no match. Per-camera bboxes are not comparable across cameras.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Up to 5 short noun phrases ('yellow can', 'doorway').",
        },
        camera: { type: "string", description: "'primary' (default), 'phone', or 'all'." },
      },
      required: ["id", "queries"],
    },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "move_motor",
    description: "Time-bounded motor pulse: (l, r) speeds in [-100, 100], duration_ms. Firmware caps speed to ±40, duration to [50, 2000] ms, auto-stops at end of window, and clips pure-forward motion when dist_cm < ~15. You decide when to look (view_robot_frame), arm a reflex (start_robot_watcher), or escalate (ask_human) — no executor-imposed observation cadence. Returns { ok, applied:{l,r,duration_ms} } or { ok:false, error }.",
    input_schema: {
      type: "object",
      properties: {
        id:          { type: "string" },
        l:           { type: "number" },
        r:           { type: "number" },
        duration_ms: { type: "number" },
      },
      required: ["id", "l", "r", "duration_ms"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "start_robot_watcher",
    description: "Start a closed-vocab reflex watcher on the robot's camera (MediaPipe COCO, ~10–30ms/frame). Fires the action on first detection of any class in `classes`, then disables itself (fire-once). Use for see→act reflex shapes — e.g. watch for 'stop sign' and 'halt'. Idempotent: starting a new watcher replaces any prior. For one-shot lookup or open-vocab text prompts, use get_robot_detections instead.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        classes: {
          type: "array",
          items: { type: "string" },
          description: "COCO classes (e.g. 'stop sign', 'person', 'traffic light', 'cat'). ~80 classes total.",
        },
        action: {
          type: "string",
          enum: ACTION_NAMES,
          description: "halt = zero-speed motor pulse; speak = announce label; notify = console log. Defaults to halt.",
        },
      },
      required: ["id", "classes"],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "stop_robot_watcher",
    description: "Cancel a running reflex watcher on a robot. Idempotent — safe to call if none is running.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "start_robot_camera",
    description: "Start the camera stream on a robot (synthetic click on the same Start button the user sees on the Camera card). Idempotent — returns success if already running. Required before view_robot_frame, get_robot_detections, or start_robot_watcher have a frame to act on.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "stop_robot_camera",
    description: "Stop the camera stream on a robot. Idempotent — returns success if already stopped.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "speak",
    description: "Say a short message aloud via browser TTS — ambient voice for the human without making them check the chat. Use for findings ('I see a stop sign'), completion signals ('done — three loops'), or important asks. Don't narrate tool calls or restate chat replies. Keep utterances under ~15 words. Returns immediately; audio plays asynchronously and cancels any prior utterance still speaking.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to say. Short, declarative, no markdown." },
      },
      required: ["text"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "ask_human",
    description: "Blocking question to the user (60s). Routes to a paired phone if available, otherwise inline buttons in chat. Provide options for tappable answers; omit for free text. Returns {answer, timed_out, via}.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" }, description: "Up to ~4 tappable answers." },
        prefer: { type: "string", enum: ["phone", "chat"] },
        phone_id: { type: "string" },
        include_robot_camera: { type: "boolean", description: "Attach robot camera frame (phone transport only)." },
        robot_id: { type: "string", description: "Required when include_robot_camera is true." },
      },
      required: ["question"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
  },
];

// Hide disabled tools from Pip so it doesn't waste tokens proposing calls
// that would fail. Keeping the executor case below (unreachable when the
// tool isn't advertised) means re-enabling is a single flag flip in
// grounding.js, not a re-plumb.
// Backends that accept image blocks in tool_result content. OpenAI's
// tool-result image support is untested here so gated out until verified
// end-to-end.
const VISION_BACKENDS = new Set(["bridge", "anthropic"]);
export function isVisionAvailable() {
  return !!settings.pipVisionEnabled && VISION_BACKENDS.has(settings.pipBackend || "bridge");
}

// Dynamic per-call so runtime toggles (Settings → Pip vision) take effect
// without a page reload. GROUNDING_ENABLED is still a module-load constant;
// pipVisionEnabled comes from settings and can flip between asks.
export function getTools() {
  return ALL_TOOLS.filter(t => {
    if (t.name === "get_robot_detections" && (!GROUNDING_ENABLED || isGroundingFailed())) return false;
    if ((t.name === "start_robot_watcher" || t.name === "stop_robot_watcher") && isMediapipeFailed()) return false;
    if (t.name === "view_robot_frame" && !isVisionAvailable()) return false;
    return true;
  });
}

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
      const now = Date.now();
      const telAge = e.telemetryUpdatedAt ? now - e.telemetryUpdatedAt : null;
      const motorAge = e.lastMotorActionAt ? now - e.lastMotorActionAt : null;
      // motion_invalidated: true when a motor pulse fired AFTER the last
      // telemetry sample, so dist_cm reflects pre-motion state. Tie
      // staleness to the event, not a wall-clock TTL — survives Claude's
      // weak time arithmetic (per "Temporally Blind" research).
      const motion_invalidated = !!(
        e.telemetryUpdatedAt && e.lastMotorActionAt
        && e.lastMotorActionAt > e.telemetryUpdatedAt
      );
      return {
        id: e.id, name: e.name, type: e.fwType ?? null,
        status: e.status,
        fwInfo: e.fwInfo ?? null,
        wifiStatus: e.wifiStatus ?? null,
        telemetry: e.telemetry ?? null,
        telemetry_age_ms: telAge,
        since_last_motor_action_ms: motorAge,
        motion_invalidated,
        robotStatus: e.robotStatus ?? null,
        capSchema: e.capSchema ?? null,
        now_ms: now,
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
    case "view_robot_frame": {
      if (!isVisionAvailable()) return { error: "vision is disabled or backend doesn't support images" };
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      // 640px / 0.85 q is larger than ask_human's 320 / 0.75 — Claude's
      // vision wants detail, phone thumbnails don't. PNG would bloat the
      // tool-result payload without a useful accuracy bump.
      const camera = String(input.camera || "primary").toLowerCase();
      const sources = listCameraSources(e);
      const pick = sources.find(s => s.label === camera);
      if (!pick) {
        return { error: `no camera '${camera}' on this robot. available: ${sources.map(s => s.label).join(", ") || "(none)"}` };
      }
      const canvas = drawFrameToCanvas(e, 640, pick.element);
      const dataUrl = canvas ? canvas.toDataURL("image/jpeg", 0.85) : null;
      if (!dataUrl) return { error: "no camera frame available — is the camera card streaming?" };
      const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(dataUrl);
      if (!m) return { error: "failed to encode frame" };
      // _pipContent sentinel tells claude.js to pass through as Anthropic
      // content blocks instead of JSON.stringify — so the model sees the
      // actual image, not a base64 string in a JSON blob.
      return {
        _pipContent: [
          { type: "text", text: `Robot camera frame (${camera}, captured now, ${m[1]}).` },
          { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } },
        ],
      };
    }
    case "list_helpers": {
      return listHelpers();
    }
    case "take_helper_snapshot": {
      const id = String(input.helper_id || "");
      if (!id) return { error: "helper_id is required" };
      return takeHelperSnapshot(id);
    }
    case "start_helper_camera": {
      const id = String(input.helper_id || "");
      if (!id) return { error: "helper_id is required" };
      return await startHelperCamera(id);
    }
    case "stop_helper_camera": {
      const id = String(input.helper_id || "");
      if (!id) return { error: "helper_id is required" };
      return await stopHelperCamera(id);
    }
    case "get_robot_detections": {
      const entry = state.devices.get(input.id);
      if (!entry) return { error: `no robot with id ${input.id}` };
      const queries = Array.isArray(input.queries) ? input.queries.map(String).slice(0, 5) : [];
      if (queries.length === 0) return { error: "queries is required (up to 5 short noun phrases)" };
      const camera = String(input.camera || "primary").toLowerCase();
      const sources = listCameraSources(entry);
      try {
        if (camera === "all") {
          const detections_by_camera = {};
          for (const src of sources) {
            const dets = await detectOnce(entry, queries, { source: src.element });
            if (dets === null) {
              const why = isGroundingFailed()
                ? "detector unavailable this session (WebGPU/model init failed)"
                : `couldn't capture a frame from camera '${src.label}'`;
              return { error: why };
            }
            detections_by_camera[src.label] = dets;
          }
          return { detections_by_camera };
        }
        const pick = sources.find(s => s.label === camera);
        if (!pick) {
          return { error: `no camera '${camera}' on this robot. available: ${sources.map(s => s.label).join(", ") || "(none)"}` };
        }
        const detections = await detectOnce(entry, queries, { source: pick.element });
        if (detections === null) {
          const why = isGroundingFailed()
            ? "detector unavailable this session (WebGPU/model init failed — check browser console)"
            : "couldn't capture a frame — camera element missing or Watch off";
          return { error: why };
        }
        return { detections };
      } catch (err) {
        return { error: `detector failed: ${String(err.message || err)}` };
      }
    }
    case "start_robot_watcher": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      const classes = Array.isArray(input.classes) ? input.classes.map(String).map(s => s.trim()).filter(Boolean) : [];
      if (classes.length === 0) return { error: "classes is required (e.g. ['stop sign'])" };
      const action = ACTION_NAMES.includes(input.action) ? input.action : "halt";
      startWatcher(e, { classes, action });
      return { ok: true, watching: classes, action };
    }
    case "stop_robot_watcher": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      stopWatcher(e);
      const status = watcherStatus(e);
      return { ok: true, status };
    }
    case "move_motor": {
      // Each pulse is firmware-bounded (speed ±40, duration 50–2000 ms,
      // watchdog auto-stop, dist_cm forward-clip). The planner decides
      // when to look or ask for help — no executor-imposed observation
      // cadence between pulses. Stamp the action so subsequent
      // get_robot_state returns can flag motion-invalidated telemetry.
      const e = state.devices.get(input.id);
      if (e) e.lastMotorActionAt = Date.now();
      return await pulseMotors(input.id, input.l, input.r, input.duration_ms);
    }
    case "start_robot_camera": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      const node = e.node;
      if (!node) return { error: `robot ${input.id} has no rendered card` };
      // Synthetic click on the same Camera "Start" button the user sees —
      // same code path, same UI state transitions. Idempotent: if a Stop
      // button is present, the stream is already running.
      if (node.querySelector(`[data-action="camera-stop"]`)) {
        return { ok: true, running: true, note: "camera already running" };
      }
      const btn = node.querySelector(`[data-action="camera-start"]`);
      if (!btn) {
        return { error: "no camera-start button found — robot may not have a camera capability, or camera firmware support isn't installed yet" };
      }
      btn.click();
      return { ok: true, started: true };
    }
    case "stop_robot_camera": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      const node = e.node;
      if (!node) return { error: `robot ${input.id} has no rendered card` };
      if (node.querySelector(`[data-action="camera-start"]`)) {
        return { ok: true, running: false, note: "camera already stopped" };
      }
      const btn = node.querySelector(`[data-action="camera-stop"]`);
      if (!btn) return { error: "no camera-stop button found" };
      btn.click();
      return { ok: true, stopped: true };
    }
    case "speak": {
      const text = String(input.text || "").trim();
      if (!text) return { error: "text is required" };
      voiceSpeak(text);
      return { ok: true };
    }
    case "ask_human": {
      const question = String(input.question || "").trim();
      if (!question) return { error: "question is required" };
      const options = Array.isArray(input.options) ? input.options.map(String).slice(0, 8) : [];

      const phones = listPhones();
      const phoneId = input.phone_id || phones[0]?.id || null;
      const prefer = input.prefer || (phoneId ? "phone" : "chat");

      if (prefer === "phone" && phoneId) {
        let imageDataUrl = null;
        if (input.include_robot_camera) {
          if (!input.robot_id) return { error: "robot_id required for include_robot_camera" };
          const entry = state.devices.get(input.robot_id);
          if (!entry) return { error: `no robot with id ${input.robot_id}` };
          imageDataUrl = captureFrameDataUrl(entry);
          if (!imageDataUrl) return { error: "couldn't capture a frame — feed not started or CORS-tainted" };
        }
        try {
          const r = await askHuman(phoneId, { question, options, imageDataUrl });
          return { ...r, via: "phone" };
        } catch (err) {
          // Phone path failed — try chat fallback before giving up.
          if (!_askInChat) return { error: String(err.message || err), via: "phone" };
        }
      }
      if (!_askInChat) return { error: "no transport available (no phone paired and chat bubble not initialized)" };
      try {
        const answer = await _askInChat({ question, options });
        return { answer, timed_out: false, via: "chat" };
      } catch (err) {
        return { error: String(err.message || err), via: "chat" };
      }
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

export const executor = dispatch;
