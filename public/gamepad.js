// Physical gamepad → motor control. Not a BLE capability; a browser-side
// input driver that routes through motors.sendMotors on every RAF tick while
// a pad is attached. Polling stops when the last pad disconnects so idle
// cost is zero.
import { $ } from "./dom.js";
import { log } from "./log.js";
import { state } from "./state.js";
import { sendMotors } from "./capabilities/motors.js";

const GAMEPAD_DEADZONE = 0.10;
let _gamepadTargetId = null;
let _gamepadRafHandle = null;

function pickGamepadTarget() {
  if (_gamepadTargetId) {
    const e = state.devices.get(_gamepadTargetId);
    if (e && e.motorChar && e.status === "connected") return _gamepadTargetId;
  }
  for (const e of state.devices.values()) {
    if (e.motorChar && e.status === "connected") return e.id;
  }
  return null;
}

function renderGamepadBadge(targetId, padName) {
  const box = $("gamepad-badge");
  if (!box) return;
  if (!targetId) { box.hidden = true; return; }
  const entry = state.devices.get(targetId);
  box.hidden = false;
  box.textContent = `🎮 ${padName || "gamepad"} → ${entry?.name || "?"}`;
}

function gamepadTick() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = [...pads].find(p => p && p.connected);
  if (!pad) {
    _gamepadRafHandle = null;
    renderGamepadBadge();
    return;
  }
  const id = pickGamepadTarget();
  if (id) {
    const ly = pad.axes[1] ?? 0;  // left stick Y (down = +1)
    const ry = pad.axes[3] ?? 0;  // right stick Y
    const toMotor = (v) => {
      const dz = Math.abs(v) < GAMEPAD_DEADZONE ? 0 : v;
      return Math.round(-dz * 100);  // invert so stick-up = forward
    };
    sendMotors(id, toMotor(ly), toMotor(ry));
  }
  renderGamepadBadge(id, pad.id);
  _gamepadRafHandle = requestAnimationFrame(gamepadTick);
}

function startGamepadLoop() {
  if (_gamepadRafHandle) return;
  _gamepadRafHandle = requestAnimationFrame(gamepadTick);
}

export function initGamepad() {
  window.addEventListener("gamepadconnected", (e) => {
    log(`Gamepad connected: ${e.gamepad.id}`);
    startGamepadLoop();
  });
  window.addEventListener("gamepaddisconnected", (e) => {
    log(`Gamepad disconnected: ${e.gamepad.id}`);
    renderGamepadBadge();
  });
  if (navigator.getGamepads && [...navigator.getGamepads()].some(p => p)) {
    startGamepadLoop();
  }
}
