// Schema: { name: "camera", type: "webrtc-installable",
//           chars: { signal: "…d9a", status: "…d9b" },
//           install?: { pkg: "camera", confirm: "..." } }
// Chunked opcode protocol both ways (browser→robot via signal,
// robot→browser via status notify). Install via the `command` cap.
import { UUIDS_BY_CAP, encodeJson, decodeJson } from "../../ble.js";
import { escapeHtml } from "../../dom.js";
import { logFor } from "../../log.js";
import { persist } from "../../state.js";
import { fetchIceServers } from "../../pairing.js";
import { registerExternalPc, unregisterExternalPc } from "../../webrtc-robot.js";
import { installPackage } from "./command.js";
import { capSection } from "./cap-section.js";
import { notifyRobotStreamChange } from "../../phones.js";

const OP_BEGIN   = 0x01;
const OP_CHUNK   = 0x02;
const OP_COMMIT  = 0x03;
const OP_STOP    = 0x04;
const CHUNK_BYTES = 180;

import { renderEntry } from "./render-bus.js";

export function makeWebrtcInstallableCap(schema) {
  const { name } = schema;
  const chars = schema.chars || UUIDS_BY_CAP[name];
  const signalField = `${name}SignalChar`;
  const statusField = `${name}StatusChar`;
  const pcField     = `${name}Pc`;
  const streamField = `${name}Stream`;
  const bufField    = `${name}RecvBuf`;
  const statusState = `${name}Status`;
  const actionStart   = `${name}-start`;
  const actionStop    = `${name}-stop`;
  const actionInstall = `${name}-install`;
  const actionFlip    = `${name}-flip`;
  const label = name[0].toUpperCase() + name.slice(1);

  async function sendSignal(entry, msg) {
    const ch = entry[signalField];
    if (!ch) return;
    const bytes = encodeJson(msg);
    const begin = new Uint8Array(5);
    begin[0] = OP_BEGIN;
    new DataView(begin.buffer).setUint32(1, bytes.length, false);
    await ch.writeValueWithResponse(begin);
    for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
      const slice = bytes.subarray(i, Math.min(i + CHUNK_BYTES, bytes.length));
      const frame = new Uint8Array(slice.length + 1);
      frame[0] = OP_CHUNK;
      frame.set(slice, 1);
      await ch.writeValueWithResponse(frame);
    }
    await ch.writeValueWithResponse(new Uint8Array([OP_COMMIT]));
  }

  async function handleMessage(entry, msg) {
    if (msg.t === "status") {
      entry[statusState] = msg.d || { st: "idle" };
      renderEntry(entry);
      return;
    }
    if (msg.t === "answer" && entry[pcField]) {
      try {
        await entry[pcField].setRemoteDescription(
          new RTCSessionDescription({ sdp: msg.d.sdp, type: msg.d.type })
        );
      } catch (err) {
        logFor(entry, `${name} answer error: ${err.message}`);
      }
    }
  }

  function handleChunk(entry, data) {
    if (data.length === 0) return;
    const op = data[0];
    if (op === OP_BEGIN) {
      entry[bufField] = [];
    } else if (op === OP_CHUNK) {
      if (entry[bufField]) entry[bufField].push(data.subarray(1));
    } else if (op === OP_COMMIT) {
      if (!entry[bufField]) return;
      const total = entry[bufField].reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of entry[bufField]) { merged.set(c, off); off += c.length; }
      entry[bufField] = null;
      const msg = decodeJson(merged);
      if (!msg) return;
      handleMessage(entry, msg);
    }
  }

  // Offscreen canvas pump that copies the visible <video> into a canvas
  // (rotated when entry.cameraFlip is true) and exposes the canvas via
  // captureStream() for phone mirroring. videoEl.captureStream() would
  // hand phones the *source* track — CSS transforms only affect the
  // local render, not the bytes. The canvas detour gets phones the same
  // orientation the operator sees. Cleanup handle on entry._forwardPump.
  function setupForwardPump(entry, videoEl) {
    teardownForwardPump(entry);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    let stopped = false;
    const draw = () => {
      if (stopped) return;
      const w = videoEl.videoWidth, h = videoEl.videoHeight;
      if (w && h) {
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w; canvas.height = h;
        }
        try {
          if (entry.cameraFlip) {
            ctx.save();
            ctx.translate(w / 2, h / 2);
            ctx.rotate(Math.PI);
            ctx.drawImage(videoEl, -w / 2, -h / 2, w, h);
            ctx.restore();
          } else {
            ctx.drawImage(videoEl, 0, 0, w, h);
          }
        } catch { /* video not ready yet — next tick */ }
      }
      // rVFC drives at native video FPS without burning rAF cycles; the
      // rAF fallback runs ~60 Hz which oversamples but still works.
      if ("requestVideoFrameCallback" in videoEl) {
        videoEl.requestVideoFrameCallback(draw);
      } else {
        requestAnimationFrame(draw);
      }
    };
    if ("requestVideoFrameCallback" in videoEl) {
      videoEl.requestVideoFrameCallback(draw);
    } else {
      requestAnimationFrame(draw);
    }
    const stream = canvas.captureStream(30);
    entry._forwardPump = { canvas, stream, stop: () => { stopped = true; } };
    return stream;
  }

  function teardownForwardPump(entry) {
    const p = entry._forwardPump;
    if (!p) return;
    try { p.stop(); } catch {}
    if (p.stream) for (const t of p.stream.getTracks()) try { t.stop(); } catch {}
    entry._forwardPump = null;
  }

  async function start(entry) {
    if (!entry[signalField] || entry[pcField]) return;
    entry[statusState] = { st: "starting" };
    renderEntry(entry);
    const iceServers = await fetchIceServers();
    const pc = new RTCPeerConnection({ iceServers });
    entry[pcField] = pc;
    registerExternalPc(entry.id, name, pc);
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (e) => {
      const rawTrack = e.streams[0];
      // Visible <video> plays the raw RTP stream + local CSS rotation.
      // entry[`${name}RawTrack`] stashes it so a re-render's postRender
      // can re-attach without confusing the canvas pump's source.
      entry[`${name}RawTrack`] = rawTrack;
      const video = entry.node?.querySelector(`video[data-${name}-id="${entry.id}"]`);
      if (video) video.srcObject = rawTrack;
      // For phone forwarding: pump the visible <video> into an offscreen
      // canvas (rotated when cameraFlip is on), captureStream the canvas,
      // and hand THAT to phones via entry.cameraStream. videoEl.
      // captureStream() would forward the source track, ignoring CSS
      // rotation — phones would see un-flipped pixels. The canvas detour
      // gives phones the same orientation the operator sees. One drawImage
      // per video frame (rVFC / rAF fallback) — GPU-composited, ~1 ms.
      if (streamField === "cameraStream" && video) {
        entry[streamField] = setupForwardPump(entry, video);
      } else {
        entry[streamField] = rawTrack;
      }
      if (streamField === "cameraStream") notifyRobotStreamChange(entry);
    };
    pc.onicecandidate = async (e) => {
      if (!e.candidate) return;
      try {
        await sendSignal(entry, {
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
      entry[statusState] = { st: `pc-${pc.connectionState}` };
      renderEntry(entry);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        stop(entry);
      }
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendSignal(entry, {
        t: "offer",
        d: { sdp: offer.sdp, type: offer.type },
      });
      logFor(entry, `${name} offer sent`);
    } catch (err) {
      logFor(entry, `${name} start failed: ${err.message}`);
      stop(entry);
    }
  }

  async function stop(entry) {
    try { await entry[signalField]?.writeValueWithResponse(new Uint8Array([OP_STOP])); } catch {}
    if (entry[pcField]) {
      unregisterExternalPc(entry.id, name);
      try { entry[pcField].close(); } catch {}
      entry[pcField] = null;
    }
    teardownForwardPump(entry);
    entry[streamField] = null;
    entry[`${name}RawTrack`] = null;
    if (streamField === "cameraStream") notifyRobotStreamChange(entry);
    entry[statusState] = { st: "idle" };
    renderEntry(entry);
  }

  async function install(entry) {
    const spec = schema.install || { pkg: name };
    return installPackage(entry.id, spec.pkg, {
      confirm: spec.confirm ||
        `Install ${spec.pkg} support on this robot? Downloads ~150 MB from Debian + PyPI over WiFi.`,
    });
  }

  return {
    name,
    schema,
    initEntry: () => ({
      [signalField]: null, [statusField]: null,
      [pcField]: null, [streamField]: null,
      [`${name}RawTrack`]: null,
      [bufField]: null, [statusState]: null,
    }),

    async probe(entry, service) {
      try {
        entry[signalField] = await service.getCharacteristic(chars.signal);
        entry[statusField] = await service.getCharacteristic(chars.status);
        await entry[statusField].startNotifications();
        entry[statusField].addEventListener("characteristicvaluechanged", (e) => {
          handleChunk(entry, new Uint8Array(e.target.value.buffer));
        });
      } catch {
        entry[signalField] = null;
      }
    },

    cleanup(entry) {
      entry[signalField] = entry[statusField] = null;
      if (entry[pcField]) {
        unregisterExternalPc(entry.id, name);
        try { entry[pcField].close(); } catch {}
        entry[pcField] = null;
      }
      teardownForwardPump(entry);
      entry[streamField] = null;
      entry[`${name}RawTrack`] = null;
      entry[statusState] = null;
    },

    renderSection(entry) {
      if (entry.status !== "connected" || !entry[signalField]) return "";
      const s = entry[statusState] || { st: "idle" };
      const meta = s.step
        ? `${s.st} — ${s.step}`
        : (s.err ? `${s.st} — ${s.err}` : s.st);
      // Install needs network (apt-get + pip) but don't gate the button —
      // user may be on Ethernet, about to join WiFi. Surface the dependency
      // as a hint so failure isn't a surprise.
      const wifiOk = entry.wifiStatus?.st === "joined";
      const installHint = (s.st === "uninstalled" || s.st === "install_failed") && !wifiOk
        ? `<div class="meta">Needs WiFi (~150 MB from Debian + PyPI). Join a network first or be ready to retry.</div>`
        : "";
      // Flip toggle: persistent per-robot, lives alongside the primary
      // action so it's reachable whether the stream is running or stopped
      // (pre-configure before Start; correct mid-session if you just
      // remounted the camera). aria-pressed encodes the state for assistive
      // tech + lets CSS style the pressed look without extra classes.
      const flipBtn = (s.st === "uninstalled" || s.st === "installing" || s.st === "installed" || s.st === "install_failed")
        ? ""
        : `<button class="icon sm" data-action="${actionFlip}" aria-pressed="${!!entry.cameraFlip}" aria-label="Flip camera 180°" title="Flip camera 180°"><svg class="icon-svg"><use href="icons.svg#icon-flip-vertical"/></svg></button>`;
      let action = "";
      if (s.st === "uninstalled" || s.st === "install_failed") {
        action = `<button class="secondary sm" data-action="${actionInstall}">Install ${name} support</button>`;
      } else if (s.st === "installing" || s.st === "installed") {
        action = `<button class="secondary sm" disabled>Installing…</button>`;
      } else if (entry[pcField]) {
        action = `${flipBtn}<button class="secondary sm" data-action="${actionStop}">Stop</button>`;
      } else {
        action = `${flipBtn}<button class="secondary sm" data-action="${actionStart}">Start</button>`;
      }
      // CSS rotate(180deg) is GPU-composited — zero CPU cost vs a per-frame
      // canvas redraw. captureStream() on the <video> for phone mirroring
      // captures pre-transform pixels (the phone sees un-flipped). Document
      // the constraint; firmware-side libcamera transform is the fix if
      // upside-down phone mirroring becomes a real ask.
      const videoStyle = entry.cameraFlip ? ` style="transform: rotate(180deg)"` : "";
      const body = `
        ${installHint}
        ${s.log ? `<div class="meta install-log">${escapeHtml(s.log)}</div>` : ""}
        ${entry[pcField] ? `<video class="robot-camera" data-${name}-id="${entry.id}" autoplay playsinline muted${videoStyle}></video>` : ""}
      `;
      return capSection({ name, label, state: meta, action, body, transport: "wifi" });
    },

    wireActions(entry, node) {
      node.querySelector(`[data-action="${actionStart}"]`)?.addEventListener("click",   () => start(entry));
      node.querySelector(`[data-action="${actionStop}"]`)?.addEventListener("click",    () => stop(entry));
      node.querySelector(`[data-action="${actionInstall}"]`)?.addEventListener("click", () => install(entry));
      node.querySelector(`[data-action="${actionFlip}"]`)?.addEventListener("click", () => {
        entry.cameraFlip = !entry.cameraFlip;
        persist();
        renderEntry(entry);
      });
    },

    // Rebind the live <video> to the raw RTP track after innerHTML rebuild.
    // Not the canvas-pump stream — the pump's source IS this video, so
    // pointing it at the pump output would create a self-mirror.
    postRender(entry) {
      const raw = entry[`${name}RawTrack`];
      if (!raw) return;
      const video = entry.node?.querySelector(`video[data-${name}-id="${entry.id}"]`);
      if (video) video.srcObject = raw;
    },
  };
}
