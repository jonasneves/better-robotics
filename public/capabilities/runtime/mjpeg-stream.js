// Expected schema shape:
//   { name: "camera", type: "mjpeg-stream", port: 81, path: "/stream" }
// Unlike the Pi webrtc-installable cap, there's no BLE signaling — the
// dashboard just opens http://<ip>:<port><path> with a plain <img>. Works
// only when the dashboard's browser and the robot share a network.
import { escapeHtml } from "../../dom.js";
import {
  stopWatching as visionStop,
  renderPerceptionRow,
  wirePerceptionToggle,
  renderPerceptionPromptField,
  wirePerceptionPrompt,
} from "../../perception.js";
import { capSection } from "./cap-section.js";

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
  const actionPrompt = `${name}-prompt`;
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
      const watchRow = renderPerceptionRow(entry, {
        running, watching, watchingAction: actionWatch,
      });
      const promptField = running ? renderPerceptionPromptField(entry, { editAction: actionPrompt }) : "";
      const stateText = !url ? "Waiting for WiFi"
                      : running ? "streaming"
                      : "ready";
      return capSection({
        name,
        label,
        state: stateText,
        action,
        body: `${body}${watchRow}${promptField}`,
      });
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
      wirePerceptionToggle(entry, node, {
        watchingAction: actionWatch, watchingField, onRender: renderEntry,
      });
      wirePerceptionPrompt(entry, node, { editAction: actionPrompt, onRender: renderEntry });
    },
  };
}
