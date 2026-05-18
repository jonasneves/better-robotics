// Schema: { name: "camera", type: "webrtc-installable",
//           chars: { signal: "…d9a", status: "…d9b" },
//           install?: { pkg: "camera", confirm: "..." } }
// Chunked opcode protocol both ways (browser→robot via signal,
// robot→browser via status notify). Install via the `command` cap.
import { UUIDS_BY_CAP, encodeJson, decodeJson } from "../../ble.js";
import { escapeHtml } from "../../dom.js";
import { logFor } from "../../log.js";
import { state } from "../../state.js";
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

// Chunked JPEG reassembly + decode → canvas. Wire format matches the ESP32
// firmware (and now the Pi firmware): [frame_id u16 BE][chunk_idx u8]
// [total_chunks u8][jpeg]. Decode via WebCodecs ImageDecoder when present
// (Chrome 94+, Safari 17+, Firefox 133+), createImageBitmap on older
// browsers. Drops partial frames whose id is older than a newer one in
// flight. onFirstFrame fires once after the first successful paint so
// the caller can wire up phone restreaming on a canvas that's now
// emitting real pixels.
function attachChunkedJpegDecoder(channel, canvas, onFirstFrame) {
  const ctrl = { canvas, ctx: canvas.getContext("2d") };
  const useDecoder = typeof ImageDecoder !== "undefined";
  const pending = new Map();
  let first = true;

  async function paint(bytes) {
    const c = ctrl.canvas, g = ctrl.ctx;
    if (!c || !g) return;
    try {
      if (useDecoder) {
        const decoder = new ImageDecoder({ data: bytes, type: "image/jpeg" });
        const { image } = await decoder.decode();
        if (c.width !== image.codedWidth || c.height !== image.codedHeight) {
          c.width = image.codedWidth; c.height = image.codedHeight;
        }
        g.drawImage(image, 0, 0);
        image.close(); decoder.close();
      } else {
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        if (c.width !== bitmap.width || c.height !== bitmap.height) {
          c.width = bitmap.width; c.height = bitmap.height;
        }
        g.drawImage(bitmap, 0, 0); bitmap.close();
      }
      if (first) { first = false; onFirstFrame?.(); }
    } catch { /* partial JPEG from out-of-order reassembly — next frame replaces it */ }
  }

  channel.addEventListener("message", (e) => {
    if (typeof e.data === "string") return;
    const data = new Uint8Array(e.data);
    if (data.length < 4) return;
    const frameId = (data[0] << 8) | data[1];
    const chunkIdx = data[2];
    const totalChunks = data[3];
    const payload = data.subarray(4);
    let frame = pending.get(frameId);
    if (!frame) { frame = { total: totalChunks, parts: new Map() }; pending.set(frameId, frame); }
    frame.parts.set(chunkIdx, payload);
    if (frame.parts.size !== frame.total) return;
    let totalLen = 0;
    for (let i = 0; i < frame.total; i++) {
      const p = frame.parts.get(i);
      if (!p) { pending.delete(frameId); return; }
      totalLen += p.length;
    }
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (let i = 0; i < frame.total; i++) {
      const p = frame.parts.get(i);
      merged.set(p, off); off += p.length;
    }
    pending.delete(frameId);
    for (const id of pending.keys()) if (id < frameId) pending.delete(id);
    paint(merged);
  });

  // Hand callers a rebind hook so postRender can repoint the decoder
  // at a freshly-rendered <canvas> after an innerHTML rebuild without
  // restarting the WebRTC pipeline.
  ctrl.attachCanvas = (next) => { ctrl.canvas = next; ctrl.ctx = next.getContext("2d"); };
  return ctrl;
}

import { renderEntry } from "./render-bus.js";

