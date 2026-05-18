// Schema: { name: "camera", type: "mjpeg-stream" }
// ESP32 path uses BLE-signaled WebRTC by default and exposes an HTTP
// MJPEG fallback on :81/stream (transport toggle below). Pi path also
// uses BLE-signaled WebRTC, via pi_robot_rtc.py over a local Unix socket.
import { logFor } from "../../log.js";
import { capSection } from "./cap-section.js";
import { startMjpegForward, stopMjpegForward } from "./mjpeg-restream.js";
import { persist } from "../../state.js";

import { renderEntry } from "./render-bus.js";

// Camera streaming needs the chip on WiFi for WebRTC ICE — BLE can
// signal the SDP but the actual media path is P2P over the LAN.
function hasWifi(entry) { return !!entry.wifiStatus?.ip; }

// Open a WebRTC `video` data channel, ask the firmware for a stream at
// 5 fps, decode incoming JPEG chunks into a <canvas>. Returns a disposer;
// null on open failure.
//
// We tried RTP MJPEG via esp_peer's video track but the binary library
// blocks too long inside packetization on classic ESP32 — TWDT triggers
// on the first frame send. Chunked DC stays the working path.
//
// Decode path: WebCodecs ImageDecoder when available (Chrome 94+, Safari
// 17+, Firefox 133+) — bypasses the blob→URL→<img>.src→layout roundtrip
// that previously capped throughput around 30 fps even when the network
// delivered more. Falls back to createImageBitmap (one fewer step than
// blob URL but still off the layout path) on older browsers.
async function startEsp32WebRTCVideo(entry, canvas) {
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
  const ctrl = { channel, canvas, ctx: canvas.getContext("2d") };
  const useDecoder = typeof ImageDecoder !== "undefined";
  // Rolling 1s window of frame-paint timestamps. Drawn in the corner so
  // any future throughput experiment (chip QF, vTaskDelay tweak, MTU bump)
  // reads its result immediately without DevTools.
  const paintTimes = [];

  function drawFpsOverlay(g, c) {
    const now = performance.now();
    paintTimes.push(now);
    while (paintTimes.length && now - paintTimes[0] > 1000) paintTimes.shift();
    const label = `${paintTimes.length} fps`;
    g.save();
    g.font = "600 14px ui-monospace, monospace";
    const w = g.measureText(label).width + 12;
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.fillRect(6, 6, w, 22);
    g.fillStyle = "#fff";
    g.textBaseline = "middle";
    g.fillText(label, 12, 18);
    g.restore();
  }

  // 180° rotation: bake into drawImage so canvas pixels are rotated —
  // captureStream() of this canvas now delivers rotated bytes to phones
  // and any other consumer. Local view IS this canvas, so no CSS
  // transform needed on top.
  function drawRotated(g, src, w, h) {
    if (entry.cameraFlip) {
      g.save();
      g.translate(w / 2, h / 2);
      g.rotate(Math.PI);
      g.drawImage(src, -w / 2, -h / 2);
      g.restore();
    } else {
      g.drawImage(src, 0, 0);
    }
  }

  async function paintJpeg(bytes) {
    // Re-acquire ctx if the canvas got replaced by a re-render and
    // app.js's transplant logic re-pointed ctrl.canvas at the live one.
    const c = ctrl.canvas, g = ctrl.ctx;
    if (!c || !g) return;
    try {
      if (useDecoder) {
        const decoder = new ImageDecoder({ data: bytes, type: "image/jpeg" });
        const { image } = await decoder.decode();
        if (c.width !== image.codedWidth || c.height !== image.codedHeight) {
          c.width = image.codedWidth; c.height = image.codedHeight;
        }
        drawRotated(g, image, c.width, c.height);
        image.close();
        decoder.close();
      } else {
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        if (c.width !== bitmap.width || c.height !== bitmap.height) {
          c.width = bitmap.width; c.height = bitmap.height;
        }
        drawRotated(g, bitmap, c.width, c.height);
        bitmap.close();
      }
      drawFpsOverlay(g, c);
    } catch {
      // Decode failure — drop this frame. Common on partial JPEGs from
      // out-of-order chunk reassembly; the next frame will arrive shortly.
    }
  }

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
    paintJpeg(merged);
  };
  channel.addEventListener("message", onMsg);
  try { channel.send(JSON.stringify({ type: "start", fps: 30 })); } catch {}
  logFor(entry, `video webrtc: streaming (${useDecoder ? "ImageDecoder" : "createImageBitmap"})`);
  ctrl.attachCanvas = (next) => { ctrl.canvas = next; ctrl.ctx = next.getContext("2d"); };
  ctrl.dispose = () => {
    channel.removeEventListener("message", onMsg);
    try { channel.send(JSON.stringify({ type: "stop" })); } catch {}
    try { channel.close(); } catch {}
    closePeer(entry.id);
  };
  return ctrl;
}

