// Schema: { name: "balance-bot", type: "balance-bot" }
//
// Four sections in one card:
//   1. Joypad    — writes [lean%, turn%] to BALANCE_CMD_CHAR at ~5 Hz.
//                  Lean (Y axis) tilts the setpoint; turn (X axis) adds
//                  a differential directly. No mix() — the firmware mixes.
//   2. PID       — P / I / D number inputs. Sends on blur or Enter.
//                  State line shows live pitch from BALANCE_STATE_CHAR.
//   3. I-dump    — dropdown auto-writes on change; no OK button needed.
//   4. Goto      — X / Y / θ inputs with Go and Cancel. Phase-1 stub:
//                  char is wired, firmware stores target but doesn't drive
//                  to it until CV localization is available (cv branch).
import { UUIDS_BY_CAP, encodeJson, decodeJson } from "../../ble.js";
import { escapeHtml } from "../../dom.js";
import { logFor } from "../../log.js";
import { capSection, isOpen } from "./cap-section.js";
import { renderEntry } from "./render-bus.js";

const CHARS = UUIDS_BY_CAP["balance-bot"];

// ── BLE write helpers ────────────────────────────────────────────────────────

async function writeCmd(entry, lean, turn) {
  const ch = entry.balanceCmdChar;
  if (!ch) return;
  const v = new Int8Array([lean, turn]);
  try {
    await ch.writeValueWithoutResponse(new Uint8Array(v.buffer));
  } catch (e) {
    logFor(entry, `balance cmd write failed: ${e.message}`);
  }
}

async function writePid(entry) {
  const ch = entry.balancePidChar;
  if (!ch) return;
  const payload = {
    p: entry.balancePidP,
    i: entry.balancePidI,
    d: entry.balancePidD,
    idump_s: entry.balanceIdumpS,
  };
  try {
    await ch.writeValueWithResponse(encodeJson(payload));
  } catch (e) {
    logFor(entry, `balance PID write failed: ${e.message}`);
  }
}

async function writeTarget(entry, active) {
  const ch = entry.balanceTargetChar;
  if (!ch) return;
  const payload = {
    x: entry.balanceTargetX,
    y: entry.balanceTargetY,
    theta: entry.balanceTargetTheta,
    active,
  };
  try {
    await ch.writeValueWithResponse(encodeJson(payload));
  } catch (e) {
    logFor(entry, `balance target write failed: ${e.message}`);
  }
}

// ── Joypad (no mix — sends raw lean/turn) ───────────────────────────────────

function wireBalanceJoypad(entry, pad, knob) {
  let activeId = null;
  let holdTimer = null;
  let lastLean = 0, lastTurn = 0;
  let rafId = null;
  let pending = null;

  const sendFromXY = (cx, cy) => {
    const rect = pad.getBoundingClientRect();
    const radius = rect.width / 2;
    const dx = cx - (rect.left + radius);
    const dy = cy - (rect.top + radius);
    const dist = Math.min(1, Math.hypot(dx, dy) / radius);
    const angle = Math.atan2(dy, dx);
    const nx = Math.cos(angle) * dist;
    const ny = Math.sin(angle) * dist;
    knob.style.transform = `translate(${nx * radius}px, ${ny * radius}px)`;
    lastLean = Math.max(-100, Math.min(100, Math.round(-ny * 100)));
    lastTurn = Math.max(-100, Math.min(100, Math.round(nx * 100)));
    writeCmd(entry, lastLean, lastTurn);
  };

  const scheduleUpdate = (x, y) => {
    pending = [x, y];
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (!pending) return;
      const [px, py] = pending;
      pending = null;
      sendFromXY(px, py);
    });
  };

  const onMove = (e) => {
    if (e.pointerId !== activeId) return;
    e.preventDefault();
    scheduleUpdate(e.clientX, e.clientY);
  };

  const detach = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };

  const clear = () => {
    if (activeId === null) return;
    activeId = null;
    detach();
    if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    pending = null;
    pad.classList.remove("dragging");
    knob.style.transform = "";
    lastLean = lastTurn = 0;
  };

  function onUp(e) {
    if (e && e.pointerId !== activeId) return;
    clear();
    writeCmd(entry, 0, 0);
  }

  pad.addEventListener("pointerdown", (e) => {
    if (activeId !== null) return;
    e.preventDefault();
    activeId = e.pointerId;
    pad.classList.add("dragging");
    sendFromXY(e.clientX, e.clientY);
    holdTimer = setInterval(() => writeCmd(entry, lastLean, lastTurn), 200);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });

  return { reset: clear };
}

