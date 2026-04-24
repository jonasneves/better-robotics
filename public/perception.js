// Constant-cheap perception loop — runs LFM2.5-VL-450M via Transformers.js
// + WebGPU against a robot's camera feed, every ~2 seconds, and stashes
// the scene description on the entry. Pip can read the latest observation
// via the get_robot_scene tool (pip-tools.js), so she can reason about
// what the robot sees without the user typing anything.
//
// Pattern mirrors ~/Github/jonasneves/catwatcher/app.js — same model, same
// AutoModelForImageTextToText / AutoProcessor sequence, same drawImage
// → getImageData → RawImage capture. Prompt is tuned for indoor-robot
// scenes instead of cats.
//
// Known limits of this VLM (from duke-ai/validation experimentation):
//   - Cannot precisely localize objects (~0% recall@0.3 for bbox detection).
//     Usable for "I see X" semantics, NOT for "turn 12° left to track X".
//   - Hallucinates colors. Don't trust "brown" on a gray thing.
//   - Directive prompts > question prompts. "Describe …" not "Is there …".
//
// Cost envelope:
//   ~770 MB first-time download (q4 quantization), ~1-2 GB VRAM at run,
//   ~1-1.5 s per inference on a modern WebGPU desktop. Zero API spend.
//   The loop only runs while the user explicitly toggles "Watch" on a
//   robot — no idle GPU drain.
import { state } from "./state.js";
import { escapeHtml } from "./dom.js";
import { broadcastSceneToPhones } from "./phones.js";

const MODEL_ID = "LiquidAI/LFM2.5-VL-450M-ONNX";
const DTYPE = { vision_encoder: "fp16", embed_tokens: "fp16", decoder_model_merged: "q4" };
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers";
const POLL_MS = 2000;
const MAX_NEW_TOKENS = 128;
// Prompt discipline: every concrete noun is a subject-candidate the model
// may hallucinate, every additive instruction is a constraint it strains
// against the pixels. Earlier version primed "indoor robot" and produced
// "a small indoor robot with a white body" over a photo of a blanket.
// Two words of corrective bias ("concretely", "visibly present") point at
// the ground truth without nominating subjects.
const DEFAULT_PROMPT = "Describe this image concretely in one short sentence. Name only what is visibly present.";

let _tf = null;
let _model = null;
let _processor = null;
let _loadingPromise = null;

export function isSupported() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

export function isModelLoaded() { return !!_model; }

async function ensureModel(onProgress) {
  if (_model) return;
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = (async () => {
    _tf = await import(/* @vite-ignore */ TRANSFORMERS_URL);
    _model = await _tf.AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
      device: "webgpu",
      dtype: DTYPE,
      progress_callback: onProgress,
    });
    _processor = await _tf.AutoProcessor.from_pretrained(MODEL_ID);
  })();
  try { await _loadingPromise; }
  catch (err) { _loadingPromise = null; throw err; }
}

// Find the camera element this entry is rendering. Either:
//   <img class="robot-camera">     (ESP32 MJPEG — CORS set by firmware)
//   <video data-*-id="${id}">      (Pi WebRTC — MediaStream, always readable)
// One card has at most one of either, so a naive selector within entry.node
// is correct.
function findCameraElement(entry) {
  const node = entry.node;
  if (!node) return null;
  return node.querySelector("img.robot-camera") || node.querySelector("video[data-camera-id], video");
}

function captureFrame(entry, maxDim = 512) {
  const canvas = drawFrameToCanvas(entry, maxDim);
  if (!canvas) return null;
  try { return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height); }
  catch { return null; }
}

// Separate path for "give me this frame as a data URL" — used by ask_human
// to send the robot's view to a paired phone. Smaller default maxDim keeps
// the JPEG under typical WebRTC data-channel message budgets (~60KB).
export function captureFrameDataUrl(entry, maxDim = 320, quality = 0.75) {
  const canvas = drawFrameToCanvas(entry, maxDim);
  if (!canvas) return null;
  try { return canvas.toDataURL("image/jpeg", quality); }
  catch { return null; }
}

