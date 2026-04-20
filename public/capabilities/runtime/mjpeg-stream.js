// Expected schema shape:
//   { name: "camera", type: "mjpeg-stream", port: 81, path: "/stream" }
// Unlike the Pi webrtc-installable cap, there's no BLE signaling — the
// dashboard just opens http://<ip>:<port><path> with a plain <img>. Works
// only when the dashboard's browser and the robot share a network.
import { escapeHtml } from "../../dom.js";
import { settings } from "../../settings.js";
import {
  isSupported as visionSupported,
  isWatching as visionWatching,
  startWatching as visionStart,
  stopWatching as visionStop,
  getLatestScene as visionScene,
} from "../../perception.js";
import { broadcastSceneToPhones } from "../../phones.js";

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

function streamUrl(entry, schema) {
  const ip = entry.wifiStatus?.ip;
  if (!ip) return null;
  const port = schema.port || 81;
  const path = schema.path || "/stream";
  return `http://${ip}:${port}${path}`;
}

export function makeMjpegStreamCap(schema) {
  const { name } = schema;
  const runningField = `${name}Running`;
  const watchingField = `${name}Watching`;
  const actionStart = `${name}-start`;
  const actionStop  = `${name}-stop`;
  const actionWatch = `${name}-watch`;
  const label = name[0].toUpperCase() + name.slice(1);

  return {
    name,
    schema,
    initEntry: () => ({ [runningField]: false, [watchingField]: false }),
    async probe() { /* HTTP on LAN — no BLE char to probe. */ },
    cleanup(entry)  {
      entry[runningField] = false;
      if (entry[watchingField]) { visionStop(entry.id); entry[watchingField] = false; }
    },

    renderSection(entry) {
      if (entry.status !== "connected") return "";
      const url = streamUrl(entry, schema);
      const running = entry[runningField];
      const watching = entry[watchingField];
      let body = "";
      if (!url) {
        body = `<div class="meta">Waiting for the robot to join WiFi — stream needs a LAN IP.</div>`;
      } else if (running) {
        // crossOrigin="anonymous" lets canvas read pixels (perception.js needs
        // it). ESP32 firmware already serves Access-Control-Allow-Origin: *.
        body = `<img class="robot-camera" crossorigin="anonymous" data-cam-id="${entry.id}" src="${escapeHtml(url)}" alt="MJPEG stream">`;
      } else {
        body = `<div class="meta">${escapeHtml(url)}</div>`;
      }
      const action = !url
        ? `<button class="secondary sm" disabled>Start</button>`
        : running
          ? `<button class="secondary sm" data-action="${actionStop}">Stop</button>`
          : `<button class="secondary sm" data-action="${actionStart}">Start</button>`;
      // Perception toggle — only surface when the stream is active AND the
      // browser supports WebGPU. Shows the latest scene text underneath the
      // checkbox so the user can see what Pip sees.
      const scene = visionScene(entry.id);
      const sceneText = scene?.text ?? "";
      // Perception is gated behind settings.perception (Settings → Experimental)
      // because it's WebGPU-only, multi-hundred-MB on first load, and GPU-heavy
      // at run. Users opt in explicitly before the control even appears.
      const watchRow = running && visionSupported() && settings.perception ? `
        <label class="camera-watch-row">
          <input type="checkbox" data-action="${actionWatch}" ${watching ? "checked" : ""}>
          <span>Watch with Pip</span>
          ${watching && sceneText
            ? `<span class="meta camera-scene">${escapeHtml(sceneText)}</span>`
            : watching
              ? `<span class="meta camera-scene">Loading model…</span>`
              : ""}
        </label>
      ` : "";
      return `
        <div class="robot-controls">
          <div class="row">
            <div><div class="label">${escapeHtml(label)}</div></div>
            ${action}
          </div>
          ${body}
          ${watchRow}
        </div>
      `;
    },

    wireActions(entry, node) {
      node.querySelector(`[data-action="${actionStart}"]`)?.addEventListener("click", () => {
        entry[runningField] = true;
        renderEntry(entry);
      });
      node.querySelector(`[data-action="${actionStop}"]`)?.addEventListener("click", () => {
        if (entry[watchingField]) { visionStop(entry.id); entry[watchingField] = false; }
        entry[runningField] = false;
        renderEntry(entry);
      });
      node.querySelector(`[data-action="${actionWatch}"]`)?.addEventListener("change", async (e) => {
        if (e.target.checked) {
          entry[watchingField] = true;
          renderEntry(entry);
          try {
            await visionStart(entry, {
              onScene: (text) => {
                renderEntry(entry);
                // Paired phones see what Pip sees — catwatcher-style push. No
                // Pip-in-the-loop for this stream; it's raw VLM observation.
                broadcastSceneToPhones({ source: entry.name, text });
              },
              onError: (err) => console.warn("perception error", err),
            });
          } catch (err) {
            entry[watchingField] = false;
            alert(`Can't start perception: ${err.message || err}`);
            renderEntry(entry);
          }
        } else {
          visionStop(entry.id);
          entry[watchingField] = false;
          renderEntry(entry);
        }
      });
    },
  };
}
