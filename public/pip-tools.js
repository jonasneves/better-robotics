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
import { detectOnce, isMediapipeFailed } from "./mediapipe.js";
import { startWatcher, stopWatcher, ACTION_NAMES, watcherStatus, COCO_CLASSES, awaitReflexGate, isReflexGated } from "./watcher.js";
import { speak as voiceSpeak } from "./voice.js";

// Motor-tool gate. Blocks a tool call while the reflex watcher's halt
// gate is engaged (a halt class visible, or a pause gesture held). 10s
// cap so a forgotten trigger can't freeze the planner forever;
// assistant.js's onAbort calls releaseAllGates() to cut through
// immediately when the operator hits Stop. Returns null if motion is
// permitted, or an error object the tool case can return directly. The
// error message includes the actual trigger label (the class or gesture
// that engaged the gate) so the planner doesn't read a hardcoded "stop
// sign" line when a person or a gesture was the real cause.
async function awaitMotorGate(id) {
  if (!isReflexGated(id)) return null;
  const r = await awaitReflexGate(id, { maxMs: 10000 });
  if (r.released === "timeout") {
    const what = r.label || "reflex trigger";
    return { ok: false, error: `reflex: "${what}" blocked motion for 10s — remove the trigger or call ask_human` };
  }
  return null;
}

// Linear-velocity calibration for drive_distance_cm / approach_until.
// Rough first guess: a small wheeled robot at max firmware speed (40)
// covers ~35 cm/sec on flat floor. Tune by driving a known distance
// and timing it; everything else (per-cm ms, max-pulse cm, approach
// step size) derives from this. Lives at module scope so it's
// findable when you decide to recalibrate.
const CM_PER_SEC_AT_40 = 35;

