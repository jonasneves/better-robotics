// MJPEG → MediaStream bridge. The ESP32 firmware serves multipart/x-mixed-
// replace over HTTP; the browser decodes that into a live <img>, but there's
// no MediaStream we can pipe through WebRTC to phones. This module paints
// the img into a hidden canvas at ~15 fps and uses canvas.captureStream()
// to synthesize a MediaStream that looks like any other video source.
//
// Cost: one drawImage per frame per robot (cheap for 640x480; ~1 ms on a
// modern GPU). Latency ~1/fps on top of the MJPEG decode. Good enough for
// "show what the robot sees" on a paired phone.
//
// crossorigin="anonymous" on the <img> is the unlock — without it, canvas
// gets tainted and captureStream silently emits no frames. The ESP32
// firmware serves Access-Control-Allow-Origin: * so this works out of the
// box; non-compliant MJPEG sources will fall through to a silent stream.

import { notifyRobotStreamChange } from "../../phones.js";

const FPS = 15;

export function startMjpegForward(entry, srcEl) {
  stopMjpegForward(entry);
  if (!srcEl) return;

  // Source is already a <canvas> (WebCodecs decode path): no drawImage
  // polling needed — captureStream fires on every canvas update. One
  // fewer per-frame copy than the legacy <img> path.
  if (srcEl instanceof HTMLCanvasElement) {
    try {
      const stream = srcEl.captureStream(FPS);
      entry._mjpegForward = { canvas: srcEl, intervalId: null, stream, imgEl: srcEl };
      entry.cameraStream = stream;
      notifyRobotStreamChange(entry);
    } catch { /* captureStream unsupported — phone forward silently skipped */ }
    return;
  }

  // Legacy <img> path (HTTP MJPEG): poll the img into our own canvas.
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const state = { canvas, intervalId: null, stream: null, imgEl: srcEl };
  entry._mjpegForward = state;

  const start = () => {
    const w = srcEl.naturalWidth, h = srcEl.naturalHeight;
    if (!w || !h) return false;
    canvas.width = w;
    canvas.height = h;
    try { state.stream = canvas.captureStream(FPS); }
    catch { return false; }
    entry.cameraStream = state.stream;
    state.intervalId = setInterval(() => {
      try {
        // Bake the camera-flip into the forwarding canvas so phones see
        // the same orientation the operator sees. Reads entry.cameraFlip
        // live each tick — toggling the local CSS transform on the <img>
        // and the pump rotation update together with no plumbing.
        if (entry.cameraFlip) {
          ctx.save();
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate(Math.PI);
          ctx.drawImage(srcEl, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
          ctx.restore();
        } else {
          ctx.drawImage(srcEl, 0, 0, canvas.width, canvas.height);
        }
      } catch { /* tainted canvas or img not ready — keep last frame */ }
    }, 1000 / FPS);
    notifyRobotStreamChange(entry);
    return true;
  };

  if (srcEl.complete && srcEl.naturalWidth) {
    start();
  } else {
    srcEl.addEventListener("load", start, { once: true });
  }
}

export function stopMjpegForward(entry) {
  const state = entry._mjpegForward;
  if (!state) return;
  if (state.intervalId) clearInterval(state.intervalId);
  if (state.stream) {
    for (const t of state.stream.getTracks()) { try { t.stop(); } catch {} }
  }
  entry._mjpegForward = null;
  if (entry.cameraStream) {
    entry.cameraStream = null;
    notifyRobotStreamChange(entry);
  }
}