export function drawFrameToCanvas(entry, maxDim) {
  const source = findCameraElement(entry);
  if (!source) return null;
  let w = source.naturalWidth || source.videoWidth;
  let h = source.naturalHeight || source.videoHeight;
  if (!w || !h) return null;
  if (Math.max(w, h) > maxDim) {
    const s = maxDim / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  try {
    canvas.getContext("2d").drawImage(source, 0, 0, w, h);
    return canvas;
  } catch {
    // Tainted canvas → firmware didn't serve CORS + the <img> is missing
    // crossOrigin="anonymous". Surface null; caller logs once.
    return null;
  }
}

async function runInference(entry, prompt) {
  const frame = captureFrame(entry);
  if (!frame) return null;
  const image = new _tf.RawImage(frame.data, frame.width, frame.height, 4);
  const messages = [{
    role: "user",
    content: [{ type: "image" }, { type: "text", text: prompt }],
  }];
  const chatPrompt = _processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await _processor(image, chatPrompt, { add_special_tokens: false });
  const outputs = await _model.generate({ ...inputs, do_sample: false, max_new_tokens: MAX_NEW_TOKENS });
  const decoded = _processor.batch_decode(
    outputs.slice(null, [inputs.input_ids.dims.at(-1), null]),
    { skip_special_tokens: true },
  );
  return decoded[0]?.trim() || null;
}

// Bound any await that talks to the GPU — without this, a single slow
// inference freezes every downstream tool call. We can't cancel the GPU
// work from JS (transformers.js has no abort), but we can unblock the
// caller so Pip's turn ends and it can decide what to do next.
const OBSERVE_TIMEOUT_MS = 20000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// On-demand one-shot inference with a caller-specified prompt. Used by Pip
// (via pip-tools' ask_robot_scene) for cross-examination — asking the VLM
// the same thing different ways to beat confirmation bias. Serializes
// against the poll loop so they don't collide on the GPU.
export async function observeOnce(entry, prompt) {
  if (!_model) throw new Error("perception model not loaded — user needs to enable Watch on this robot first");
  const loop = _loops.get(entry.id);
  // If the poll loop is mid-inference, wait for it to finish. One inference
  // at a time on the GPU keeps things predictable. Bounded so a wedged loop
  // tick can't keep observeOnce polling forever.
  if (loop?.running) {
    await withTimeout(new Promise((r) => {
      const check = () => (!loop.running ? r() : setTimeout(check, 100));
      check();
    }), OBSERVE_TIMEOUT_MS, "waiting for poll-loop inference");
  }
  if (loop) loop.running = true;
  try {
    return await withTimeout(runInference(entry, prompt), OBSERVE_TIMEOUT_MS, "VLM inference");
  } finally {
    if (loop) loop.running = false;
  }
}

// id → { timer, running, onScene, onError }
const _loops = new Map();

export function isWatching(id) { return _loops.has(id); }

export function getLatestScene(id) {
  const entry = state.devices.get(id);
  return entry?.vlmScene || null;
}

export async function startWatching(entry, opts = {}) {
  const { onProgress, onScene, onError, prompt = DEFAULT_PROMPT } = opts;
  if (!isSupported()) throw new Error("WebGPU not available in this browser");
  if (_loops.has(entry.id)) return;
  const loop = { timer: null, running: false, stopped: false, onScene, onError };
  _loops.set(entry.id, loop);
  try { await ensureModel(onProgress); }
  catch (err) { _loops.delete(entry.id); throw err; }
  // Grounding detector loads lazily on first get_robot_detections call,
  // NOT here. Fire-and-forget preload races against the first VLM tick on
  // onnxruntime-web's shared backend state — surfaces as "memory access
  // out of bounds" mid-inference. Cold-start hit on first Pip detection
  // call is the acceptable trade vs. crashing the VLM loop.

  // ORT-web shares backend state across sessions — if the grounding
  // detector wedges the runtime (e.g. dimension mismatch on a fixed-shape
  // graph), every VLM tick afterwards throws the same OrtRun error.
  // Without a backoff the poll loop spams the console every POLL_MS and
  // wastes GPU. After MAX_CONSECUTIVE_ERRORS, stop the loop cleanly —
  // user can re-toggle Live scene to get a fresh runtime.
  const MAX_CONSECUTIVE_ERRORS = 3;
  let consecutiveErrors = 0;
  const tick = async () => {
    if (loop.stopped) return;
    if (loop.running) { loop.timer = setTimeout(tick, POLL_MS); return; }
    loop.running = true;
    try {
      // Re-read entry.vlmPrompt each tick so changes in the prompt field take
      // effect on the next inference without restarting the watch loop.
      const text = await runInference(entry, entry.vlmPrompt?.trim() || prompt);
      if (text) {
        entry.vlmScene = { text, at: Date.now() };
        loop.onScene?.(text);
      }
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      loop.onError?.(err);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        loop.stopped = true;
        _loops.delete(entry.id);
        loop.onError?.(new Error(`Live scene stopped after ${consecutiveErrors} consecutive errors — toggle Live scene off and on to reset`));
        return;
      }
    } finally {
      loop.running = false;
    }
    if (!loop.stopped) loop.timer = setTimeout(tick, POLL_MS);
  };
  tick();
}

