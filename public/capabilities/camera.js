// Camera capability. WebRTC over BLE-signaled SDP/ICE. Two characteristics:
//   camera-signal — write: chunked signaling frames from browser to robot
//   camera-status — read + notify: chunked signaling frames robot to browser
//                   (also carries install progress + error state as JSON)
// Protocol mirrors OTA's chunked opcode shape: begin/chunk/commit/stop/install.
// Install-on-demand: if a Pi declares camera support but lacks picamera2 /
// aiortc, the status reports "uninstalled" and the dashboard exposes an
// "Install camera support" button that writes CAM_OP_INSTALL — the Pi then
// runs apt+pip in the background and restarts its service to load the new
// modules. One click, no SSH.
import {
  CAMERA_SIGNAL_CHAR_UUID, CAMERA_STATUS_CHAR_UUID,
} from "../ble.js";
import { escapeHtml } from "../dom.js";
import { logFor } from "../log.js";
import { state } from "../state.js";

const CAM_OP_BEGIN   = 0x01;
const CAM_OP_CHUNK   = 0x02;
const CAM_OP_COMMIT  = 0x03;
const CAM_OP_STOP    = 0x04;
const CAM_OP_INSTALL = 0x05;
const CAM_CHUNK_BYTES = 180;

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

async function sendCameraSignal(entry, msg) {
  const bytes = new TextEncoder().encode(JSON.stringify(msg));
  const ch = entry.cameraSignalChar;
  if (!ch) return;
  const begin = new Uint8Array(5);
  begin[0] = CAM_OP_BEGIN;
  new DataView(begin.buffer).setUint32(1, bytes.length, false);
  await ch.writeValueWithResponse(begin);
  for (let i = 0; i < bytes.length; i += CAM_CHUNK_BYTES) {
    const slice = bytes.subarray(i, Math.min(i + CAM_CHUNK_BYTES, bytes.length));
    const frame = new Uint8Array(slice.length + 1);
    frame[0] = CAM_OP_CHUNK;
    frame.set(slice, 1);
    await ch.writeValueWithResponse(frame);
  }
  await ch.writeValueWithResponse(new Uint8Array([CAM_OP_COMMIT]));
}

function handleCameraChunk(entry, data) {
  if (data.length === 0) return;
  const op = data[0];
  if (op === CAM_OP_BEGIN) {
    entry.cameraRecvBuf = [];
  } else if (op === CAM_OP_CHUNK) {
    if (entry.cameraRecvBuf) entry.cameraRecvBuf.push(data.subarray(1));
  } else if (op === CAM_OP_COMMIT) {
    if (!entry.cameraRecvBuf) return;
    const total = entry.cameraRecvBuf.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of entry.cameraRecvBuf) { merged.set(c, off); off += c.length; }
    entry.cameraRecvBuf = null;
    let msg;
    try { msg = JSON.parse(new TextDecoder().decode(merged)); }
    catch { return; }
    handleCameraMessage(entry, msg);
  }
}

async function handleCameraMessage(entry, msg) {
  if (msg.t === "status") {
    entry.cameraStatus = msg.d || { st: "idle" };
    renderEntry(entry);
    return;
  }
  if (msg.t === "answer" && entry.cameraPc) {
    try {
      await entry.cameraPc.setRemoteDescription(
        new RTCSessionDescription({ sdp: msg.d.sdp, type: msg.d.type })
      );
    } catch (err) {
      logFor(entry, `camera answer error: ${err.message}`);
    }
  }
}

export async function startCamera(id) {
  const entry = state.devices.get(id);
  if (!entry || !entry.cameraSignalChar) return;
  if (entry.cameraPc) return;
  entry.cameraStatus = { st: "starting" };
  renderEntry(entry);
  const pc = new RTCPeerConnection();
  entry.cameraPc = pc;
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.ontrack = (e) => {
    entry.cameraStream = e.streams[0];
    const video = entry.node?.querySelector(`video[data-cam-id="${id}"]`);
    if (video) video.srcObject = entry.cameraStream;
  };
  pc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    try {
      await sendCameraSignal(entry, {
        t: "ice",
        d: {
          candidate: e.candidate.candidate,
          sdpMid: e.candidate.sdpMid,
          sdpMLineIndex: e.candidate.sdpMLineIndex,
        },
      });
    } catch {}
  };
  pc.onconnectionstatechange = () => {
    entry.cameraStatus = { st: `pc-${pc.connectionState}` };
    renderEntry(entry);
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      stopCamera(id);
    }
  };
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendCameraSignal(entry, {
      t: "offer",
      d: { sdp: offer.sdp, type: offer.type },
    });
    logFor(entry, "camera offer sent");
  } catch (err) {
    logFor(entry, `camera start failed: ${err.message}`);
    stopCamera(id);
  }
}

