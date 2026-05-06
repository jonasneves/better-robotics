// Schema: { name: "camera", type: "mjpeg-stream" }
// ESP32 path uses BLE-signaled WebRTC by default and exposes an HTTP
// MJPEG fallback on :81/stream (transport toggle below). Pi path uses
// wss-signaled WebRTC.
import { logFor } from "../../log.js";
import {
  stopWatching as visionStop,
  renderPerceptionRow,
  wirePerceptionToggle,
  renderPerceptionPromptField,
  wirePerceptionPrompt,
} from "../../perception.js";
import { capSection } from "./cap-section.js";
import { startMjpegForward, stopMjpegForward } from "./mjpeg-restream.js";

import { renderEntry } from "./render-bus.js";

// Camera streaming needs the chip on WiFi for WebRTC ICE — BLE can
// signal the SDP but the actual media path is P2P over the LAN.
function hasWifi(entry) { return !!entry.wifiStatus?.ip; }

// Open a WebRTC `video` data channel, ask the firmware for a stream at
// 5 fps, render incoming binary frames into the existing <img> via blob
// URLs. Returns a disposer; null on open failure.
//
// We tried RTP MJPEG via esp_peer's video track but the binary library
// blocks too long inside packetization on classic ESP32 — TWDT triggers
// on the first frame send. Chunked DC stays the working path.
async function startEsp32WebRTCVideo(entry, img) {
  const { openChannel, closePeer } = await import("../../webrtc-robot.js");
  let channel;
  try {
    channel = await openChannel(entry.id, entry.name, "video", {
      onStatus: (s) => logFor(entry, `video webrtc: ${s}`),
      robotType: entry.fwType,
      signalChar: entry.signalChar,
    });
  } catch (err) {
    logFor(entry, `video webrtc open failed: ${err.message}`);
    return null;
  }
  channel.binaryType = "arraybuffer";
  let prevUrl = null;
  // Wire format per chunk: [frame_id u16 BE][chunk_idx u8][total_chunks u8][jpeg bytes].
  // Reassemble per frame_id; drop incomplete frames if a newer frame_id starts.
  const pending = new Map();
  const onMsg = (e) => {
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
    for (let i = 0; i < frame.total; i++) { merged.set(frame.parts.get(i), off); off += frame.parts.get(i).length; }
    pending.delete(frameId);
    for (const id of pending.keys()) if (id < frameId) pending.delete(id);
    const blob = new Blob([merged], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    img.src = url;
    if (prevUrl) URL.revokeObjectURL(prevUrl);
    prevUrl = url;
  };
  channel.addEventListener("message", onMsg);
  try { channel.send(JSON.stringify({ type: "start", fps: 5 })); } catch {}
  logFor(entry, `video webrtc: streaming`);
  return {
    channel,
    dispose() {
      channel.removeEventListener("message", onMsg);
      try { channel.send(JSON.stringify({ type: "stop" })); } catch {}
      try { channel.close(); } catch {}
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      closePeer(entry.id);
    },
  };
}

export function makeMjpegStreamCap(schema) {
  const { name } = schema;
  const runningField = `${name}Running`;
  const watchingField = `${name}Watching`;
  const actionStart = `${name}-start`;
  const actionStop  = `${name}-stop`;
  const actionWatch = `${name}-watch`;
  const actionPrompt = `${name}-prompt`;
  const label = name[0].toUpperCase() + name.slice(1);

  const transportField = `${name}Transport`;
  const actionTransport = `${name}-transport`;
  return {
    name,
    schema,
    initEntry: () => ({ [runningField]: false, [watchingField]: false, [transportField]: "webrtc" }),
    cleanup(entry)  {
      entry[runningField] = false;
      if (entry[watchingField]) { visionStop(entry.id); entry[watchingField] = false; }
      stopMjpegForward(entry);
    },

    renderSection(entry, { childHtml = "" } = {}) {
      if (entry.status !== "connected") return "";
      const wifi = hasWifi(entry);
      const running = entry[runningField];
      const watching = entry[watchingField];
      const transport = entry[transportField] || "webrtc";
      let body = "";
      if (!wifi) {
        body = `<div class="meta">Waiting for the robot to join WiFi — video needs a LAN IP.</div>`;
      } else if (running) {
        // crossOrigin lets perception.js's canvas read the pixels.
        // For WebRTC: no src at render time — click handler attaches
        // frames via blob URLs. For HTTP: the click handler sets src
        // to http://<ip>:81/stream directly.
        body = `<img class="robot-camera" crossorigin="anonymous" data-cam-id="${entry.id}" alt="${transport} video">`;
      }
      // Stream URL omitted from idle body — it's debug info that leaked
      // into daily UX. The dashboard log echoes it on connect for anyone
      // who actually needs to copy it.
      const action = !wifi
        ? `<button class="secondary sm" disabled>Start</button>`
        : running
          ? `<button class="secondary sm" data-action="${actionStop}">Stop</button>`
          : `<button class="secondary sm" data-action="${actionStart}">Start</button>`;
      const watchRow = renderPerceptionRow(entry, {
        running, watching, watchingAction: actionWatch,
      });
      const promptField = running ? renderPerceptionPromptField(entry, { editAction: actionPrompt }) : "";
      // State string only when it adds info beyond the action verb. Action
      // says Start/Stop already; "ready"/"streaming" would just echo it.
      // "Waiting for WiFi" earns its place — the button is disabled and the
      // user needs to know why.
      const stateText = !wifi ? "Waiting for WiFi" : "";
      // ESP32 only: transport toggle when stopped, small "via …" badge
      // when streaming. Description for the current pick lives beneath
      // so the closed dropdown stays compact (HIG: concise primary
      // labels, context revealed underneath).
      const httpStreamUrl = (wifi && entry.fwType === "esp32" && entry.wifiStatus?.ip)
        ? `http://${entry.wifiStatus.ip}:81/stream` : null;
      const httpsBlocked = typeof location !== "undefined" && location.protocol === "https:";
      const showNewTabLink = transport === "http" && httpsBlocked && httpStreamUrl;
      const transportHint = transport === "http"
        ? "LAN only, no encryption — fastest"
        : "Encrypted, works cross-network";
      let transportRow = "";
      if (wifi && entry.fwType === "esp32") {
        if (running) {
          transportRow = `<div class="meta">via ${transport === "http" ? "HTTP MJPEG" : "WebRTC"}</div>`;
        } else {
          transportRow = `<div class="cap-profile">
             <label>Transport
               <select data-action="${actionTransport}">
                 <option value="webrtc" ${transport === "webrtc" ? "selected" : ""}>WebRTC</option>
                 <option value="http" ${transport === "http" ? "selected" : ""}>HTTP MJPEG</option>
               </select>
             </label>
             <span class="meta">${transportHint}${showNewTabLink ? ` — <a href="${httpStreamUrl}" target="_blank" rel="noreferrer">open in new tab ↗</a> (HTTPS blocks inline)` : ""}</span>
           </div>`;
        }
      }
      return capSection({
        name,
        label,
        state: stateText,
        action,
        // Child caps (Flash, Snapshot — schema-flat, conceptually camera
        // sub-controls) render here so the operator sees one Camera section
        // hosting everything camera-shaped instead of three peers in a flat list.
        body: `${body}${watchRow}${promptField}${transportRow}${childHtml}`,
        transport: "wifi",
      });
    },

    wireActions(entry, node) {
      node.querySelector(`[data-action="${actionStart}"]`)?.addEventListener("click", async () => {
        entry[runningField] = true;
        renderEntry(entry);
        const img = entry.node?.querySelector(`img.robot-camera[data-cam-id="${entry.id}"]`);
        if (!img) return;

        if (entry.fwType === "esp32") {
          const transport = entry[transportField] || "webrtc";
          if (transport === "http") {
            // HTTP MJPEG — bypass DTLS/SCTP entirely. Browser will block
            // mixed content if the dashboard is on HTTPS; users in that
            // case get the new-tab link in the toggle row instead.
            const ip = entry.wifiStatus?.ip;
            if (!ip) {
              logFor(entry, `video: chip has no IP yet`);
              entry[runningField] = false;
              renderEntry(entry);
              return;
            }
            img.src = `http://${ip}:81/stream`;
            startMjpegForward(entry, img);
            logFor(entry, `video: HTTP MJPEG ${img.src}`);
            return;
          }
          // WebRTC — firmware/webrtc_peer.c routes a `video` data channel
          // into an esp_camera_fb_get loop, sending each JPEG as binary.
          // Browser blob-URLs each frame into the img.
          const ctrl = await startEsp32WebRTCVideo(entry, img);
          if (ctrl) {
            entry._webrtcVideo = ctrl;
            if (!entry[runningField]) { ctrl.dispose(); entry._webrtcVideo = null; return; }
            startMjpegForward(entry, img);
            return;
          }
          logFor(entry, `video: WebRTC unavailable; cannot stream`);
          entry[runningField] = false;
          renderEntry(entry);
          return;
        }
        startMjpegForward(entry, img);
      });
      node.querySelector(`[data-action="${actionStop}"]`)?.addEventListener("click", () => {
        if (entry[watchingField]) { visionStop(entry.id); entry[watchingField] = false; }
        if (entry._webrtcVideo) { entry._webrtcVideo.dispose(); entry._webrtcVideo = null; }
        stopMjpegForward(entry);
        entry[runningField] = false;
        renderEntry(entry);
      });
      // Post-render rebind: when the card re-renders (e.g. renderEntry fired
      // from elsewhere) and the stream is already running, the old <img> is
      // gone and we're drawing into nothing. Re-point at the fresh img.
      if (entry[runningField] && entry._mjpegForward) {
        const img = entry.node?.querySelector(`img.robot-camera[data-cam-id="${entry.id}"]`);
        if (img && img !== entry._mjpegForward.imgEl) {
          startMjpegForward(entry, img);
        }
      }
      const transportSel = node.querySelector(`[data-action="${actionTransport}"]`);
      if (transportSel) transportSel.addEventListener("change", () => {
        entry[transportField] = transportSel.value;
        logFor(entry, `video transport → ${transportSel.value}`);
      });
      wirePerceptionToggle(entry, node, {
        watchingAction: actionWatch, watchingField, onRender: renderEntry,
      });
      wirePerceptionPrompt(entry, node, { editAction: actionPrompt, onRender: renderEntry });
    },
  };
}