// ── Capability factory ───────────────────────────────────────────────────────

export function makeBalanceBotCap(schema) {
  const name = schema.name || "balance-bot";

  return {
    name,
    schema,

    initEntry: () => ({
      balanceCmdChar:    null,
      balancePidChar:    null,
      balanceStateChar:  null,
      balanceTargetChar: null,
      balancePitch:      null,   // live from state notify
      balanceSp:         null,
      balanceMode:       null,
      balancePidP:       15,
      balancePidI:       0.5,
      balancePidD:       1.2,
      balanceIdumpS:     0,
      balanceTargetX:    0,
      balanceTargetY:    0,
      balanceTargetTheta: 0,
    }),

    async probe(entry, service) {
      try {
        entry.balanceCmdChar = await service.getCharacteristic(CHARS.cmd);
      } catch { entry.balanceCmdChar = null; }

      try {
        entry.balancePidChar = await service.getCharacteristic(CHARS.pid);
        const cur = await entry.balancePidChar.readValue();
        const parsed = decodeJson(cur);
        if (parsed) {
          if (parsed.p != null) entry.balancePidP = parsed.p;
          if (parsed.i != null) entry.balancePidI = parsed.i;
          if (parsed.d != null) entry.balancePidD = parsed.d;
          if (parsed.idump_s != null) entry.balanceIdumpS = parsed.idump_s;
        }
        await entry.balancePidChar.startNotifications();
        entry.balancePidChar.addEventListener("characteristicvaluechanged", (e) => {
          const p = decodeJson(e.target.value);
          if (!p) return;
          if (p.p != null) entry.balancePidP = p.p;
          if (p.i != null) entry.balancePidI = p.i;
          if (p.d != null) entry.balancePidD = p.d;
          if (p.idump_s != null) entry.balanceIdumpS = p.idump_s;
          patchPidDisplay(entry);
        });
      } catch { entry.balancePidChar = null; }

      try {
        entry.balanceStateChar = await service.getCharacteristic(CHARS.state);
        await entry.balanceStateChar.startNotifications();
        entry.balanceStateChar.addEventListener("characteristicvaluechanged", (e) => {
          const s = decodeJson(e.target.value);
          if (!s) return;
          entry.balancePitch = s.pitch;
          entry.balanceSp    = s.sp;
          entry.balanceMode  = s.mode;
          patchStateDisplay(entry);
        });
      } catch { entry.balanceStateChar = null; }

      try {
        entry.balanceTargetChar = await service.getCharacteristic(CHARS.target);
      } catch { entry.balanceTargetChar = null; }
    },

    cleanup(entry) {
      entry.balanceCmdChar = entry.balancePidChar =
        entry.balanceStateChar = entry.balanceTargetChar = null;
    },

    renderSection(entry) {
      if (entry.status !== "connected" || !entry.balanceCmdChar) return "";

      const pitch = entry.balancePitch != null
        ? `pitch ${entry.balancePitch.toFixed(1)}°`
        : "connecting…";
      const modeStr = entry.balanceMode ? ` · ${entry.balanceMode}` : "";
      const stateText = pitch + modeStr;

      const body = `
        <div class="joypad-wrap" data-action="balance-joypad">
          <div class="joypad"><div class="joypad-knob"></div></div>
        </div>
        <div class="balance-pid-section">
          <div class="balance-pid-row">
            <label>P <input class="balance-pid-input" data-pid="p"
              type="number" step="0.1" min="0"
              value="${escapeHtml(String(entry.balancePidP))}"></label>
            <label>I <input class="balance-pid-input" data-pid="i"
              type="number" step="0.01" min="0"
              value="${escapeHtml(String(entry.balancePidI))}"></label>
            <label>D <input class="balance-pid-input" data-pid="d"
              type="number" step="0.01" min="0"
              value="${escapeHtml(String(entry.balancePidD))}"></label>
          </div>
          <div class="balance-idump-row">
            <label>I-dump
              <select class="balance-idump-select">
                ${[0,1,2,5,10,30].map(s =>
                  `<option value="${s}" ${entry.balanceIdumpS === s ? "selected" : ""}>
                     ${s === 0 ? "Off" : s + "s"}
                   </option>`
                ).join("")}
              </select>
            </label>
          </div>
        </div>
        <div class="balance-goto-section">
          <div class="balance-goto-row">
            <label>X <input class="balance-goto-input" data-goto="x"
              type="number" step="10"
              value="${escapeHtml(String(entry.balanceTargetX))}"> mm</label>
            <label>Y <input class="balance-goto-input" data-goto="y"
              type="number" step="10"
              value="${escapeHtml(String(entry.balanceTargetY))}"> mm</label>
            <label>θ <input class="balance-goto-input" data-goto="theta"
              type="number" step="5"
              value="${escapeHtml(String(entry.balanceTargetTheta))}">°</label>
            <button class="secondary sm" data-action="balance-go">Go</button>
            <button class="secondary sm" data-action="balance-cancel">Cancel</button>
          </div>
          <div class="meta">Goto requires overhead CV localization (cv branch).</div>
        </div>`;

      const action = `<button class="secondary sm" data-action="balance-stop">Stop</button>`;
      return capSection({ name, label: "Balance Bot", state: stateText, action, body, transport: "ble" });
    },

    wireActions(entry, node) {
      // Joypad
      const pad = node.querySelector(".joypad");
      const knob = pad?.querySelector(".joypad-knob");
      let joypad = null;
      if (pad && knob) joypad = wireBalanceJoypad(entry, pad, knob);

      // Stop button
      node.querySelector("[data-action='balance-stop']")?.addEventListener("click", () => {
        joypad?.reset();
        writeCmd(entry, 0, 0);
      });

      // PID inputs — send on blur or Enter
      const sendPid = () => writePid(entry);
      node.querySelectorAll(".balance-pid-input").forEach(input => {
        const key = input.dataset.pid;
        input.addEventListener("change", () => {
          const v = parseFloat(input.value);
          if (!isNaN(v) && v >= 0) {
            if (key === "p") entry.balancePidP = v;
            if (key === "i") entry.balancePidI = v;
            if (key === "d") entry.balancePidD = v;
            sendPid();
          }
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { input.blur(); }
        });
      });

      // I-dump select — immediate write on change, no OK
      node.querySelector(".balance-idump-select")?.addEventListener("change", (e) => {
        entry.balanceIdumpS = parseInt(e.target.value, 10) || 0;
        sendPid();
      });

      // Goto inputs
      node.querySelectorAll(".balance-goto-input").forEach(input => {
        input.addEventListener("change", () => {
          const k = input.dataset.goto;
          const v = parseFloat(input.value);
          if (!isNaN(v)) {
            if (k === "x")     entry.balanceTargetX     = v;
            if (k === "y")     entry.balanceTargetY     = v;
            if (k === "theta") entry.balanceTargetTheta = v;
          }
        });
      });

      node.querySelector("[data-action='balance-go']")?.addEventListener("click", () => {
        writeTarget(entry, true);
      });
      node.querySelector("[data-action='balance-cancel']")?.addEventListener("click", () => {
        writeTarget(entry, false);
      });
    },
  };
}