export async function stopCamera(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  try { await entry.cameraSignalChar?.writeValueWithResponse(new Uint8Array([CAM_OP_STOP])); } catch {}
  if (entry.cameraPc) { try { entry.cameraPc.close(); } catch {} entry.cameraPc = null; }
  entry.cameraStream = null;
  entry.cameraStatus = { st: "idle" };
  renderEntry(entry);
}

export async function installCamera(id) {
  const entry = state.devices.get(id);
  if (!entry?.cameraSignalChar) return;
  if (!confirm(
    "Install camera support on this Pi?\n\n" +
    "Downloads ~100MB (picamera2 + aiortc + av). Takes 1-3 min on a Pi 4. " +
    "The Pi needs internet access (WiFi joined) for the install to succeed."
  )) return;
  try {
    await entry.cameraSignalChar.writeValueWithResponse(new Uint8Array([CAM_OP_INSTALL]));
    logFor(entry, "camera install requested");
  } catch (err) {
    logFor(entry, `camera install error: ${err.message}`);
  }
}

export const camera = {
  name: "camera",
  initEntry: () => ({
    cameraSignalChar: null, cameraStatusChar: null,
    cameraPc: null, cameraStream: null,
    cameraRecvBuf: null, cameraStatus: null,
  }),

  async probe(entry, service) {
    try {
      entry.cameraSignalChar = await service.getCharacteristic(CAMERA_SIGNAL_CHAR_UUID);
      entry.cameraStatusChar = await service.getCharacteristic(CAMERA_STATUS_CHAR_UUID);
      await entry.cameraStatusChar.startNotifications();
      entry.cameraStatusChar.addEventListener("characteristicvaluechanged", (e) => {
        handleCameraChunk(entry, new Uint8Array(e.target.value.buffer));
      });
    } catch {
      entry.cameraSignalChar = null;
    }
  },

  cleanup(entry) {
    entry.cameraSignalChar = entry.cameraStatusChar = null;
    if (entry.cameraPc) { try { entry.cameraPc.close(); } catch {} entry.cameraPc = null; }
    entry.cameraStream = null;
    entry.cameraStatus = null;
  },

  renderSection(entry) {
    if (entry.status !== "connected" || !entry.cameraSignalChar) return "";
    const s = entry.cameraStatus || { st: "idle" };
    const label = s.step
      ? `${s.st} — ${s.step}`
      : (s.err ? `${s.st} — ${s.err}` : s.st);
    let action = "";
    if (s.st === "uninstalled" || s.st === "install_failed") {
      action = `<button class="secondary sm" data-action="camera-install">Install camera support</button>`;
    } else if (s.st === "installing" || s.st === "installed") {
      action = `<button class="secondary sm" disabled>Installing…</button>`;
    } else if (entry.cameraPc) {
      action = `<button class="secondary sm" data-action="camera-stop">Stop</button>`;
    } else {
      action = `<button class="secondary sm" data-action="camera-start">Start</button>`;
    }
    return `
      <div class="robot-controls">
        <div class="row">
          <div>
            <div class="label">Camera</div>
            <div class="meta">${escapeHtml(label)}</div>
          </div>
          ${action}
        </div>
        ${s.log ? `<div class="meta install-log">${escapeHtml(s.log)}</div>` : ""}
        ${entry.cameraPc ? `
          <video class="robot-camera" data-cam-id="${entry.id}" autoplay playsinline muted></video>
        ` : ""}
      </div>
    `;
  },

  wireActions(entry, node) {
    const start = node.querySelector('[data-action="camera-start"]');
    if (start) start.addEventListener("click", () => startCamera(entry.id));
    const stop = node.querySelector('[data-action="camera-stop"]');
    if (stop) stop.addEventListener("click", () => stopCamera(entry.id));
    const install = node.querySelector('[data-action="camera-install"]');
    if (install) install.addEventListener("click", () => installCamera(entry.id));
  },

  // After renderEntry rebuilds innerHTML, rebind the live <video> to its
  // MediaStream so a camera section re-render doesn't visibly drop frames.
  postRender(entry) {
    if (!entry.cameraStream) return;
    const video = entry.node?.querySelector(`video[data-cam-id="${entry.id}"]`);
    if (video) video.srcObject = entry.cameraStream;
  },
};