export function stopWatching(id) {
  const loop = _loops.get(id);
  if (!loop) return;
  loop.stopped = true;
  if (loop.timer) clearTimeout(loop.timer);
  _loops.delete(id);
}

// ─── Shared "Live scene" UI ───────────────────────────────────────────────
// Both camera capabilities (mjpeg-stream + webrtc-installable) wire the same
// toggle under their camera element. Rendering + wiring live here so the
// gate-and-hint logic isn't duplicated per cap.

// Emits the FULL perception skeleton — checkbox, scene slot, load section,
// prompt editor — always in the same shape when perception is enabled and
// the stream is running. Content updates happen via patchPerceptionState so
// a scene tick can't destroy the user's in-progress edit in the prompt
// textarea.
export function renderPerceptionRow(entry, { running, watching, watchingAction }) {
  // Only surface when a stream is active — nothing meaningful to attach to
  // otherwise. WebGPU absence is a real blocker (no inference possible), so
  // we do show a hint there so users on Safari/Firefox understand why there's
  // no Watch toggle.
  if (!running) return "";
  if (!isSupported()) {
    return `<div class="meta camera-watch-hint">Perception: this browser has no WebGPU (Chrome desktop required).</div>`;
  }
  return `
    <div class="camera-perception" data-cam-perception="${escapeHtml(entry.id)}">
      <label class="camera-watch-row">
        <input type="checkbox" class="camera-watch-cb" data-action="${escapeHtml(watchingAction)}" ${watching ? "checked" : ""}>
        <span>Live scene</span>
        <span class="meta camera-scene"></span>
      </label>
      <div class="camera-watch-load" hidden>
        <div class="meta camera-load-label"></div>
        <progress class="ota-progress" value="0" max="100"></progress>
      </div>
    </div>
  `;
}

// Surgical update for scene text + load progress. Does NOT touch the prompt
// textarea or the checkbox state — ingests entry.vlmScene and entry.vlmLoadState
// only. Called from onScene/onProgress so rapid perception ticks don't trigger
// full-card re-renders that destroy the user's focus in the prompt editor.
export function patchPerceptionState(entry) {
  const root = entry.node?.querySelector(".camera-perception");
  if (!root) return;
  const sceneEl  = root.querySelector(".camera-watch-row .camera-scene");
  const loadEl   = root.querySelector(".camera-watch-load");
  const loadLabel = loadEl?.querySelector(".camera-load-label");
  const loadBar   = loadEl?.querySelector("progress");
  const watching  = !!root.querySelector(".camera-watch-cb")?.checked;
  const load  = entry.vlmLoadState;
  const scene = entry.vlmScene;
  if (load?.status === "loading") {
    if (loadEl)    loadEl.hidden = false;
    if (loadLabel) loadLabel.textContent = `${load.file || "preparing"} · ${Math.round(load.percent || 0)}%`;
    if (loadBar)   { loadBar.value = load.percent || 0; loadBar.max = 100; }
    if (sceneEl)   { sceneEl.textContent = ""; sceneEl.title = ""; }
  } else {
    if (loadEl)  loadEl.hidden = true;
    if (sceneEl) {
      const text = watching ? (scene?.text || "Listening…") : "";
      sceneEl.textContent = text;
      // Full text on hover when the 3-line clamp truncates. Listening /
      // empty states get no tooltip.
      sceneEl.title = scene?.text ? scene.text : "";
    }
  }
}