export function makeWebrtcInstallableCap(schema) {
  const { name } = schema;
  const chars = schema.chars || UUIDS_BY_CAP[name];
  const signalField  = `${name}SignalChar`;
  const statusField  = `${name}StatusChar`;
  const pcField      = `${name}Pc`;
  const streamField  = `${name}Stream`;
  const bufField     = `${name}RecvBuf`;
  const statusState  = `${name}Status`;
  const decoderField = `${name}Decoder`;
  const actionStart   = `${name}-start`;
  const actionStop    = `${name}-stop`;
  const actionInstall = `${name}-install`;
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

  async function start(entry) {
    if (!entry[signalField] || entry[pcField]) return;
    entry[statusState] = { st: "starting" };
    renderEntry(entry);
    const iceServers = await fetchIceServers();
    const pc = new RTCPeerConnection({ iceServers });
    entry[pcField] = pc;
    registerExternalPc(entry.id, name, pc);
    // Re-render with pcField set so the <canvas> appears in the DOM
    // BEFORE we querySelector it below. Without this second render the
    // decoder never attaches: frames arrive over the data channel and
    // hit no listener, the card sits at "pc-connected" forever.
    renderEntry(entry);

    // Chunked JPEG over data channel — same wire format the ESP32
    // firmware uses, decoded by the WebCodecs path below. No RTP track
    // (the Pi's aiortc software VP8 encoder was the throughput ceiling
    // the chunked-JPEG path exists to bypass). Unreliable + unordered:
    // a lost chunk is superseded by the next frame, no SCTP head-of-
    // line stall.
    const channel = pc.createDataChannel("video", { ordered: false, maxRetransmits: 0 });
    channel.binaryType = "arraybuffer";
    const canvas = entry.node?.querySelector(`canvas[data-${name}-id="${entry.id}"]`);
    if (canvas) {
      entry[decoderField] = attachChunkedJpegDecoder(channel, canvas, () => {
        // Canvas exposes a synthetic MediaStream via captureStream —
        // phone mirroring picks this up the same way it does for the
        // ESP32 path.
        if (streamField === "cameraStream" && !entry[streamField]) {
          try {
            entry[streamField] = canvas.captureStream(30);
            notifyRobotStreamChange(entry);
          } catch {}
        }
      });
    }
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
    entry[decoderField] = null;
    entry[streamField] = null;
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
      [bufField]: null, [statusState]: null,
      [decoderField]: null,
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
      entry[decoderField] = null;
      entry[streamField] = null;
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
      let action = "";
      if (s.st === "uninstalled" || s.st === "install_failed") {
        action = `<button class="secondary sm" data-action="${actionInstall}">Install ${name} support</button>`;
      } else if (s.st === "installing" || s.st === "installed") {
        action = `<button class="secondary sm" disabled>Installing…</button>`;
      } else if (entry[pcField]) {
        action = `<button class="secondary sm" data-action="${actionStop}">Stop</button>`;
      } else {
        action = `<button class="secondary sm" data-action="${actionStart}">Start</button>`;
      }
      const body = `
        ${installHint}
        ${s.log ? `<div class="meta install-log">${escapeHtml(s.log)}</div>` : ""}
        ${entry[pcField] ? `<canvas class="robot-camera" data-${name}-id="${entry.id}" width="640" height="480" aria-label="webrtc video"></canvas>` : ""}
      `;
      return capSection({ name, label, state: meta, action, body, transport: "wifi" });
    },

    wireActions(entry, node) {
      node.querySelector(`[data-action="${actionStart}"]`)?.addEventListener("click",   () => start(entry));
      node.querySelector(`[data-action="${actionStop}"]`)?.addEventListener("click",    () => stop(entry));
      node.querySelector(`[data-action="${actionInstall}"]`)?.addEventListener("click", () => install(entry));
    },

    // After an innerHTML rebuild the canvas we were painting into may
    // be a fresh DOM node. The decoder controller exposes attachCanvas
    // so we can repoint it at the new element without restarting the
    // WebRTC pipeline; captureStream regenerates from the new canvas
    // so paired phones don't lose the feed.
    postRender(entry) {
      if (!entry[pcField] || !entry[decoderField]) return;
      const canvas = entry.node?.querySelector(`canvas[data-${name}-id="${entry.id}"]`);
      if (!canvas || canvas === entry[decoderField].canvas) return;
      entry[decoderField].attachCanvas(canvas);
      if (entry[streamField]) {
        try {
          entry[streamField] = canvas.captureStream(30);
          if (streamField === "cameraStream") notifyRobotStreamChange(entry);
        } catch {}
      }
    },
  };
}
