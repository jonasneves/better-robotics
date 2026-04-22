// Open-vocabulary object detection — OWL-ViT via transformers.js. Fills
// the spatial gap that get_robot_scene (text-only VLM) can't address: Pip
// can ask "where in the frame is the yellow can?" and get bounding boxes
// instead of guessing from a free-form caption.
//
// Architecturally parallel to perception.js: same transformers.js loader
// pattern, same lazy first-call model download, same WebGPU-when-available
// fallback to WASM. Detections and scene descriptions are independent
// signals — Pip can use either or both.
//
// Output shape: [{ label, score, bbox: { x, y, w, h, cx, cy } }] with all
// coordinates normalized to [0,1] (x=0 is left edge, y=0 is top). cx/cy
// are the center of the box, pre-computed because Pip's spatial reasoning
// almost always wants "where is the center" not "where is the corner".
//
// Cost envelope:
//   - One-time ~300-600MB model download on first use (IndexedDB-cached).
//   - First inference after load: ~3-5s (warmup).
//   - Steady-state: ~1-2s on WebGPU, ~3-5s on WASM fallback.
//   - Called on-demand only (no continuous loop), so cost is per-decision.

import { drawFrameToCanvas } from "./perception.js";

const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers";
// OWLv2 has a cleaner ONNX graph than OWL-ViT — the base-patch32 variant
// tripped onnxruntime-web's WASM backend on an unsupported Cast(13) op in
// the wild. OWLv2 also tends to outperform its predecessor on open-vocab
// tasks. Size is comparable (~300MB quantized).
const MODEL_ID = "Xenova/owlv2-base-patch16";
const MAX_DIM = 640;
const DEFAULT_THRESHOLD = 0.1;
const DEFAULT_TOPK = 5;

let _pipe = null;
let _loadingPromise = null;
let _onProgress = () => {};

export function onGroundingProgress(cb) { _onProgress = cb || (() => {}); }
export function isGroundingLoaded() { return !!_pipe; }

// Perception layer owns when the detector loads — not Pip's tool calls.
// Called from startWatching() in perception.js so "enable Watch" triggers
// both the VLM load (required for scene captions) and the detector load
// (required for spatial grounding) in parallel. Fire-and-forget: a
// detector failure shouldn't block Watch, since VLM scenes are still
// useful on their own. Any error surfaces naturally when Pip later calls
// get_robot_detections.
export function preloadGrounding() {
  // URL opt-out for bandwidth-sensitive scenarios (mobile hotspot,
  // users who only want VLM scene captions without spatial grounding).
  // Documented in DEV.md.
  if (typeof location !== "undefined" && /\bno-grounding-preload\b/.test(location.search + location.hash)) return;
  ensurePipe().catch(() => { /* surface at tool-call time, not here */ });
}

async function ensurePipe() {
  if (_pipe) return _pipe;
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = (async () => {
    const { pipeline } = await import(TRANSFORMERS_URL);
    _pipe = await pipeline("zero-shot-object-detection", MODEL_ID, {
      progress_callback: (p) => { try { _onProgress(p); } catch {} },
    });
    return _pipe;
  })();
  return _loadingPromise;
}

// Run detector on the current camera frame for a set of open-vocabulary
// queries. Queries are short noun phrases — "yellow can", "doorway",
// "chair". Up to ~5 per call keeps inference cost manageable.
export async function detectOnce(entry, queries, { threshold = DEFAULT_THRESHOLD, topk = DEFAULT_TOPK } = {}) {
  if (!Array.isArray(queries) || queries.length === 0) return [];
  const canvas = drawFrameToCanvas(entry, MAX_DIM);
  if (!canvas) return null;
  const pipe = await ensurePipe();
  // transformers.js pipeline returns pixel coords; normalize with known
  // canvas dims so Pip's spatial reasoning stays resolution-agnostic.
  const imageUrl = canvas.toDataURL("image/jpeg", 0.85);
  const raw = await pipe(imageUrl, queries, { threshold, topk });
  const W = canvas.width, H = canvas.height;
  return raw.map(r => {
    const x0 = r.box.xmin / W;
    const y0 = r.box.ymin / H;
    const x1 = r.box.xmax / W;
    const y1 = r.box.ymax / H;
    return {
      label: r.label,
      score: r.score,
      bbox: {
        x: x0, y: y0,
        w: x1 - x0, h: y1 - y0,
        cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
      },
    };
  });
}
