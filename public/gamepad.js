// Polling stops when the last pad disconnects so idle cost is zero.
import { $ } from "./dom.js";
import { log } from "./log.js";
import { state } from "./state.js";
import { sendPairById } from "./capabilities/runtime/signed-pair.js";

const GAMEPAD_DEADZONE = 0.10;
let _gamepadTargetId = null;
let _gamepadRafHandle = null;
let _lastSent = { id: null, l: 0, r: 0 };

function pickGamepadTarget() {
  if (_gamepadTargetId) {
    const e = state.devices.get(_gamepadTargetId);
    if (e && e.motorsChar && e.status === "connected") return _gamepadTargetId;
  }
  for (const e of state.devices.values()) {
    if (e.motorsChar && e.status === "connected") return e.id;
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
    const l = toMotor(ly);
    const r = toMotor(ry);
    // Pi has a 500 ms motor watchdog — held-stick must keep refreshing it,
    // so only skip when both current and last frame are at-rest (0,0).
    // The transition to (0,0) still writes once so motors stop immediately
    // rather than waiting for the watchdog.
    const atRest = l === 0 && r === 0 && _lastSent.l === 0 && _lastSent.r === 0
      && id === _lastSent.id;
    if (!atRest) {
      sendPairById(id, "motors", l, r);
      _lastSent = { id, l, r };
    }
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