// ── Surgical DOM patchers (avoid full re-render on notify) ───────────────────

function patchStateDisplay(entry) {
  const node = entry.node;
  if (!node) return;
  const sec = node.querySelector(`.cap-section[data-cap-name="balance-bot"]`);
  if (!sec) return;
  const stateEl = sec.querySelector(".cap-state");
  if (!stateEl) return;
  const pitch = entry.balancePitch != null
    ? `pitch ${entry.balancePitch.toFixed(1)}°`
    : "connecting…";
  const modeStr = entry.balanceMode ? ` · ${entry.balanceMode}` : "";
  stateEl.textContent = pitch + modeStr;
}

function patchPidDisplay(entry) {
  const node = entry.node;
  if (!node) return;
  const sec = node.querySelector(`.cap-section[data-cap-name="balance-bot"]`);
  if (!sec) return;
  // Only patch inputs that are not focused (don't fight the user's typing).
  sec.querySelectorAll(".balance-pid-input").forEach(input => {
    if (document.activeElement === input) return;
    const key = input.dataset.pid;
    if (key === "p" && entry.balancePidP != null) input.value = entry.balancePidP;
    if (key === "i" && entry.balancePidI != null) input.value = entry.balancePidI;
    if (key === "d" && entry.balancePidD != null) input.value = entry.balancePidD;
  });
  const sel = sec.querySelector(".balance-idump-select");
  if (sel && document.activeElement !== sel) sel.value = String(entry.balanceIdumpS);
}
