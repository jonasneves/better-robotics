// Motion-control cap: manual joypad + x/y/theta pose targeting over BLE.
// Schema: { name: "motion", type: "pose-control" }
// Three chars: goal (write JSON), pose (write JSON), status (notify JSON).
// Manual mode drives motorsChar directly so the Pi's diff-drive kinematics
// apply the same way as the dedicated motors card.

import { UUIDS_BY_CAP, encodeJson, decodeJson } from "../../ble.js";
import { attachJoypad } from "../../joypad.js";
import { setPairValue } from "./signed-pair.js";
import { logFor } from "../../log.js";
import { capSection } from "./cap-section.js";
import { renderEntry } from "./render-bus.js";

const LS_PREFIX = "better-robotics:motion";

function lsGet(entry, k, def = "") {
  try {
    const v = localStorage.getItem(`${LS_PREFIX}:${k}:${entry.name}`);
    return v != null ? v : def;
  } catch { return def; }
}
function lsSet(entry, k, v) {
  try { localStorage.setItem(`${LS_PREFIX}:${k}:${entry.name}`, String(v)); } catch {}
}

export function makeMotionCap(schema) {
  const { name } = schema;

  return {
    name,
    schema,

    initEntry: () => ({
      motionGoalChar:   null,
      motionPoseChar:   null,
      motionStatusChar: null,
      motionStatus:     "idle",
      _motionJoypad:    null,
    }),

    async probe(entry, service) {
      const uuids = UUIDS_BY_CAP.motion;
      try {
        entry.motionGoalChar   = await service.getCharacteristic(uuids.goal);
        entry.motionPoseChar   = await service.getCharacteristic(uuids.pose);
        entry.motionStatusChar = await service.getCharacteristic(uuids.status);
        try {
          const v = await entry.motionStatusChar.readValue();
          const msg = decodeJson(v);
          if (msg?.st) entry.motionStatus = msg.st;
        } catch {}
        await entry.motionStatusChar.startNotifications();
        entry.motionStatusChar.addEventListener("characteristicvaluechanged", (e) => {
          const msg = decodeJson(e.target.value);
          if (!msg?.st) return;
          entry.motionStatus = msg.st;
          // Surgical update — avoid full re-render during active movement.
          const sec = entry.node?.querySelector(`.cap-section[data-cap-name="${name}"]`);
          if (sec) {
            const stateEl = sec.querySelector(".cap-state");
            if (stateEl) stateEl.textContent = entry.motionStatus;
            const bodyEl = sec.querySelector("[data-motion-status]");
            if (bodyEl) bodyEl.textContent = entry.motionStatus;
          } else {
            renderEntry(entry);
          }
          logFor(entry, `motion → ${entry.motionStatus}`);
        });
      } catch (err) {
        logFor(entry, `motion probe failed: ${err.message}`);
        entry.motionGoalChar = null;
      }
    },

    cleanup(entry) {
      entry._motionJoypad?.destroy();
      entry._motionJoypad = null;
      entry.motionGoalChar = entry.motionPoseChar = entry.motionStatusChar = null;
    },

    renderSection(entry) {
      if (entry.status !== "connected" || !entry.motionGoalChar) return "";
      const uiMode = lsGet(entry, "mode", "manual");
      const ctrl   = lsGet(entry, "ctrl", "spin_move_spin");
      const x      = lsGet(entry, "x",   "0");
      const y      = lsGet(entry, "y",   "0");
      const theta  = lsGet(entry, "theta", "0");
      const wSep   = lsGet(entry, "wheel_sep", "");
      const wR     = lsGet(entry, "wheel_r",   "");
      const maxSpd = lsGet(entry, "max_spd",   "");
      const st     = entry.motionStatus;

      const modeSeg = `
        <div class="segmented motion-mode-seg">
          <button class="mode-btn" data-action="motion-tab-manual"
            aria-pressed="${uiMode === "manual"}" type="button">Manual</button>
          <button class="mode-btn" data-action="motion-tab-pose"
            aria-pressed="${uiMode === "pose"}" type="button">Pose Control</button>
        </div>`;

      const manualContent = `
        <div class="joypad-wrap">
          <div class="joypad"><div class="joypad-knob"></div></div>
        </div>`;

      const poseContent = `
        <div class="motion-pose-fields">
          <label>X (m)<input type="number" step="0.01" value="${x}"
            data-motion-field="x" data-action="motion-x"></label>
          <label>Y (m)<input type="number" step="0.01" value="${y}"
            data-motion-field="y" data-action="motion-y"></label>
          <label>θ (°)<input type="number" step="1" value="${theta}"
            data-motion-field="theta" data-action="motion-theta"></label>
        </div>
        <div class="segmented motion-ctrl-seg">
          <button class="mode-btn" data-action="motion-ctrl-sms"
            aria-pressed="${ctrl === "spin_move_spin"}" type="button">Pose · Move · Pose</button>
          <button class="mode-btn" data-action="motion-ctrl-cont"
            aria-pressed="${ctrl === "continuous"}" type="button">Continuous</button>
        </div>
        <div class="motion-go-row">
          <button class="primary sm" data-action="motion-go" type="button">Go</button>
          <button class="secondary sm" data-action="motion-cancel" type="button">Cancel</button>
          <span class="motion-status-pill" data-motion-status>${st}</span>
        </div>
        <details class="motion-wheel-config">
          <summary>Wheel config</summary>
          <div class="motion-wheel-fields">
            <label>Separation (m)<input type="number" step="0.001"
              ${wSep ? `value="${wSep}"` : ""} placeholder="from pi-robot.conf"
              data-motion-field="wheel_sep" data-action="motion-wheel-sep"></label>
            <label>Radius (m)<input type="number" step="0.001"
              ${wR ? `value="${wR}"` : ""} placeholder="from pi-robot.conf"
              data-motion-field="wheel_r" data-action="motion-wheel-r"></label>
            <label>Max speed (m/s)<input type="number" step="0.01"
              ${maxSpd ? `value="${maxSpd}"` : ""} placeholder="from pi-robot.conf"
              data-motion-field="max_spd" data-action="motion-max-spd"></label>
          </div>
        </details>`;

      const body = `${modeSeg}${uiMode === "manual" ? manualContent : poseContent}`;

      return capSection({
        name,
        label: "Motion",
        state: st,
        action: `<button class="secondary sm" data-action="motion-stop" type="button">Stop</button>`,
        body,
        transport: "ble",
      });
    },

    wireActions(entry, node) {
      // Destroy any in-progress joypad drag from the previous render cycle.
      entry._motionJoypad?.destroy();
      entry._motionJoypad = null;

      // Mode tabs
      node.querySelector("[data-action='motion-tab-manual']")?.addEventListener("click", () => {
        lsSet(entry, "mode", "manual");
        renderEntry(entry);
      });
      node.querySelector("[data-action='motion-tab-pose']")?.addEventListener("click", () => {
        lsSet(entry, "mode", "pose");
        renderEntry(entry);
      });

      // Stop — cancel goal + zero motors
      node.querySelector("[data-action='motion-stop']")?.addEventListener("click", async () => {
        entry._motionJoypad?.reset?.();
        if (entry.motionGoalChar) {
          try { await entry.motionGoalChar.writeValueWithResponse(encodeJson({ op: "cancel" })); }
          catch (err) { logFor(entry, `motion stop: ${err.message}`); }
        }
        setPairValue(entry, "motors", 0, 0);
      });

      const uiMode = lsGet(entry, "mode", "manual");

      if (uiMode === "manual") {
        const pad  = node.querySelector(".joypad");
        const knob = pad?.querySelector(".joypad-knob");
        if (pad && knob) {
          entry._motionJoypad = attachJoypad(pad, knob, {
            onDrive: (l, r) => setPairValue(entry, "motors", l, r),
            onStop:  ()     => setPairValue(entry, "motors", 0, 0),
          });
        }
      } else {
        // Controller type toggle — surgical aria-pressed swap, no re-render.
        const ctrlSms  = node.querySelector("[data-action='motion-ctrl-sms']");
        const ctrlCont = node.querySelector("[data-action='motion-ctrl-cont']");
        ctrlSms?.addEventListener("click", () => {
          lsSet(entry, "ctrl", "spin_move_spin");
          ctrlSms.setAttribute("aria-pressed", "true");
          ctrlCont?.setAttribute("aria-pressed", "false");
        });
        ctrlCont?.addEventListener("click", () => {
          lsSet(entry, "ctrl", "continuous");
          ctrlCont.setAttribute("aria-pressed", "true");
          ctrlSms?.setAttribute("aria-pressed", "false");
        });

        // Persist field edits to localStorage on blur/enter.
        node.querySelectorAll("[data-motion-field]").forEach(el => {
          el.addEventListener("change", () => lsSet(entry, el.dataset.motionField, el.value));
        });

        // Go
        node.querySelector("[data-action='motion-go']")?.addEventListener("click", async () => {
          if (!entry.motionGoalChar) return;
          const get = (a) => node.querySelector(`[data-action="${a}"]`)?.value;
          const xVal  = parseFloat(get("motion-x")     || "0");
          const yVal  = parseFloat(get("motion-y")     || "0");
          const tDeg  = parseFloat(get("motion-theta") || "0");
          const tRad  = tDeg * (Math.PI / 180);
          const ctrl  = lsGet(entry, "ctrl", "spin_move_spin");
          const msg   = { x: xVal, y: yVal, theta: tRad, mode: ctrl };
          const sep   = parseFloat(get("motion-wheel-sep") || "");
          const rad   = parseFloat(get("motion-wheel-r")   || "");
          const spd   = parseFloat(get("motion-max-spd")   || "");
          if (sep > 0) msg.wheel_sep = sep;
          if (rad > 0) msg.wheel_r   = rad;
          if (spd > 0) msg.max_spd   = spd;
          try {
            await entry.motionGoalChar.writeValueWithResponse(encodeJson(msg));
            logFor(entry, `motion go (${xVal}, ${yVal}, ${tDeg}°) ${ctrl}`);
          } catch (err) {
            logFor(entry, `motion go failed: ${err.message}`);
          }
        });

        // Cancel
        node.querySelector("[data-action='motion-cancel']")?.addEventListener("click", async () => {
          if (!entry.motionGoalChar) return;
          try { await entry.motionGoalChar.writeValueWithResponse(encodeJson({ op: "cancel" })); }
          catch (err) { logFor(entry, `motion cancel: ${err.message}`); }
        });
      }
    },
  };
}