export function makeMjpegStreamCap(schema) {
  const { name } = schema;
  const runningField = `${name}Running`;
  const actionStart = `${name}-start`;
  const actionStop  = `${name}-stop`;
  const actionFlip  = `${name}-flip`;
  const label = name[0].toUpperCase() + name.slice(1);

  const transportField = `${name}Transport`;
  const actionTransport = `${name}-transport`;
  return {
    name,
    schema,
    // Default to webrtc — most boards support it. The render path below
    // downgrades to http when fw_info.webrtc === false.
    initEntry: () => ({ [runningField]: false, [transportField]: "webrtc" }),
    cleanup(entry)  {
      entry[runningField] = false;
      stopMjpegForward(entry);
    },

    renderSection(entry, { childHtml = "" } = {}) {
      if (entry.status !== "connected") return "";
      const wifi = hasWifi(entry);
      const running = entry[runningField];
      const webrtcSupported = entry.fwInfo?.webrtc !== false;
      const transport = webrtcSupported ? (entry[transportField] || "webrtc") : "http";
      let body = "";
      if (!wifi) {
        body = `<div class="meta">Waiting for the robot to join WiFi — video needs a LAN IP.</div>`;
      } else if (running) {
        // WebRTC path renders a <canvas> — the start handler decodes JPEG
        // chunks via WebCodecs straight to it, skipping the blob→URL→<img>
        // layout roundtrip that caps throughput. HTTP MJPEG keeps the <img>
        // since the browser's native multipart parser is the cheapest path.
        // crossOrigin on <img> lets camera-frame.js read pixels; canvas
        // pixels are same-origin by construction.
        const useCanvas = entry.fwType === "esp32" && transport === "webrtc";
        // Canvas path bakes the 180° rotation into drawImage so captureStream
        // forwards rotated pixels to paired phones. No CSS transform needed
        // — canvas IS the pixels. HTTP MJPEG path keeps CSS rotation on the
        // <img>; mjpeg-restream.js separately rotates its forwarding canvas
        // so phone mirroring stays consistent with the local view.
        const flipImgStyle = (!useCanvas && entry.cameraFlip) ? ` style="transform: rotate(180deg)"` : "";
        body = useCanvas
          ? `<canvas class="robot-camera" data-cam-id="${entry.id}" width="640" height="480" aria-label="webrtc video"></canvas>`
          : `<img class="robot-camera" crossorigin="anonymous" data-cam-id="${entry.id}" alt="${transport} video"${flipImgStyle}>`;
      }
      // Stream URL omitted from idle body — it's debug info that leaked
      // into daily UX. The dashboard log echoes it on connect for anyone
      // who actually needs to copy it.
      // Flip toggle: same shape as the Pi camera card — persisted per-robot,
      // reachable whether running or stopped. Hidden when WiFi isn't joined
      // (the Start button is disabled anyway; nothing useful to do).
      const flipBtn = wifi
        ? `<button class="icon sm" data-action="${actionFlip}" aria-pressed="${!!entry.cameraFlip}" aria-label="Flip camera 180°" title="Flip camera 180°"><svg class="icon-svg"><use href="icons.svg#icon-flip-vertical"/></svg></button>`
        : "";
      const action = !wifi
        ? `<button class="secondary sm" disabled>Start</button>`
        : running
          ? `${flipBtn}<button class="secondary sm" data-action="${actionStop}">Stop</button>`
          : `${flipBtn}<button class="secondary sm" data-action="${actionStart}">Start</button>`;
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
      // transport / webrtcSupported are already in scope from the top of
      // renderSection. transport here already reflects the http override
      // when webrtc isn't supported, so no second computation needed.
      const transportHint = transport === "http"
        ? "LAN only, no encryption — fastest"
        : "Encrypted, works cross-network";
      let transportRow = "";
      if (wifi && entry.fwType === "esp32") {
        if (running) {
          transportRow = `<div class="meta">via ${transport === "http" ? "HTTP MJPEG" : "WebRTC"}</div>`;
        } else if (!webrtcSupported) {
          // Only one option; render as a fixed label, not a dropdown — a
          // single-choice select is dead UI weight.
          transportRow = `<div class="cap-profile">
             <span class="meta">Transport: HTTP MJPEG — ${transportHint}${showNewTabLink ? ` · <a href="${httpStreamUrl}" target="_blank" rel="noreferrer">open in new tab ↗</a>` : ""}</span>
           </div>`;
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
        body: `${body}${transportRow}${childHtml}`,
        transport: "wifi",
      });
    },

    wireActions(entry, node) {
      const findEl = () => entry.node?.querySelector(
        `img.robot-camera[data-cam-id="${entry.id}"], canvas.robot-camera[data-cam-id="${entry.id}"]`,
      );
      node.querySelector(`[data-action="${actionStart}"]`)?.addEventListener("click", async () => {
        entry[runningField] = true;
        renderEntry(entry);
        const el = findEl();
        if (!el) return;

        if (entry.fwType === "esp32") {
          // Mirror the render-path override — firmware without WebRTC
          // forces HTTP regardless of the saved-transport field. Avoids
          // hitting the "WebRTC signaling needs a BLE signal char" path
          // when the user pre-existing transport choice was "webrtc".
          const webrtcSupported = entry.fwInfo?.webrtc !== false;
          const transport = webrtcSupported ? (entry[transportField] || "webrtc") : "http";
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
            el.src = `http://${ip}:81/stream`;
            startMjpegForward(entry, el);
            logFor(entry, `video: HTTP MJPEG ${el.src}`);
            return;
          }
          // WebRTC — firmware/webrtc_peer.c routes a `video` data channel
          // into an esp_camera_fb_get loop, sending each JPEG as binary.
          // WebCodecs decodes each JPEG straight to the canvas.
          const ctrl = await startEsp32WebRTCVideo(entry, el);
          if (ctrl) {
            entry._webrtcVideo = ctrl;
            if (!entry[runningField]) { ctrl.dispose(); entry._webrtcVideo = null; return; }
            startMjpegForward(entry, el);
            return;
          }
          logFor(entry, `video: WebRTC unavailable; cannot stream`);
          entry[runningField] = false;
          renderEntry(entry);
          return;
        }
        startMjpegForward(entry, el);
      });
      node.querySelector(`[data-action="${actionStop}"]`)?.addEventListener("click", () => {
        if (entry._webrtcVideo) { entry._webrtcVideo.dispose(); entry._webrtcVideo = null; }
        stopMjpegForward(entry);
        entry[runningField] = false;
        renderEntry(entry);
      });
      // Post-render rebind: when the card re-renders mid-stream, the
      // element we were drawing into is detached. Re-point both the WebRTC
      // decode target and the phone-restream source at the fresh element.
      // (app.js's transplant logic preserves the live element across most
      // re-renders, but rebind is the belt-and-suspenders fallback.)
      if (entry[runningField]) {
        const el = findEl();
        if (el) {
          if (entry._webrtcVideo && el !== entry._webrtcVideo.canvas) {
            entry._webrtcVideo.attachCanvas?.(el);
          }
          if (entry._mjpegForward && el !== entry._mjpegForward.imgEl) {
            startMjpegForward(entry, el);
          }
        }
      }
      const transportSel = node.querySelector(`[data-action="${actionTransport}"]`);
      if (transportSel) transportSel.addEventListener("change", () => {
        entry[transportField] = transportSel.value;
        logFor(entry, `video transport → ${transportSel.value}`);
      });
      node.querySelector(`[data-action="${actionFlip}"]`)?.addEventListener("click", () => {
        entry.cameraFlip = !entry.cameraFlip;
        persist();
        renderEntry(entry);
      });
    },
  };
}
