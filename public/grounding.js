// Open-vocabulary object detection via transformers.js. Output shape:
// [{ label, score, bbox: { x, y, w, h, cx, cy } }] with coordinates
// normalized to [0,1]; cx/cy is the box center (x=0 left, y=0 top).

import { drawFrameToCanvas } from "./perception.js";

export const GROUNDING_ENABLED = true;

// Keep in sync with perception.js / local-llm.js so a single runtime copy
// is loaded when multiple pipelines coexist. Unversioned URL tracks the
// latest v4.x, which ships the native WebGPU EP (broader op coverage
// than onnxruntime-web's old WebGPU backend — fixes the Cast placement
// failure that previously killed OWLv2).
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers";
// Grounding DINO tiny — officially supported zero-shot-object-detection
// model in transformers.js (landed in v3.3). q4f16 variant is ~151MB,
// WebGPU-friendly. OWLv2 was rejected because its ONNX graph tripped
// onnxruntime-web's older backend on an unplaceable Cast(13) op.
const MODEL_ID = "onnx-community/grounding-dino-tiny-ONNX";
const MODEL_DTYPE = "q4f16";
const MAX_DIM = 640;
const DEFAULT_THRESHOLD = 0.25;
const DEFAULT_TOPK = 5;

let _pipe = null;
let _loadingPromise = null;
let _onProgress = () => {};
// Sticky failure flag — once init has failed across all backends, or an
// inference has blown up, stop retrying. Subsequent detectOnce returns null
// so pip-tools surfaces "detector unavailable" cleanly; Pip's system prompt
// then follows the "no detector → ask_human" hard rule instead of looping.
let _pipeFailed = false;

export function onGroundingProgress(cb) { _onProgress = cb || (() => {}); }
export function isGroundingLoaded() { return !!_pipe; }
export function isGroundingFailed() { return _pipeFailed; }

// Called from perception.js startWatching so detector + VLM loads share
// the same user-gated moment. Fire-and-forget; errors surface at tool-call
// time so a detector failure doesn't block VLM scene captions. Opt out
// with ?no-grounding-preload (see DEV.md).
export function preloadGrounding() {
  if (!GROUNDING_ENABLED) return;
  if (typeof location !== "undefined" && /\bno-grounding-preload\b/.test(location.search + location.hash)) return;
  ensurePipe().catch(() => {});
}

// q4f16 is fastest but needs the WebGPU shader-f16 extension (absent on
// some Intel iGPUs + older Android GPUs — symptom there is an opaque
// "Cannot read properties of undefined" inside the pipeline because a
// binding never resolved). Cascade from fastest-but-pickiest to
// broadest-but-slowest so install-once-work-everywhere is the default.
const INIT_ATTEMPTS = [
  { device: "webgpu", dtype: "q4f16" },
  { device: "webgpu", dtype: "q4"    },
  { device: "webgpu"                 },
  {                                  },
];

async function ensurePipe() {
  if (_pipeFailed) return null;
  if (_pipe) return _pipe;
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = (async () => {
    const { pipeline } = await import(TRANSFORMERS_URL);
    const errors = [];
    for (const attempt of INIT_ATTEMPTS) {
      try {
        _pipe = await pipeline("zero-shot-object-detection", MODEL_ID, {
          ...attempt,
          progress_callback: (p) => { try { _onProgress(p); } catch {} },
        });
        return _pipe;
      } catch (err) {
        errors.push(`${attempt.device || "auto"}/${attempt.dtype || "auto"}: ${err && err.message || err}`);
      }
    }
    _pipeFailed = true;
    console.warn("[grounding] init failed across all backends:", errors.join(" | "));
    return null;
  })().catch((err) => {
    _pipeFailed = true;
    console.warn("[grounding] init threw:", err && err.message || err);
    return null;
  });
  return _loadingPromise;
}

// Grounding DINO's text encoder requires lowercase queries terminated by a
// period — mandated by the processor (see model card). "Yellow can" silently
// returns no hits; "yellow can." works. Normalize here so Pip's tool contract
// (free-form noun phrases) stays unchanged.
function normalizeQuery(q) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return "";
  return s.endsWith(".") ? s : `${s}.`;
}

export async function detectOnce(entry, queries, { threshold = DEFAULT_THRESHOLD, topk = DEFAULT_TOPK } = {}) {
  if (_pipeFailed) return null;
  if (!Array.isArray(queries) || queries.length === 0) return [];
  const canvas = drawFrameToCanvas(entry, MAX_DIM);
  if (!canvas) return null;
  const pipe = await ensurePipe();
  if (!pipe) return null;   // init cascade exhausted; caller treats as "no detector"
  const imageUrl = canvas.toDataURL("image/jpeg", 0.85);
  const normalized = queries.map(normalizeQuery).filter(Boolean);
  if (normalized.length === 0) return [];
  // Grounding DINO's ONNX export pins input_ids to batch=1 — passing an
  // array of N queries throws "invalid dimensions Got: N Expected: 1".
  // The canonical input is one period-separated prompt ("a cat. a dog."),
  // so concatenate. normalizeQuery already appended the periods.
  const prompt = normalized.join(" ");
  let raw;
  try {
    raw = await pipe(imageUrl, prompt, { threshold, topk });
  } catch (err) {
    // Runtime inference failure (mid-session). Mark sticky so we stop
    // trying — otherwise Pip loops through failed calls and burns tokens.
    _pipeFailed = true;
    _pipe = null;
    _loadingPromise = null;
    console.warn("[grounding] inference failed, disabling detector for the session:", err && err.message || err);
    return null;
  }
  const W = canvas.width, H = canvas.height;
  return raw.map(r => {
    const x0 = r.box.xmin / W;
    const y0 = r.box.ymin / H;
    const x1 = r.box.xmax / W;
    const y1 = r.box.ymax / H;
    // Strip the trailing period so Pip sees its original query back,
    // not the Grounding-DINO-normalized form.
    const label = typeof r.label === "string" ? r.label.replace(/\.$/, "") : r.label;
    return {
      label,
      score: r.score,
      bbox: {
        x: x0, y: y0,
        w: x1 - x0, h: y1 - y0,
        cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
      },
    };
  });
}
