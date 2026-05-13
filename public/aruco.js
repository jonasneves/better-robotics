// Headless overhead ArUco localization. Reads frames from a designated
// <video> element (a phone helper's shared camera, or any other live
// source), detects markers, writes metric robot positions to
// entry.arucoPosition. No UI surface — the consumer (helpers.js) wires
// the source via setOverheadSource(videoEl, { onResult }) and renders
// the overlay against its own preview tile.
//
// Marker → robot binding prefers explicit entry.arucoMarkerId; falls
// back to positional ordering (entries[m.id]) so single-robot zero-config
// still works. Multi-robot setups should bind explicitly (window.bindArucoMarker)
// — see DEV.md.
//
// Staleness contract: a fresh updatedAt timestamp is written on every
// detection. Consumers MUST gate trust on (Date.now() - updatedAt) before
// steering — the producer can't distinguish "out of frame" from "lost
// lock under motion blur," so it never clears stale entries.
//
// Library: js-aruco2 from jsDelivr, pure JS, ~50 KB. DICT_4X4_50 markers
// (printable sheets in /assets). POS.Posit estimates metric pose from
// settings.arucoMarkerSizeMm + a focal-length heuristic.

import { state, persist } from "./state.js";
import { settings } from "./settings.js";

const CDN = "https://cdn.jsdelivr.net/gh/damianofalcioni/js-aruco2@master/src";
// Load order matters: svd.js MUST precede posit1.js because posit1.js does
// `var SVD = this.SVD || require('./svd').SVD;` — the require() branch is
// CJS-only and throws in the browser. With svd.js loaded first, `this.SVD`
// is defined and the require call never runs. Dictionary files live in a
// separate dir and self-register on AR.DICTIONARIES[name]; aruco.js holds
// none of them, so the chosen dict has to be loaded explicitly.
const SCRIPTS = [
  "cv.js",
  "aruco.js",
  "svd.js",
  "posit1.js",
  "dictionaries/aruco_4x4_1000.js",
];
// ARUCO_4X4_1000 is the 1000-code superset; the first 50 codes match
// OpenCV's DICT_4X4_50, which is what the printable sheets are based on.
const DICTIONARY = "ARUCO_4X4_1000";
const SCAN_INTERVAL_MS = 1000;

let _detector = null;
let _detectorPromise = null;
let _sourceVideo = null;
let _onResult = null;
let _timer = null;
let _frameCount = 0;
let _canvas = null;  // reusable; resized to match source dims each tick

function loadScript(url) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-aruco-src="${url}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = url;
    s.dataset.arucoSrc = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`failed to load ${url}`));
    document.head.appendChild(s);
  });
}

async function ensureDetector() {
  if (_detector) return _detector;
  if (_detectorPromise) return _detectorPromise;
  _detectorPromise = (async () => {
    for (const f of SCRIPTS) await loadScript(`${CDN}/${f}`);
    if (!window.AR?.Detector) throw new Error("AR.Detector not available after script load");
    _detector = new window.AR.Detector({ dictionaryName: DICTIONARY });
    return _detector;
  })();
  try { return await _detectorPromise; }
  catch (err) { _detectorPromise = null; throw err; }
}

function estimatePose(corners, w, h, markerSizeMm) {
  if (!window.POS?.Posit) return null;
  const cx = w / 2;
  const cy = h / 2;
  const centered = corners.map(c => ({ x: c.x - cx, y: -(c.y - cy) }));
  const focalLength = Math.max(w, h) * 0.85;
  try {
    const posit = new window.POS.Posit(markerSizeMm, focalLength);
    const pose = posit.pose(centered);
    const [x, y, z] = pose.bestTranslation;
    return { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
  } catch {
    return null;
  }
}

// Map a detected marker to a robot entry. Explicit binding wins
// (entry.arucoMarkerId === markerId). Otherwise fall back to positional
// — entries[markerId] in iteration order — but only when no entry has
// claimed the id explicitly, so a bound marker for an absent robot
// doesn't shadow into positional.
function resolveEntry(markerId) {
  const all = [...state.devices.values()];
  const explicit = all.find(e => e.arucoMarkerId === markerId);
  if (explicit) return explicit;
  const anyBound = all.some(e => e.arucoMarkerId === markerId);
  if (anyBound) return null;
  return all[markerId] || null;
}

async function tick() {
  if (!_sourceVideo) return;
  try {
    const detector = await ensureDetector();
    const w = _sourceVideo.videoWidth;
    const h = _sourceVideo.videoHeight;
    if (!w || !h) {
      _onResult?.({ markers: [], frameCount: _frameCount, error: "no frame yet" });
      return;
    }
    if (!_canvas) _canvas = document.createElement("canvas");
    if (_canvas.width !== w) _canvas.width = w;
    if (_canvas.height !== h) _canvas.height = h;
    const ctx = _canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(_sourceVideo, 0, 0, w, h);
    const raw = detector.detect(ctx.getImageData(0, 0, w, h));
    _frameCount += 1;

    const markerSizeMm = Math.max(1, parseFloat(settings.arucoMarkerSizeMm) || 100);
    const now = Date.now();
    const markers = raw.map(m => {
      const c = m.corners;
      const cx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4;
      const cy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4;
      const headingRad = Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x);
      const pose = estimatePose(c, w, h, markerSizeMm);
      const entry = resolveEntry(m.id);
      if (entry && pose) {
        entry.arucoPosition = {
          x: pose.x, y: pose.y,
          headingDeg: Math.round(headingRad * 180 / Math.PI),
          markerSizeMm,
          updatedAt: now,
        };
      }
      return { id: m.id, cx, cy, headingRad, corners: c, pose, entry, frameW: w, frameH: h };
    });

    _onResult?.({ markers, frameCount: _frameCount });
  } catch (err) {
    _onResult?.({ markers: [], frameCount: _frameCount, error: err?.message || String(err) });
  }
}

export function setOverheadSource(videoEl, { onResult } = {}) {
  if (_sourceVideo === videoEl && _onResult === onResult) return;
  clearOverheadSource();
  _sourceVideo = videoEl;
  _onResult = onResult || null;
  _frameCount = 0;
  // Kick once immediately so the overlay paints without waiting a full tick.
  tick();
  _timer = setInterval(tick, SCAN_INTERVAL_MS);
}

export function clearOverheadSource() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _sourceVideo = null;
  _onResult = null;
  _frameCount = 0;
}

// Manual marker→robot binding. Surfaced via window.bindArucoMarker for
// DEV.md; UI selector deferred until two-robot use forces the question.
export function bindArucoMarker(robotId, markerId) {
  const entry = state.devices.get(robotId);
  if (!entry) return { error: `no robot ${robotId}` };
  entry.arucoMarkerId = typeof markerId === "number" ? markerId : null;
  persist();
  return { ok: true, robotId, markerId: entry.arucoMarkerId };
}

if (typeof window !== "undefined") window.bindArucoMarker = bindArucoMarker;
