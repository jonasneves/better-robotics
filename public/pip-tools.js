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
  getLatestScene as getRobotScene,
  isWatching as isWatchingRobot,
  isModelLoaded as isVlmLoaded,
  observeOnce,
  observeAllCameras,
  listCameraSources,
  captureFrameDataUrl,
  drawFrameToCanvas,
  startWatching,
  stopWatching,
} from "./perception.js";

// Injected from assistant.js so dispatch can render an in-bubble question
// with options or free-text. Falls back to the phone path; ask_human
// surfaces an error if neither transport is available.
let _askInChat = null;

// Per-robot timestamps of recent ask_robot_scene calls. Surfacing count
// in the executor return lets Pip see "you've asked N times in the last
// 60s" and escalate to ask_human — anti-loop signal without semantic
// contradiction detection.
const _recentSceneAsks = new Map();
const SCENE_ASK_WINDOW_MS = 60_000;
function trackSceneAsk(robotId) {
  const now = Date.now();
  const arr = (_recentSceneAsks.get(robotId) || []).filter(t => now - t < SCENE_ASK_WINDOW_MS);
  arr.push(now);
  _recentSceneAsks.set(robotId, arr);
  return arr.length;
}

// Consecutive move_motor calls without an intervening scene observation.
// Executor-enforced so the planner can't bypass; reset by any
// get_robot_scene / ask_robot_scene / get_robot_detections /
// view_robot_frame call.
const _pulseRun = new Map();
const PULSE_RUN_LIMIT = 3;
function bumpPulseRun(robotId) {
  const n = (_pulseRun.get(robotId) || 0) + 1;
  _pulseRun.set(robotId, n);
  return n;
}
function resetPulseRun(robotId) { _pulseRun.set(robotId, 0); }
export function setAskInChatHandler(fn) { _askInChat = fn; }
import { detectOnce, GROUNDING_ENABLED, isGroundingFailed } from "./grounding.js";
import { wrapExecutor, getRecentActions } from "./replay.js";

