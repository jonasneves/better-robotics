// Generic virtual joypad — pointer events on a circular pad + knob, emits
// (left, right) motor values via onDrive. Shared between the desktop motor
// card (capabilities/runtime/signed-pair.js) and the phone page (mobile.js).
//
// Pattern copied from nipplejs (github.com/yoannmoinet/nipplejs, 14k★):
// window-attached move/up instead of setPointerCapture (more reliable across
// iOS Safari / mobile Chrome), RAF-throttled updates to coalesce 120+ Hz
// pointer bursts, and a configurable heartbeat so consumers that feed a BLE
// watchdog don't need their own timer. preventDefault on down/move stops
// text selection and image drag from hijacking the gesture.

// Differential mix: (throttle, turn) ∈ [-100, 100] → (L, R).
//
// Operator-perspective convention: when reversing, "right" still means
// "robot ends up to the operator's right." Without the sign flip, raw
// tank-drive math (L = throttle + turn) preserves "left motor faster than
// right" in the robot's body frame — which from an external operator's
// view inverts the turn direction during reverse (push joystick top-right
// → robot turns right ✓; push bottom-right → robot turns LEFT, which is
// disorienting for someone driving an RC toy from outside it).
//
// The flip aligns the tilt joypad, tilt-drive, and keyboard mappings to
// the same "external observer" model — what every RC car / video game
// uses. Tank-drive purists can mentally undo the flip; for the toy-scale
// scope this project targets, operator clarity wins.
export function mix(throttle, turn) {
  const c = (v) => Math.max(-100, Math.min(100, Math.round(v)));
  if (throttle < 0) turn = -turn;
  return [c(throttle + turn), c(throttle - turn)];
}

export function attachJoypad(pad, knob, { onDrive, onStop, heartbeatMs = 200 } = {}) {
  let activePointerId = null;
  let holdTimer = null;
  let lastL = 0, lastR = 0;
  let rafPending = null;
  let pendingXY = null;

  const updateFromXY = (clientX, clientY) => {
    const rect = pad.getBoundingClientRect();
    const radius = rect.width / 2;
    const dx = clientX - (rect.left + radius);
    const dy = clientY - (rect.top + radius);
    const dist = Math.min(1, Math.hypot(dx, dy) / radius);
    const angle = Math.atan2(dy, dx);
    const nx = Math.cos(angle) * dist;
    const ny = Math.sin(angle) * dist;
    knob.style.transform = `translate(${nx * radius}px, ${ny * radius}px)`;
    [lastL, lastR] = mix(-ny * 100, nx * 100);  // Y inverted: up = +throttle
    onDrive?.(lastL, lastR);
  };

  const scheduleUpdate = (x, y) => {
    pendingXY = [x, y];
    if (rafPending) return;
    rafPending = requestAnimationFrame(() => {
      rafPending = null;
      if (!pendingXY) return;
      const [cx, cy] = pendingXY;
      pendingXY = null;
      updateFromXY(cx, cy);
    });
  };

  const onMove = (e) => {
    if (e.pointerId !== activePointerId) return;
    e.preventDefault();
    scheduleUpdate(e.clientX, e.clientY);
  };

  const detach = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };

  // Shared by release events and the external reset — external reset skips
  // the onStop emit so the caller can do its own cleanup write (e.g. Stop
  // button writes (0, 0) itself after resetting the joypad state).
  const clearDragState = () => {
    if (activePointerId === null) return;
    activePointerId = null;
    detach();
    if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
    if (rafPending) { cancelAnimationFrame(rafPending); rafPending = null; }
    pendingXY = null;
    pad.classList.remove("dragging");
    knob.style.transform = "";
    lastL = lastR = 0;
  };

  function onUp(e) {
    if (e && e.pointerId !== activePointerId) return;
    clearDragState();
    onStop?.();
  }

  const onDown = (e) => {
    if (activePointerId !== null) return;
    e.preventDefault();
    activePointerId = e.pointerId;
    pad.classList.add("dragging");
    updateFromXY(e.clientX, e.clientY);
    if (heartbeatMs > 0) {
      holdTimer = setInterval(() => onDrive?.(lastL, lastR), heartbeatMs);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  pad.addEventListener("pointerdown", onDown);

  return {
    reset: clearDragState,
    destroy: () => { clearDragState(); pad.removeEventListener("pointerdown", onDown); },
  };
}
