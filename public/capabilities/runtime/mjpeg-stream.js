// Expected schema shape:
//   { name: "camera", type: "mjpeg-stream", port: 81, path: "/stream",
//     profile?: "compact|standard|full",
//     profiles?: ["compact", "standard", "full"] }
// Unlike the Pi webrtc-installable cap, there's no BLE signaling — the
// dashboard just opens http://<ip>:<port><path> with a plain <img>. Works
// only when the dashboard's browser and the robot share a network.
// Profile picker is rendered when the schema carries a `profiles` list;
// writes go to CAMERA_PROFILE_CHAR_UUID, firmware persists + restarts.
import { CAMERA_PROFILE_CHAR_UUID, encodeJson } from "../../ble.js";
import { escapeHtml } from "../../dom.js";
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

  const profileField = `${name}ProfileChar`;
  const actionProfile = `${name}-profile`;
  return {
    name,
    schema,
    initEntry: () => ({ [runningField]: false, [watchingField]: false, [profileField]: null }),
    async probe(entry, service) {
      // Optional — only ESP32 advertises the profile schema, only ESP32
      // exposes the char. Failure to find it just means no picker UI.
      try { entry[profileField] = await service.getCharacteristic(CAMERA_PROFILE_CHAR_UUID); }
      catch { entry[profileField] = null; }
    },
    cleanup(entry)  {
      entry[runningField] = false;
      if (entry[watchingField]) { visionStop(entry.id); entry[watchingField] = false; }
      stopMjpegForward(entry);
      entry[profileField] = null;
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
      // Profile picker: only when fw-info advertises profiles + the char
      // probe found the write target. Compact dropdown right under the
      // stream (or status); writes restart the device, so don't ship this
      // for non-ESP32 caps.
      const profiles = Array.isArray(schema.profiles) ? schema.profiles : null;
      const currentProfile = schema.profile;
      const profileRow = (profiles && entry[profileField])
        ? `<div class="cap-profile">
             <label>Camera profile
               <select data-action="${actionProfile}">
                 ${profiles.map(p => `<option value="${escapeHtml(p)}" ${p === currentProfile ? "selected" : ""}>${escapeHtml(p)}</option>`).join("")}
               </select>
             </label>
             <span class="meta">changing profile restarts the robot</span>
           </div>`
        : "";
      const stateText = !url ? "Waiting for WiFi"
                      : running ? "streaming"
                      : "ready";
      return capSection({
        name,
        label,
        state: stateText,
        action,
        body: `${body}${watchRow}${promptField}${profileRow}`,
      });
    },

    wireActions(entry, node) {
      node.querySelector(`[data-action="${actionStart}"]`)?.addEventListener("click", () => {
        entry[runningField] = true;
        renderEntry(entry);
        // Canvas-restream after render so the <img> exists. Load event
        // inside startMjpegForward handles the "img not decoded yet" case.
        const img = entry.node?.querySelector(`img.robot-camera[data-cam-id="${entry.id}"]`);
        if (img) startMjpegForward(entry, img);
      });
      node.querySelector(`[data-action="${actionStop}"]`)?.addEventListener("click", () => {
        if (entry[watchingField]) { visionStop(entry.id); entry[watchingField] = false; }
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
      wirePerceptionToggle(entry, node, {
        watchingAction: actionWatch, watchingField, onRender: renderEntry,
      });
      wirePerceptionPrompt(entry, node, { editAction: actionPrompt, onRender: renderEntry });
      // Profile picker: write the new profile JSON; firmware restarts so
      // the BLE link drops shortly after the ack. Confirm before firing —
      // restart is a heavy thing and the user might have hit it by mistake.
      const sel = node.querySelector(`[data-action="${actionProfile}"]`);
      if (sel) sel.addEventListener("change", async () => {
        const next = sel.value;
        if (next === schema.profile) return;
        if (!confirm(`Switch camera to "${next}" profile?\n\nRobot will restart to apply (~30 s).`)) {
          sel.value = schema.profile || "";
          return;
        }
        try {
          await entry[profileField].writeValueWithResponse(encodeJson({ profile: next }));
          logFor(entry, `camera profile → ${next} (robot restarting)`);
        } catch (err) {
          logFor(entry, `profile write failed: ${err.message}`);
          sel.value = schema.profile || "";
        }
      });
    },
  };
}