const ALL_TOOLS = [
  {
    name: "list_robots",
    description: "Known robots: id, name, type (pi|esp32), status, paired (BLE).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_robot_state",
    description: "Cached state for one robot: fwInfo, wifiStatus, telemetry, robotStatus, capability schema, plus motion_invalidated (true when telemetry predates the last motor action — re-read before trusting). telemetry.dist_cm = forward ultrasonic distance in cm; firmware silently clips pure-forward motion when dist_cm < ~15 (turns/reverse always pass). No BLE write.",
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
    description: "Closed-vocab detector on the robot's camera frame (MediaPipe COCO, ~80 classes). Returns {label, score, bbox:{x,y,w,h,cx,cy}} per hit; coords normalized to [0,1], x=0 left, y=0 top. cx<0.45 = left of center, cx>0.55 = right of center. Empty array = no class in `queries` was seen (this also means: queries containing non-COCO terms like 'cat feeder' or 'doorway' will always return empty — use only COCO labels like 'person', 'cup', 'cat', 'chair', 'cell phone', 'bottle', 'laptop'). Per-camera bboxes are not comparable across cameras.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Up to 5 COCO class labels ('person', 'cup', 'cat', 'cell phone', 'stop sign'). Non-COCO terms silently return empty.",
        },
        camera: { type: "string", description: "'primary' (default), 'phone', or 'all'." },
      },
      required: ["id", "queries"],
    },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "move_motor",
    description: "Time-bounded motor pulse: (l, r) speeds in [-100, 100], duration_ms in [50, 2000]. Firmware caps speed to ±40, auto-stops at end of window, and clips pure-forward motion when dist_cm < ~15. Returns { ok, applied:{l,r,duration_ms} } or { ok:false, error }. PREFER drive_distance_cm or approach_until for non-trivial moves — they save 1-2 LLM round-trips per logical action.",
    input_schema: {
      type: "object",
      properties: {
        id:          { type: "string" },
        l:           { type: "number", minimum: -100, maximum: 100 },
        r:           { type: "number", minimum: -100, maximum: 100 },
        duration_ms: { type: "number", minimum: 50, maximum: 2000 },
      },
      required: ["id", "l", "r", "duration_ms"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "drive_distance_cm",
    description: "Drive forward (positive cm) or backward (negative cm) a target distance at fixed speed. Auto-chains move_motor pulses if the distance exceeds one max pulse (~70cm at speed 40). Forward still auto-clips at dist_cm<15 (firmware floor). Returns { ok, requested_cm, executed_pulses, results }. Use when you KNOW how far to go (e.g. 'drive 50cm') — saves a frame+reframe between sub-pulses.",
    input_schema: {
      type: "object",
      properties: {
        id:    { type: "string" },
        cm:    { type: "number", minimum: -300, maximum: 300, description: "Target distance; positive = forward, negative = reverse." },
        speed: { type: "number", minimum: 5,    maximum: 40,  description: "Optional speed magnitude 5-40 (default 40)." },
      },
      required: ["id", "cm"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "approach_until",
    description: "Closed-loop forward approach run inside the executor at ~3 Hz. Drives in pulses, optionally centering on a COCO target between them. Halts on the FIRST of three stop predicates: (a) ultrasonic dist_cm < stop_dist_cm — useful for walls / large flat targets; (b) target bbox area >= stop_bbox_area — the reliable signal for small / short / off-axis targets (bottles, cups) that the ultrasonic cone misses; (c) target lost 3 consecutive frames after being seen — prevents blindly driving past an overshot target. Returns { ok, reason, steps, final_dist_cm, trajectory }. Use INSTEAD of repeated move_motor + view_robot_frame cycles when approaching something.",
    input_schema: {
      type: "object",
      properties: {
        id:             { type: "string" },
        stop_dist_cm:   { type: "number", minimum: 10, maximum: 200, description: "Stop when ultrasonic dist_cm drops below this. Default 20. Often unreliable for short / small targets like bottles or cups; pair with target+stop_bbox_area for those." },
        target:         { type: "string", description: "Optional COCO class to center on ('person', 'cup', 'stop sign', etc.). Omit for pure straight-line approach using dist_cm only." },
        stop_bbox_area: { type: "number", minimum: 0.05, maximum: 0.9, description: "When `target` is set, also stop when its bbox covers this fraction of the frame. Default 0.25 (~half-frame width = close enough by sight). Smaller (~0.1) for distant approach; larger (~0.4) to get very close." },
        max_seconds:    { type: "number", minimum: 1, maximum: 30, description: "Safety cap on total approach time. Default 15." },
        speed:          { type: "number", minimum: 5, maximum: 40, description: "Drive speed magnitude 5-40 (default 40)." },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "start_robot_watcher",
    description: "Start a continuous reflex on the robot's camera. Two model paths: (a) `halt`/`speak`/`notify` actions run MediaPipe COCO closed-vocab object detection on `classes` (~10ms/frame, 3s cool-down between fires); (b) `follow` action runs MediaPipe Gesture Recognizer for hand tracking — `classes` is ignored. Follow always drives toward the hand, speaks any high-confidence gesture aloud (Open_Palm, Closed_Fist, Pointing_Up, Thumb_Up, Victory, ILoveYou), and overrides palm-tracking with a directional spin when the operator points sideways. A [reflex-fire] / [reflex-clear] block appears in your next tool_result when something triggers. Idempotent: a second call replaces any prior. By default halt/follow speak narration aloud — set silent:true if your own logic narrates these events.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        classes: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: COCO_CLASSES },
          description: "One or more COCO-80 class names to watch for. Required even for `follow` action (pass any single class like ['hand'] as a sentinel — the follow loop ignores classes).",
        },
        action: {
          type: "string",
          enum: ACTION_NAMES,
          description: "halt = zero-speed motor pulse + motion gate (Pip's motor tools block until the target leaves frame); speak = announce label; notify = console log; follow = hand-tracking visual servo with gesture commands. Defaults to halt.",
        },
        silent: {
          type: "boolean",
          description: "When true, suppress the watcher's built-in 'stopped, X' / 'resuming' / 'paused' / 'following again' speech. Use this when your own loop announces the events (otherwise both voices race + overlap).",
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
    description: "Say a short phrase aloud via browser TTS — ambient narration so the operator doesn't have to watch the chat. Call this at every major decision point, not just at the end of a turn: starting a multi-step task ('starting the search'), after a notable observation ('found the stop sign'), when changing direction ('trying the kitchen'), on completion ('done — found it'), and important asks ('need help — where next?'). Aim for 3–7 words per utterance — longer reads as a recital. Skip routine state polls and tool-call narration. Returns immediately; cancels any prior utterance still speaking.",
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
// tool isn't advertised) is harmless if mediapipe init recovers later.
// Backends that accept image blocks in tool_result content. OpenAI's
// tool-result image support is untested here so gated out until verified
// end-to-end.
const VISION_BACKENDS = new Set(["bridge", "anthropic"]);
export function isVisionAvailable() {
  return !!settings.pipVisionEnabled && VISION_BACKENDS.has(settings.pipBackend || "bridge");
}

// Dynamic per-call so runtime toggles (Settings → Pip vision) take effect
// without a page reload. All MediaPipe-backed tools (detections + watcher)
// share the same isMediapipeFailed() gate — same model, same failure mode.
export function getTools() {
  return ALL_TOOLS.filter(t => {
    if ((t.name === "get_robot_detections" || t.name === "start_robot_watcher" || t.name === "stop_robot_watcher") && isMediapipeFailed()) return false;
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
      // motion_invalidated: true when a motor pulse fired AFTER the last
      // telemetry sample, so dist_cm reflects pre-motion state. Single
      // boolean — the planner doesn't need to reconstruct it from age
      // fields (the lens audit flagged the prior three-derived-fields
      // shape as the "same fact in three places" anti-pattern). Watcher
      // fire-events flow exclusively through the L2 injection path.
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
      if (queries.length === 0) return { error: "queries is required (up to 5 COCO class labels)" };
      const camera = String(input.camera || "primary").toLowerCase();
      const sources = listCameraSources(entry);
      // MediaPipe's detectOnce takes { classes, source, threshold } and
      // filters the 80-class scan post-detection. Returns null on hard
      // failure, [] on "no class matched" — those mean different things.
      const captureErr = isMediapipeFailed()
        ? "detector unavailable this session (MediaPipe init failed — check browser console)"
        : "couldn't capture a frame — camera not started or video element 0-sized";
      try {
        if (camera === "all") {
          const detections_by_camera = {};
          for (const src of sources) {
            const dets = await detectOnce(entry, { classes: queries, source: src.element });
            if (dets === null) return { error: captureErr };
            detections_by_camera[src.label] = dets;
          }
          return { detections_by_camera };
        }
        const pick = sources.find(s => s.label === camera);
        if (!pick) {
          return { error: `no camera '${camera}' on this robot. available: ${sources.map(s => s.label).join(", ") || "(none)"}` };
        }
        const detections = await detectOnce(entry, { classes: queries, source: pick.element });
        if (detections === null) return { error: captureErr };
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
      const silent = !!input.silent;
      startWatcher(e, { classes, action, silent });
      return { ok: true, watching: classes, action, silent };
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
      const gateErr = await awaitMotorGate(input.id);
      if (gateErr) return gateErr;
      const e = state.devices.get(input.id);
      if (e) e.lastMotorActionAt = Date.now();
      return await pulseMotors(input.id, input.l, input.r, input.duration_ms);
    }
    case "drive_distance_cm": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      const cm = Math.max(-300, Math.min(300, Number(input.cm) || 0));
      if (cm === 0) return { error: "cm must be non-zero" };
      const speed = Math.max(5, Math.min(40, Number(input.speed) || 40));
      const dir = cm > 0 ? 1 : -1;
      // Linear-velocity calibration. Tune CM_PER_SEC_AT_40 if the robot
      // overshoots/undershoots; everything else derives from it. Pulled
      // out of the dispatch so it's findable later.
      const cmPerSec = (speed / 40) * CM_PER_SEC_AT_40;
      const msPerCm = 1000 / cmPerSec;
      // Chain pulses up to the firmware 2000ms cap.
      const pulses = [];
      let remaining = Math.abs(cm);
      while (remaining > 0) {
        const wantMs = Math.round(remaining * msPerCm);
        const ms = Math.min(2000, Math.max(50, wantMs));
        const chunkCm = Math.min(remaining, ms / msPerCm);
        pulses.push({ duration_ms: ms, cm: +chunkCm.toFixed(1) });
        remaining -= chunkCm;
        if (ms < 100) break;  // any tail < 100ms is rounding noise
      }
      e.lastMotorActionAt = Date.now();
      const results = [];
      let executed_cm = 0;
      let gatedAt = null;
      for (const p of pulses) {
        // Check before each chunk — a sign that appears mid-drive halts
        // the chain rather than letting the queued chunks blast through.
        const gateErr = await awaitMotorGate(input.id);
        if (gateErr) { gatedAt = gateErr; break; }
        const r = await pulseMotors(input.id, dir * speed, dir * speed, p.duration_ms);
        results.push(r);
        if (!r?.ok) break;
        executed_cm += p.cm;
        // Wait for the pulse to actually complete on-robot — otherwise
        // the next pulse cancels the in-flight one and motion judders.
        await new Promise(res => setTimeout(res, p.duration_ms + 30));
      }
      return {
        ok: !gatedAt,
        requested_cm: cm,
        executed_cm: +executed_cm.toFixed(1) * dir,
        pulses: pulses.length,
        results,
        ...(gatedAt ? { error: gatedAt.error } : {}),
      };
    }
    case "approach_until": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      const stopDistCm = Math.max(10, Math.min(200, Number(input.stop_dist_cm) || 20));
      const maxSeconds = Math.max(1, Math.min(30, Number(input.max_seconds) || 15));
      const speed = Math.max(5, Math.min(40, Number(input.speed) || 40));
      const target = input.target ? String(input.target).toLowerCase() : null;
      const stopBboxArea = Math.max(0.05, Math.min(0.9, Number(input.stop_bbox_area) || 0.25));
      const startedAt = Date.now();
      const trajectory = [];
      let reason = null;
      let lostCount = 0;
      let everSeen = false;
      // Three consecutive misses = target genuinely gone (one miss is
      // common during a turn; two could be a frame race). DJI ActiveTrack
      // / TurtleBot Nav2 use the same N-strike pattern.
      const MAX_LOST = 3;
      // Distinct cap for "never seen it at all" — MediaPipe's closed-vocab
      // detector whiffs on real-world targets (floor-level angle, occlusion,
      // unusual lighting) often enough that streaks of zero hits are common.
      // Without this, never-seen targets scan-spin for the full max_seconds.
      // ~8 ticks × 230ms ≈ 2s before bailing so Pip can tell the user "I
      // can't find it" and try view_robot_frame or ask_human instead.
      const MAX_NEVER_SEEN = 8;
      // Long pulse far away, short pulse when target is already moderately
      // big in frame — keeps us from overshooting the last 20cm when the
      // ultrasonic isn't a reliable stop (small / short / off-axis targets
      // like a bottle that the cone misses while the wall behind reads).
      const drivePulseMsFar  = 1200;
      const drivePulseMsNear = 400;

      while ((Date.now() - startedAt) / 1000 < maxSeconds) {
        // Sign-of-life check on the reflex gate before each approach step.
        // A 10s+ block in here counts against max_seconds rather than
        // extending it — the user's max_seconds budget is what they meant.
        const gateErr = await awaitMotorGate(input.id);
        if (gateErr) { reason = gateErr.error; break; }
        const distCm = e.telemetry?.dist_cm;
        if (typeof distCm === "number" && distCm < stopDistCm) {
          reason = `dist_cm=${distCm} < stop_dist_cm=${stopDistCm}`;
          break;
        }

        let bboxArea = 0;
        let driveMs = drivePulseMsFar;

        // Target-aware path: detect, center, check bbox-area, decide pulse.
        if (target) {
          const sources = listCameraSources(e);
          const primary = sources.find(s => s.label === "primary");
          if (primary) {
            let dets = null;
            try { dets = await detectOnce(e, { classes: [target], source: primary.element }); }
            catch { /* swallow per-iteration; loop guard handles total */ }
            const hit = dets?.[0];
            if (hit) {
              lostCount = 0;
              everSeen = true;
              bboxArea = (hit.bbox?.w ?? 0) * (hit.bbox?.h ?? 0);
              // Stop predicate #2: target fills enough of the frame. This
              // is the reliable "close enough" signal for small objects
              // the ultrasonic cone misses.
              if (bboxArea >= stopBboxArea) {
                reason = `bbox_area=${bboxArea.toFixed(2)} >= stop_bbox_area=${stopBboxArea} (close enough by sight)`;
                break;
              }
              // Adaptive pulse: shorter when target is already biggish.
              if (bboxArea > 0.10) driveMs = drivePulseMsNear;

              const cx = hit.bbox?.cx ?? 0.5;
              if (cx < 0.4 || cx > 0.6) {
                const turnMs = 200;
                const l = cx < 0.4 ? -speed : speed;
                const r = cx < 0.4 ? speed : -speed;
                await pulseMotors(input.id, l, r, turnMs);
                e.lastMotorActionAt = Date.now();
                trajectory.push({ action: cx < 0.4 ? "turn-left" : "turn-right", cx: +cx.toFixed(2), area: +bboxArea.toFixed(2), ms: turnMs });
                await new Promise(res => setTimeout(res, turnMs + 30));
                continue;
              }
            } else {
              // Stop predicate #3: target was seen before but is now lost
              // for N consecutive iterations — almost certainly out-of-
              // frame because we got too close or overshot. Halt before
              // we keep blindly driving past.
              lostCount++;
              if (everSeen && lostCount >= MAX_LOST) {
                reason = `target '${target}' lost (${MAX_LOST} consecutive misses, was seen before — likely overshot or below camera)`;
                break;
              }
              // Stop predicate #4: target was never seen even once. The
              // detector probably can't recognize it at this angle / under
              // this occlusion / in this lighting. No amount of scan-
              // spinning will surface it — bail and let Pip narrate the
              // dead end (try view_robot_frame, reposition, ask_human).
              if (!everSeen && lostCount >= MAX_NEVER_SEEN) {
                reason = `target '${target}' never detected in ${MAX_NEVER_SEEN} scan attempts — MediaPipe's closed-vocab detector likely can't see it at this angle / occlusion / lighting. Try view_robot_frame to confirm it's actually in view, or approach manually with move_motor.`;
                break;
              }
              // Small scan-spin to try re-acquiring; don't drive forward
              // blindly when we just lost the thing we're chasing.
              // Alternate direction every SCAN_FLIP_EVERY misses so we
              // sweep both sides of the FOV instead of rotating one way
              // forever — UBC LTS/LTRA literature on bounded recovery
              // sweeps. Without this the robot would scan-spin left for
              // 15s if the target was to the right.
              const SCAN_FLIP_EVERY = 4;
              const turnMs = 200;
              const turnLeft = Math.floor((lostCount - 1) / SCAN_FLIP_EVERY) % 2 === 0;
              const lMot = turnLeft ? -speed :  speed;
              const rMot = turnLeft ?  speed : -speed;
              await pulseMotors(input.id, lMot, rMot, turnMs);
              e.lastMotorActionAt = Date.now();
              trajectory.push({
                action: turnLeft ? "scan-spin-left" : "scan-spin-right",
                lost_streak: lostCount,
                ms: turnMs,
              });
              await new Promise(res => setTimeout(res, turnMs + 30));
              continue;
            }
          }
        }

        // Forward drive pulse (firmware clips at dist_cm<15 anyway).
        const r = await pulseMotors(input.id, speed, speed, driveMs);
        e.lastMotorActionAt = Date.now();
        trajectory.push({ action: "drive", ms: driveMs, area: +bboxArea.toFixed(2), ok: !!r?.ok });
        if (!r?.ok) { reason = `move_motor failed: ${r?.error || "unknown"}`; break; }
        // Wait for pulse + a small extra so telemetry has a chance to
        // refresh before the next dist_cm read.
        await new Promise(res => setTimeout(res, driveMs + 100));
      }

      if (!reason) reason = `max_seconds=${maxSeconds} reached`;
      return {
        ok: true,
        reason,
        steps: trajectory.length,
        final_dist_cm: e.telemetry?.dist_cm ?? null,
        trajectory,
      };
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
      // Await so the tool returns only after audio has actually
      // finished playing — lets demos chain speak → motion without
      // truncating mid-word. voiceSpeak now returns a Promise that
      // resolves on audio.onended (OpenAI TTS) or utterance.onend
      // (Web Speech). Wrapped in await-then-resolve so we never throw
      // a tool-side error if the playback itself errors.
      await voiceSpeak(text).catch(() => {});
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