const ALL_TOOLS = [
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
    description: "Returns the latest VLM scene description for a robot's PRIMARY camera, plus how many seconds ago it was observed. Only works when the user has enabled 'Watch with Pip' on that robot's camera (otherwise returns {watching:false}). VLM is semantic only — it can say 'I see a wall' but NOT where the wall is in the frame. If a specific detail (color, count, small feature) matters to your answer, cross-check it with ask_robot_scene. Response also includes `available_cameras`: an array of camera labels the robot currently has (e.g. ['primary','phone'] when a phone helper is mounted on it). When > 1 camera is listed, prefer ask_robot_scene with camera='all' so you get every viewpoint, not just the cached primary one.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Robot id" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "ask_robot_scene",
    description: "Runs ONE on-demand VLM inference per camera the robot has and returns the captions in `cameras: [{label, text}, ...]`. Use to cross-examine a fact from get_robot_scene — VLM sometimes hallucinates (especially colors, small counts), and asking a second, NEUTRALLY-framed question often reveals the hallucination. IMPORTANT: prefer open questions over leading ones: 'what color is the wall?' not 'is the wall brown?'; 'how many doors are visible?' not 'are there two doors?'. Leading prompts prime the VLM and get the same confabulation echoed back. SPATIAL QUESTIONS ARE UNRELIABLE — this is TEXT, not bounding boxes; for left/right/near/far use get_robot_detections; if that's not in your tools, escalate via ask_human. CAMERA SELECTION: pass camera='primary' (default) to inference only the robot's onboard camera, 'phone' for the mounted phone (when present), or 'all' to inference every camera and reason over conflicting captions side-by-side — useful when get_robot_scene's `available_cameras` listed more than one. Response includes `recent_asks`: count of ask_robot_scene calls for this robot in the last 60s. If recent_asks ≥ 3 and you're still uncertain, STOP — call ask_human. Requires Watch to already be on (model loaded); fails otherwise. Each camera spends ~1-1.5s of GPU time, so 'all' on a 2-camera robot is ~3s.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Robot id" },
        question: { type: "string", description: "Neutral, open-ended question about the scene." },
        camera: { type: "string", description: "Camera selector. 'primary' (default), 'phone' (when a phone is mounted), or 'all'." },
      },
      required: ["id", "question"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "view_robot_frame",
    description: "Attaches one of the robot's current camera frames to your next reasoning step so you see the pixels directly — no VLM intermediary. Only in your tool list when the user explicitly enabled it AND the backend supports images. WHEN TO USE (first choice, not last resort): questions about fine visual details the VLM can't reliably capture — specific colors / shades, counts of small items, readable text in the frame, visible condition ('is it dirty', 'are there scratches', 'are there white dots'), identifying one object among visually-similar ones. One frame + your own eyes beats 3 ask_robot_scene follow-ups that the VLM can't answer. WHEN NOT TO USE: ambient 'what's there' (get_robot_scene is cheaper and already runs), precise spatial localization (prefer get_robot_detections — your visual bbox estimates are NOT pixel-accurate), chaining multiple frame views in one turn (one frame per question is the budget — pick primary OR phone, not both, unless the question genuinely depends on cross-camera comparison). Only needs the camera to be streaming (card open, camera connected) — Live scene / Watch is NOT required. CAMERA SELECTION: pass camera='primary' (default) or 'phone' (when a phone is mounted on this robot). Each call sends an image to the backend (cost + network + frames leave the device — the user opted in). Returns the frame as an image attached to the tool result; your next turn sees it natively.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Robot id" },
        camera: { type: "string", description: "'primary' (default) or 'phone' when mounted." },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "list_helpers",
    description: "Returns paired phones the operator has linked (id 'phone:<phoneId>'). Each carries kind, label, status. Use to discover an external viewpoint when the robot has no usable camera, or when a third-party angle would resolve ambiguity.",
    input_schema: { type: "object", properties: {}, required: [] },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "take_helper_snapshot",
    description: "Capture one JPEG frame from a paired phone's shared camera. Use when the robot's onboard camera can't see what matters (occluded, wrong angle, no camera at all) but a phone helper has been pointed at the scene. Returns { imageDataUrl, width, height } on success.",
    input_schema: {
      type: "object",
      properties: {
        helper_id: { type: "string", description: "Helper id from list_helpers ('phone:<phoneId>')." },
      },
      required: ["helper_id"],
    },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "start_helper_camera",
    description: "Surface a hint that the user should tap Share camera on the paired phone. Phone owns its own camera permission; desktop can't flip it on remotely. Idempotent — returns ok if already live.",
    input_schema: {
      type: "object",
      properties: {
        helper_id: { type: "string", description: "Helper id from list_helpers." },
      },
      required: ["helper_id"],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "stop_helper_camera",
    description: "Release the helper's camera. Symmetric with start_helper_camera; idempotent.",
    input_schema: {
      type: "object",
      properties: {
        helper_id: { type: "string", description: "Helper id from list_helpers." },
      },
      required: ["helper_id"],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_robot_detections",
    description: "Runs an open-vocabulary object detector on the robot's current camera frame and returns bounding boxes for the queries you provide. Use this WHENEVER a decision depends on knowing where-in-the-frame something is — get_robot_scene and ask_robot_scene are text-only and do NOT reliably report left/right/near/far. Prefer this over guessing lateral position from scene captions. Returns {label, score, bbox:{x,y,w,h,cx,cy}} per hit, coordinates normalized to [0,1]: x=0 is left edge, x=1 is right edge, y=0 is top, y=1 is bottom. cx/cy is the center of the box — use cx to decide which way to turn (cx<0.45 = left of center, cx>0.55 = right of center). Empty array means nothing matching was found. Queries should be short concrete noun phrases (up to ~5 per call): 'yellow can', 'doorway', 'chair'. ~1-2s per call; first call after page load triggers a one-time model download (~300MB, cached). CAMERA SELECTION: pass camera='primary' (default), 'phone' (when mounted), or 'all' to detect on every camera and return per-camera arrays in `detections_by_camera: { primary: [...], phone: [...] }`. Per-camera bboxes are NOT comparable across cameras (different geometry) — use them to decide which view contains the target, not to triangulate. If the call returns an error, surface the error verbatim and note that the detector runs in the user's browser.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Robot id" },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Up to ~5 short concrete noun phrases to locate in the frame.",
        },
        camera: { type: "string", description: "'primary' (default), 'phone', or 'all'." },
      },
      required: ["id", "queries"],
    },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "move_motor",
    description: "Issues a time-bounded motor pulse on the robot: runs motors at (l, r) for duration_ms milliseconds, then firmware auto-stops. THE ONLY way to move the robot from Pip — there is no persistent-motion equivalent in the LLM tool surface (that's reserved for the human's joystick). Arguments: l and r are signed wheel speeds [-100, 100]; firmware clamps LLM-issued magnitude to ±40 and duration to [50, 2000]ms, so anything outside that range is silently capped. Use short, small pulses for exploratory motion and re-observe the scene after — large commits to a direction without re-checking are how the robot gets stuck or collides. STOPPING RULE: if this is your 3rd+ pulse toward the same target without a clear scene change between, you are stuck — stop calling this and escalate via ask_human. Iteration-limit crashes mean the planner loop didn't notice the loop; the stopping rule exists to prevent that. Not acknowledged (fire-and-forget); returns { ok, applied:{l,r,duration_ms} } with the actually-sent values or { ok:false, error }.",
    input_schema: {
      type: "object",
      properties: {
        id:          { type: "string", description: "Robot id" },
        l:           { type: "number", description: "Left motor speed [-100, 100]. Firmware-capped to ±40." },
        r:           { type: "number", description: "Right motor speed [-100, 100]. Firmware-capped to ±40." },
        duration_ms: { type: "number", description: "Pulse length in ms. Firmware-capped to [50, 2000]." },
      },
      required: ["id", "l", "r", "duration_ms"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "ask_human",
    description: "Ask the human user a question, blocking until they answer (60s default). Routes to a paired phone if one is available (better UX — they're holding it), otherwise renders the question as buttons inline in the dashboard chat bubble. Preferred over guessing when spatial judgment matters: 'which door should I take?', 'is this the red book you meant?'. Provide 'options' for tappable answers; omit options to get a free-text response. Optionally attach a robot camera frame ('include_robot_camera' + 'robot_id') when the question is visual. Returns {answer, timed_out, via}: answer is the string the user tapped/typed, null on skip/timeout; via is 'phone' or 'chat'.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "One short, specific question. Open-ended wording beats leading wording." },
        options: { type: "array", items: { type: "string" }, description: "Up to ~4 tappable answers. Omit or leave empty for a free-text response." },
        prefer: { type: "string", enum: ["phone", "chat"], description: "Force a transport. Default: phone if paired, chat otherwise." },
        phone_id: { type: "string", description: "Specific phone id from list_phones. Default: first paired phone." },
        include_robot_camera: { type: "boolean", description: "Attach the robot's current camera frame (phone transport only). Default false." },
        robot_id: { type: "string", description: "Robot whose camera to capture. Required when include_robot_camera is true." },
      },
      required: ["question"],
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "start_live_scene",
    description: "Turn on continuous in-browser VLM observation of a robot's camera. Once on, frames get a one-sentence scene description every few seconds. Use when ongoing situational awareness matters across several upcoming reasoning steps. Cheap to leave on briefly; stop with stop_live_scene when no longer earning the CPU cost.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Robot id from list_robots." } },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "stop_live_scene",
    description: "Turn off continuous VLM observation for a robot. Idempotent — safe to call when not running.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Robot id from list_robots." } },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_recent_actions",
    description: "Recall the last N tool calls this session made. Use when the user asks 'what did you just try' or when you need to avoid repeating something that failed.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "How many recent actions to return (default 5, max 50).", default: 5 },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
  },
];

