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

import { renderEntry } from "./render-bus.js";

// Camera streaming needs the chip on WiFi for WebRTC ICE — BLE can
// signal the SDP but the actual media path is P2P over the LAN.
function hasWifi(entry) { return !!entry.wifiStatus?.ip; }

// Open a WebRTC `video` data channel, ask the firmware for a stream at
// 10 fps, render incoming binary frames into the existing <img> via
// blob URLs. Returns a disposer; null on open failure.
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
  const onMsg = (e) => {
    if (typeof e.data === "string") return;  // ignore control replies
    const blob = new Blob([e.data], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    img.src = url;
    // Revoke the previous URL only after the new one is assigned —
    // otherwise the browser may release the bytes while still decoding.
    if (prevUrl) URL.revokeObjectURL(prevUrl);
    prevUrl = url;
  };
  channel.addEventListener("message", onMsg);
  try { channel.send(JSON.stringify({ type: "start", fps: 10 })); } catch {}
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

    renderSection(entry, { childHtml = "", sourceMember = null, alternativeMemberIds = [] } = {}) {
      if (entry.status !== "connected") return "";
      const wifi = hasWifi(entry);
      const running = entry[runningField];
      const watching = entry[watchingField];
      let body = "";
      if (!wifi) {
        body = `<div class="meta">Waiting for the robot to join WiFi — video needs a LAN IP.</div>`;
      } else if (running) {
        // crossOrigin lets perception.js's canvas read the pixels.
        // No src at render time — the click handler attaches frames
        // via blob URLs as the WebRTC data channel delivers them.
        body = `<img class="robot-camera" crossorigin="anonymous" data-cam-id="${entry.id}" alt="WebRTC video">`;
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
      // State string only when it adds info beyond the action verb. Action
      // says Start/Stop already; "ready"/"streaming" would just echo it.
      // "Waiting for WiFi" earns its place — the button is disabled and the
      // user needs to know why.
      const stateText = !wifi ? "Waiting for WiFi" : "";
      return capSection({
        name,
        label,
        state: stateText,
        action,
        // Child caps (Flash, Snapshot — schema-flat, conceptually camera
        // sub-controls) render here so the operator sees one Camera section
        // hosting everything camera-shaped instead of three peers in a flat list.
        body: `${body}${watchRow}${promptField}${profileRow}${childHtml}`,
        transport: "wifi",
        sourceMember, alternativeMemberIds,
      });
    },

    wireActions(entry, node) {
      node.querySelector(`[data-action="${actionStart}"]`)?.addEventListener("click", async () => {
        entry[runningField] = true;
        renderEntry(entry);
        const img = entry.node?.querySelector(`img.robot-camera[data-cam-id="${entry.id}"]`);
        if (!img) return;

        // ESP32 path: WebRTC video only. firmware/webrtc_peer.c routes
        // a `video` data channel into an esp_camera_fb_get loop, sending
        // each JPEG as binary. Browser blob-URLs each frame into the
        // img. Same-origin tabs share the single peer slot via
        // CamTabCoordinator (Phase 2.H step 1).
        if (entry.fwType === "esp32") {
          const ctrl = await startEsp32WebRTCVideo(entry, img);
          if (ctrl) {
            entry._webrtcVideo = ctrl;
            if (!entry[runningField]) { ctrl.dispose(); entry._webrtcVideo = null; return; }
            startMjpegForward(entry, img);
            return;
          }
          // WebRTC unavailable. No HTTP fallback — that would be mixed-
          // content from HTTPS dashboards anyway, and wasn't actually
          // saving anyone (Phase 2.H retired chip HTTP). Reset running
          // so the Start button comes back instead of hanging.
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
