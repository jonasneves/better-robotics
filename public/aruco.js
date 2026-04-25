// ArUco fiducial-marker detection for phone-as-overhead-camera. The phone's
// WebRTC video lands on `entry.attachedCameraStream` (see helpers.js mount
// flow); a marker taped on top of the robot gives sub-pixel ground-truth
// pose at ~10-20 ms per frame. Pure JS via js-aruco2 (no WASM).
//
// Phase 1 surface: detect marker corners + center, render as a debug SVG
// overlay on the robot card. No motors, no metric pose. Phase 3 will layer
// `POS.Posit` for metric pose + a pure-pursuit follower; for now we just
// want to SEE that detection is reliable before trusting it for control.
//
// Marker recipe: print "Original ArUco" id 0 from https://chev.me/arucogen
// (matches js-aruco2's default `ARUCO` dictionary). Tape on top of robot.
//
// Source: https://github.com/damianofalcioni/js-aruco2 — UMD-style globals,
// no ESM build, so we inject <script> tags lazily on first use. Detector +
// dictionary are reusable across frames; instantiate once.

const CDN = "https://cdn.jsdelivr.net/gh/damianofalcioni/js-aruco2@master/src";
const SCRIPTS = ["cv.js", "aruco.js"];  // svd.js + posit1.js only when phase 3 needs pose
const DICTIONARY = "ARUCO";  // matches chev.me/arucogen "Original ArUco"
const POLL_MS = 100;  // 10 Hz — plenty for phase 1 diagnostics

let _detector = null;
let _loadPromise = null;
const _canvasByDim = new Map();  // "wxh" → reusable OffscreenCanvas-style HTMLCanvas

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-aruco-src="${url}"]`);
    if (existing) { existing.addEventListener("load", resolve); existing.addEventListener("error", reject); return; }
    const s = document.createElement("script");
    s.src = url;
    s.dataset.arucoSrc = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${url}`));
    document.head.appendChild(s);
  });
}

async function ensureDetector() {
  if (_detector) return _detector;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    for (const f of SCRIPTS) await loadScript(`${CDN}/${f}`);
    if (!window.AR?.Detector) throw new Error("AR.Detector missing after load");
    _detector = new window.AR.Detector({ dictionaryName: DICTIONARY });
    return _detector;
  })();
  try { return await _loadPromise; }
  catch (err) { _loadPromise = null; throw err; }
}

function canvasFor(w, h) {
  const key = `${w}x${h}`;
  let c = _canvasByDim.get(key);
  if (!c) {
    c = document.createElement("canvas");
    c.width = w; c.height = h;
    _canvasByDim.set(key, c);
  }
  return c;
}

// Detect markers in a single video / img frame. Returns
//   [{ id, corners: [{x,y} x4 in image-pixel coords], cx, cy, headingRad }]
// `headingRad` is computed from corner orientation (corner[0]→corner[1] is
// the marker's "top edge"); good enough for phase 1's debug overlay. Full
// pose estimation comes later via POS.Posit.
async function detectFromSource(source) {
  const detector = await ensureDetector();
  const w = source.naturalWidth || source.videoWidth;
  const h = source.naturalHeight || source.videoHeight;
  if (!w || !h) return [];
  const canvas = canvasFor(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  try { ctx.drawImage(source, 0, 0, w, h); }
  catch { return []; }  // tainted canvas (no CORS) — surface as "no markers"
  let imageData;
  try { imageData = ctx.getImageData(0, 0, w, h); }
  catch { return []; }
  const raw = detector.detect(imageData);
  return raw.map(m => {
    const c = m.corners;
    const cx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4;
    const cy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4;
    const headingRad = Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x);
    return { id: m.id, corners: c, cx, cy, headingRad, frameW: w, frameH: h };
  });
}

const _loops = new Map();  // robotId → loop record

// Start a polling loop against `sourceFn()` (returns the live <video> /
// <img> each tick — re-resolved every iteration so a card re-render that
// swaps the element doesn't break tracking). `onMarkers(markers)` fires
// after each detect; called with [] when no markers found, so the overlay
// can clear too.
export function startTracking(robotId, sourceFn, onMarkers) {
  if (_loops.has(robotId)) return;
  const loop = { stopped: false, timer: null };
  _loops.set(robotId, loop);
  const tick = async () => {
    if (loop.stopped) return;
    const source = sourceFn();
    if (source) {
      try {
        const markers = await detectFromSource(source);
        if (!loop.stopped) {
          try { onMarkers(markers); } catch (err) { console.warn("[aruco] onMarkers", err); }
        }
      } catch (err) {
        if (!loop.stopped) console.warn("[aruco] detect", err.message || err);
      }
    }
    if (!loop.stopped) loop.timer = setTimeout(tick, POLL_MS);
  };
  tick();
}

export function stopTracking(robotId) {
  const loop = _loops.get(robotId);
  if (!loop) return;
  loop.stopped = true;
  if (loop.timer) clearTimeout(loop.timer);
  _loops.delete(robotId);
}

export function isTracking(robotId) { return _loops.has(robotId); }
