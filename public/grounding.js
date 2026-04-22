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
const MODEL_ID = "Xenova/owlvit-base-patch32";
const MAX_DIM = 640;
const DEFAULT_THRESHOLD = 0.1;
const DEFAULT_TOPK = 5;

let _pipe = null;
let _loadingPromise = null;
let _onProgress = () => {};

export function onGroundingProgress(cb) { _onProgress = cb || (() => {}); }
export function isGroundingLoaded() { return !!_pipe; }

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