// Hide disabled tools from Pip so it doesn't waste tokens proposing calls
// that would fail. Keeping the executor case below (unreachable when the
// tool isn't advertised) means re-enabling is a single flag flip in
// grounding.js, not a re-plumb.
// Backends that accept image blocks in tool_result content. Local LFM has
// no vision; OpenAI's tool-result image support is untested here so gated
// out until verified end-to-end.
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
      resetPulseRun(input.id);  // legitimate look-between-moves
      const available_cameras = listCameraSources(e).map(c => c.label);
      if (!scene) return { watching: true, text: null, available_cameras };
      return {
        watching: true,
        text: scene.text,
        observed_seconds_ago: Math.round((Date.now() - scene.at) / 1000),
        available_cameras,
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
      const recent_asks = trackSceneAsk(input.id);
      resetPulseRun(input.id);  // legitimate look-between-moves
      const camera = String(input.camera || "primary").toLowerCase();
      try {
        if (camera === "all") {
          const cameras = await observeAllCameras(e, q);
          return { cameras, recent_asks };
        }
        const sources = listCameraSources(e);
        const pick = sources.find(s => s.label === camera);
        if (!pick) {
          return { error: `no camera '${camera}' on this robot. available: ${sources.map(s => s.label).join(", ") || "(none)"}`, recent_asks };
        }
        const text = camera === "primary"
          ? await observeOnce(e, q)
          : (await observeAllCameras(e, q)).find(c => c.label === camera)?.text;
        return { cameras: [{ label: camera, text: text || null }], recent_asks };
      } catch (err) {
        return { error: err.message || String(err), recent_asks };
      }
    }
    case "view_robot_frame": {
      if (!isVisionAvailable()) return { error: "vision is disabled or backend doesn't support images" };
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      resetPulseRun(input.id);  // legitimate look-between-moves
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
      if (!dataUrl) return { error: "no camera frame available — is Watch on?" };
      const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(dataUrl);
      if (!m) return { error: "failed to encode frame" };
      // _pipContent sentinel tells claude.js to pass through as Anthropic
      // content blocks instead of JSON.stringify — so the model sees the
      // actual image, not a base64 string in a JSON blob.
      return {
        _pipContent: [
          { type: "text", text: `Robot camera frame (${camera}, captured now, ${m[1]}). Use your own eyes — do not ask the VLM to caption this.` },
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
      if (!isWatchingRobot(input.id)) {
        return { error: "Watch isn't on for this robot — user needs to enable it first so the camera feed is live" };
      }
      const queries = Array.isArray(input.queries) ? input.queries.map(String).slice(0, 5) : [];
      if (queries.length === 0) return { error: "queries is required (up to 5 short noun phrases)" };
      resetPulseRun(input.id);  // legitimate look-between-moves
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
    case "move_motor": {
      // Executor-enforced stop after 3 consecutive pulses without an
      // intervening scene observation — making the model unable to bypass
      // what was previously prose. Look-between-moves resets the run.
      const run = bumpPulseRun(input.id);
      if (run > PULSE_RUN_LIMIT) {
        return {
          ok: false,
          error: `stop-rule triggered: ${run - 1} consecutive pulses without an intervening scene check. Call get_robot_scene / ask_robot_scene / get_robot_detections / view_robot_frame, or escalate to ask_human — you're not closing on the target.`,
        };
      }
      return await pulseMotors(input.id, input.l, input.r, input.duration_ms);
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
    case "start_live_scene": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      if (isWatchingRobot(input.id)) return { ok: true, already_watching: true };
      // First-time start downloads a 770 MB VLM — way too long to block a
      // tool turn. Ask the user to toggle it themselves (progress bar is
      // visible on the camera card). After that, the model is cached and
      // future starts are fast, so we execute directly.
      if (!isVlmLoaded()) {
        return { error: "VLM not loaded yet — ask the user to tick 'Live scene' on the camera card once (first start downloads ~770 MB; cached after). After that you can call start_live_scene directly." };
      }
      try {
        e.cameraWatching = true;
        await startWatching(e);
        return { ok: true };
      } catch (err) {
        e.cameraWatching = false;
        return { error: String(err.message || err) };
      }
    }
    case "stop_live_scene": {
      const e = state.devices.get(input.id);
      if (!e) return { error: `no robot with id ${input.id}` };
      stopWatching(input.id);
      e.cameraWatching = false;
      return { ok: true };
    }
    case "get_recent_actions": {
      const limit = Math.min(Math.max(Number(input?.limit) || 5, 1), 50);
      const session = (typeof window !== "undefined") ? window.replaySession : null;
      if (!session) return { error: "replay session id unavailable" };
      const recs = await getRecentActions(session, limit);
      return { text: formatRecentActions(recs) };
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

function formatRecentActions(recs) {
  if (!recs || recs.length === 0) return "0 recent actions.";
  const lines = recs.map((r) => {
    const status = r.error ? `err: ${truncate(String(r.error), 80)}` : "ok";
    const dur = r.durationMs == null ? "?" : `${r.durationMs}ms`;
    const head = `- ${r.name} (${status}, ${dur})`;
    const inStr = compactJson(r.input);
    const outStr = r.error ? "" : compactJson(r.output);
    const tail = outStr ? `${inStr} -> ${outStr}` : inStr;
    return `${head}: ${tail}`;
  });
  return `${recs.length} recent actions (newest first):\n${lines.join("\n")}`;
}

function compactJson(v) {
  if (v === undefined) return "";
  try {
    const s = JSON.stringify(v);
    return truncate(s ?? "", 300);
  } catch {
    return truncate(String(v), 300);
  }
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export const executor = wrapExecutor(dispatch);
