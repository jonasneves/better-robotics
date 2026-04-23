// Expected schema shape:
//   { name: "camera", type: "webrtc-installable",
//     chars: { signal: "…d9a", status: "…d9b" },
//     install?: { pkg: "camera", confirm: "..." } }
// Chunked opcode protocol used on both directions (browser→robot via signal,
// robot→browser via status notify). Install routes through the `command` cap.
import { UUIDS_BY_CAP } from "../../ble.js";
import { escapeHtml } from "../../dom.js";
import { logFor } from "../../log.js";
import { state } from "../../state.js";
import { installPackage } from "./command.js";
import { capSection } from "./cap-section.js";
import {
  stopWatching as visionStop,
  renderPerceptionRow,
  wirePerceptionToggle,
  renderPerceptionPromptField,
  wirePerceptionPrompt,
} from "../../perception.js";

const OP_BEGIN   = 0x01;
const OP_CHUNK   = 0x02;
const OP_COMMIT  = 0x03;
const OP_STOP    = 0x04;
const CHUNK_BYTES = 180;

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

export function makeWebrtcInstallableCap(schema) {
  const { name } = schema;
  const chars = schema.chars || UUIDS_BY_CAP[name];
  const signalField = `${name}SignalChar`;
  const statusField = `${name}StatusChar`;
  const pcField     = `${name}Pc`;
  const streamField = `${name}Stream`;
  const bufField    = `${name}RecvBuf`;
  const statusState = `${name}Status`;
  const watchingField = `${name}Watching`;
  const actionStart   = `${name}-start`;
  const actionStop    = `${name}-stop`;
  const actionInstall = `${name}-install`;
  const actionWatch   = `${name}-watch`;
  const actionPrompt  = `${name}-prompt`;
  const label = name[0].toUpperCase() + name.slice(1);

  async function sendSignal(entry, msg) {
    const ch = entry[signalField];
    if (!ch) return;
    const bytes = new TextEncoder().encode(JSON.stringify(msg));
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
      let msg;
      try { msg = JSON.parse(new TextDecoder().decode(merged)); }
      catch { return; }
      handleMessage(entry, msg);
    }
  }

  async function start(entry) {
    if (!entry[signalField] || entry[pcField]) return;
    entry[statusState] = { st: "starting" };
    renderEntry(entry);
    const pc = new RTCPeerConnection();
    entry[pcField] = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (e) => {
      entry[streamField] = e.streams[0];
      const video = entry.node?.querySelector(`video[data-${name}-id="${entry.id}"]`);
      if (video) video.srcObject = entry[streamField];
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
    // Perception rides on the stream; kill it before we tear the stream down
    // so the next frame grab doesn't trip on a null srcObject.
    if (entry[watchingField]) { visionStop(entry.id); entry[watchingField] = false; }
    try { await entry[signalField]?.writeValueWithResponse(new Uint8Array([OP_STOP])); } catch {}
    if (entry[pcField]) { try { entry[pcField].close(); } catch {} entry[pcField] = null; }
    entry[streamField] = null;
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
      if (entry[pcField]) { try { entry[pcField].close(); } catch {} entry[pcField] = null; }
      entry[streamField] = null;
      entry[statusState] = null;
    },

    renderSection(entry) {
      if (entry.status !== "connected" || !entry[signalField]) return "";
      const s = entry[statusState] || { st: "idle" };
      const meta = s.step
        ? `${s.st} — ${s.step}`
        : (s.err ? `${s.st} — ${s.err}` : s.st);
      // Install path needs network (apt-get + pip). Don't gate the button —
      // the user might be on Ethernet, about to join WiFi, etc. Just surface
      // the dependency in a hint line so the failure mode isn't a surprise.
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
      const running = !!entry[pcField];
      const watching = !!entry[watchingField];
      const watchRow = renderPerceptionRow(entry, {
        running, watching, watchingAction: actionWatch,
      });
      const promptField = running ? renderPerceptionPromptField(entry, { editAction: actionPrompt }) : "";
      const body = `
        ${installHint}
        ${s.log ? `<div class="meta install-log">${escapeHtml(s.log)}</div>` : ""}
        ${entry[pcField] ? `<video class="robot-camera" data-${name}-id="${entry.id}" autoplay playsinline muted></video>` : ""}
        ${watchRow}
        ${promptField}
      `;
      return capSection({ name, label, state: meta, action, body });
    },

    wireActions(entry, node) {
      node.querySelector(`[data-action="${actionStart}"]`)?.addEventListener("click",   () => start(entry));
      node.querySelector(`[data-action="${actionStop}"]`)?.addEventListener("click",    () => stop(entry));
      node.querySelector(`[data-action="${actionInstall}"]`)?.addEventListener("click", () => install(entry));
      wirePerceptionToggle(entry, node, {
        watchingAction: actionWatch, watchingField, onRender: renderEntry,
      });
      wirePerceptionPrompt(entry, node, { editAction: actionPrompt, onRender: renderEntry });
    },

    // Rebind the live <video> to its MediaStream after innerHTML rebuild.
    postRender(entry) {
      if (!entry[streamField]) return;
      const video = entry.node?.querySelector(`video[data-${name}-id="${entry.id}"]`);
      if (video) video.srcObject = entry[streamField];
    },
  };
}