// Wires the checkbox change handler. The cap writes the watching state back
// onto the entry under the field name it owns. onRender is the cap's own
// renderEntry trigger (each cap holds a local reference via setRender).
// entry.vlmPrompt overrides DEFAULT_PROMPT when set (user-editable prompt).
export function wirePerceptionToggle(entry, node, {
  watchingAction, watchingField, onRender,
}) {
  const cb = node.querySelector(`[data-action="${watchingAction}"]`);
  if (!cb) return;
  cb.addEventListener("change", async (e) => {
    if (e.target.checked) {
      entry[watchingField] = true;
      patchPerceptionState(entry);  // show "Listening…" without re-rendering
      try {
        await startWatching(entry, {
          prompt: entry.vlmPrompt?.trim() || undefined,
          onProgress: (p) => {
            if (p.status === "progress") {
              entry.vlmLoadState = {
                status: "loading",
                file: (p.file || "").split("/").pop(),
                percent: Math.round(p.progress || 0),
              };
              patchPerceptionState(entry);
            } else if (p.status === "ready" || p.status === "done") {
              entry.vlmLoadState = null;
              patchPerceptionState(entry);
            }
          },
          onScene: (text) => {
            entry.vlmLoadState = null;  // first scene = model is definitely loaded
            patchPerceptionState(entry);
            // Paired phones see what Pip sees — catwatcher-style push. Raw
            // VLM observation; Pip isn't in the loop for this stream.
            broadcastSceneToPhones({ source: entry.name, text });
          },
          onError: (err) => console.warn("perception error", err),
        });
      } catch (err) {
        entry[watchingField] = false;
        entry.vlmLoadState = null;
        alert(`Can't start perception: ${err.message || err}`);
        onRender(entry);  // structural change back to off state — full render
      }
    } else {
      stopWatching(entry.id);
      entry[watchingField] = false;
      entry.vlmLoadState = null;
      entry.vlmScene = null;
      patchPerceptionState(entry);
    }
  });
}

// Editable-prompt UI. Lives on the same row as the Watch checkbox so the
// user can steer what the VLM looks for (e.g. "Describe any obstacles in
// front of the robot"). Persists on entry.vlmPrompt for the session;
// changing it while a loop is active takes effect on the next inference.
export function renderPerceptionPromptField(entry, { editAction }) {
  if (!isSupported()) return "";
  const current = entry.vlmPrompt ?? "";
  return `
    <div class="camera-prompt">
      <label class="camera-prompt-label" for="cp-${escapeHtml(entry.id)}">Prompt</label>
      <textarea
        id="cp-${escapeHtml(entry.id)}"
        class="camera-prompt-input"
        rows="2"
        placeholder="${escapeHtml(DEFAULT_PROMPT)}"
        data-action="${escapeHtml(editAction)}">${escapeHtml(current)}</textarea>
      <div class="camera-prompt-hint">Tell Pip what to focus on. Directives work better than questions, and every noun you add nudges the VLM toward naming it — even if it's not there. Empty uses the default shown in grey.</div>
    </div>
  `;
}

export function wirePerceptionPrompt(entry, node, { editAction, onRender }) {
  const ta = node.querySelector(`[data-action="${editAction}"]`);
  if (!ta) return;
  ta.addEventListener("input", () => {
    entry.vlmPrompt = ta.value;
  });
}
