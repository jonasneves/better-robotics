import { $ } from "./dom.js";
import { joinPairingRoom } from "./pairing.js";
import { attachJoypad, mix } from "./joypad.js";
import { discover } from "./discover.js";
import { getMyPubkeyB64 } from "./peer-key.js";
import { makeTrustStore } from "./trust.js";
import { pairRequestClient } from "./pair-request.js";
const _trust = makeTrustStore("better-robotics:trust:v1");

let _peer = null;
let _pending = false;
let _joypad = null;

// Install prompt. Chromium fires beforeinstallprompt; iOS Safari never does
// — for iOS we show manual Share→Add-to-Home-Screen copy. Affordance lives
// in the app-menu popover (parallels the dashboard's wordmark popover).
let _deferredInstallPrompt = null;
function _isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches
      || window.navigator.standalone === true;
}
function _isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
function _updateInstallMenuItem() {
  const btn = $("menu-install");
  if (!btn) return;
  if (_isStandalone()) { btn.hidden = true; return; }
  btn.hidden = !(_deferredInstallPrompt || _isIOS());
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  _updateInstallMenuItem();
});
window.addEventListener("appinstalled", () => {
  _deferredInstallPrompt = null;
  _updateInstallMenuItem();
});

function setStatus(state, text) {
  const dot = $("phone-status-dot");
  dot.className = `dot${state ? ` ${state}` : ""}`;
  $("phone-status-text").textContent = text;
}

function setMessage(text) { $("phone-message").textContent = text; }
function setEcho(text) {
  const el = $("phone-echo");
  if (text) { el.textContent = `"${text}"`; el.hidden = false; }
  else      { el.textContent = "";         el.hidden = true;  }
}

// Phone → desktop → BLE → robot relay. Correlation id round-trips so the
// phone can resolve the right pending promise when multiple commands race
// (e.g. a double-tap of Stop while the first is in flight).
//
// PROTOCOL PARITY — must match phones.js onPhoneMessage / dispatchRobotCommand:
//   phone → desktop  { type:"robot-command",        id, capability, args }
//   desktop → phone  { type:"robot-command-result", id, ok, data? | error? }
const _pendingCommands = new Map();  // id → { resolve, timeout }
function sendRobotCommand(capability, args = {}, timeoutMs = 5000) {
  if (!_peer) return Promise.resolve({ ok: false, error: "not paired" });
  const id = (crypto.randomUUID && crypto.randomUUID())
    || `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (!_pendingCommands.has(id)) return;
      _pendingCommands.delete(id);
      resolve({ ok: false, error: "timed out" });
    }, timeoutMs);
    _pendingCommands.set(id, { resolve, timeout });
    _peer.send({ type: "robot-command", id, capability, args });
  });
}

function showCommandStatus(text, kind) {
  const el = $("phone-command-status");
  if (!el) return;
  el.textContent = text;
  el.className = "phone-command-status" + (kind ? " " + kind : "");
  el.hidden = false;
  clearTimeout(showCommandStatus._t);
  showCommandStatus._t = setTimeout(() => { el.hidden = true; }, 3000);
}

function wireStopButton() {
  const btn = $("phone-stop-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const r = await sendRobotCommand("stop");
    btn.disabled = false;
    if (r.ok) showCommandStatus(`Stopped${r.data?.robot ? ` · ${r.data.robot}` : ""}`, "ok");
    else showCommandStatus(r.error || "Failed", "alert");
  });
}

function handleSubmit(e) {
  e.preventDefault();
  const input = $("phone-input");
  const text = input.value.trim();
  if (!text || _pending || !_peer) return;
  _pending = true;
  input.disabled = true;
  setEcho(text);
  setMessage("…");
  input.value = "";
  _peer.send({ type: "chat", text });
}

// Pip asked a question — show the modal, wait for the user to tap an option
// (or Skip / timeout at the other end). Only one ask at a time on screen;
// if a second arrives while the first is open, the new one replaces it and
// the prior ask resolves as skipped server-side when its timer fires.
//
// PROTOCOL PARITY — must match phones.js askHuman():
//   desktop → phone  { type:"ask",       askId, question, options, imageDataUrl }  (received here)
//   phone → desktop  { type:"ask-reply", askId, answer }                           (sent from respond())
// Desktop-side the reply is matched against the pending ask by askId; mismatched
// or late replies are dropped silently. Keep both halves in sync — renaming a
// field on one side without the other leaves the user tapping answers into the
// void.
function showAsk(msg) {
  const dialog = $("phone-ask-dialog");
  const img = $("phone-ask-image");
  const q = $("phone-ask-question");
  const optsEl = $("phone-ask-options");
  const free = $("phone-ask-free");
  const freeInput = $("phone-ask-free-input");

  if (msg.imageDataUrl) { img.src = msg.imageDataUrl; img.hidden = false; }
  else { img.hidden = true; img.src = ""; }
  q.textContent = msg.question || "";

  const respond = (answer) => {
    _peer?.send({ type: "ask-reply", askId: msg.askId, answer });
    dialog.close();
  };

  optsEl.innerHTML = "";
  if (Array.isArray(msg.options) && msg.options.length > 0) {
    free.hidden = true;
    for (const opt of msg.options) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ask-option sm";
      b.textContent = String(opt);
      b.addEventListener("click", () => respond(String(opt)), { once: true });
      optsEl.appendChild(b);
    }
  } else {
    free.hidden = false;
    freeInput.value = "";
    free.onsubmit = (e) => {
      e.preventDefault();
      const v = freeInput.value.trim();
      if (v) respond(v);
    };
  }

  $("phone-ask-skip").onclick = () => respond(null);
  if (!dialog.open) dialog.showModal();
  // Autofocus the free input when there are no tappable options, so the
  // keyboard pops up immediately on mobile.
  if (free.hidden === false) setTimeout(() => freeInput.focus(), 50);
}

// Mount an incoming media stream into the phone's <video> sink. The pairing
// layer fires onTrack for each track; both video tracks of one stream share
// the same MediaStream object, so we can blindly assign streams[0].
function onPeerTrack(e) {
  const v = $("phone-cam");
  const section = $("phone-cam-section");
  const stream = e.streams?.[0];
  if (!stream) return;
  if (v.srcObject !== stream) v.srcObject = stream;
  section.hidden = false;
  // When the remote ends the track (laptop user clicked Stop), hide the
  // section so the phone doesn't show a frozen last frame as if it were live.
  for (const t of stream.getTracks()) {
    t.addEventListener("ended", () => {
      // If all tracks are ended, hide. Other tracks may still be live.
      if (stream.getTracks().every(t2 => t2.readyState === "ended")) {
        section.hidden = true;
        v.srcObject = null;
      }
    });
  }
}

// Sources the desktop has available to forward, indexed by robotId. The
// camera tile's tap handler renders a picker over this. Updated whenever
// the desktop notifies — track changes, attached camera mount/unmount.
const _availableSources = new Map();  // robotId -> { sources, active }

// Update the "Tap to switch source" affordance — visible iff there's more
// than one source for any robot (or the picker would lie about its job).
function updateCameraPickerHint() {
  const overlay = $("phone-cam-overlay");
  if (!overlay) return;
  const hasChoice = [..._availableSources.values()].some(s => (s.sources?.length || 0) > 1);
  overlay.hidden = !hasChoice;
}

function renderCameraPicker() {
  const wrap = $("phone-cam-picker");
  if (!wrap) return;
  // Aggregate across robots — each row is "<robot> · <source-label>" with
  // a check on the active one. Tapping sends subscribe-source for that
  // robotId with the chosen sourceId.
  const rows = [];
  for (const [robotId, info] of _availableSources) {
    for (const s of info.sources || []) {
      const active = (info.active || s.kind) === s.id || info.active === s.id;
      rows.push({ robotId, source: s, active });
    }
  }
  if (!rows.length) { wrap.hidden = true; return; }
  wrap.innerHTML = rows.map(r => {
    const tag = r.source.fwType ? `<span class="type-badge type-${r.source.fwType}">${r.source.fwType === "esp32" ? "ESP32" : r.source.fwType.toUpperCase()}</span>` : "";
    return `<button class="phone-cam-pick-row${r.active ? " active" : ""}" type="button"
              data-robot-id="${r.robotId}" data-source-id="${r.source.id}">
              ${tag}<span>${r.source.label}</span>${r.active ? "<span class='phone-cam-pick-check'>✓</span>" : ""}
            </button>`;
  }).join("");
  wrap.hidden = false;
  wrap.querySelectorAll(".phone-cam-pick-row").forEach(btn => {
    btn.addEventListener("click", () => {
      const robotId = btn.dataset.robotId;
      const sourceId = btn.dataset.sourceId;
      try { _peer?.send?.({ type: "subscribe-source", robotId, sourceId }); } catch {}
      // Optimistic local update — the real authority is the next
      // available-sources message from desktop confirming the active.
      const info = _availableSources.get(robotId);
      if (info) { info.active = sourceId; _availableSources.set(robotId, info); }
      wrap.hidden = true;
      renderCameraPicker();  // refresh check marks for next open
    });
  });
}

function onPeerMessage(msg) {
  if (msg.type === "ask") { showAsk(msg); return; }
  if (msg.type === "available-sources") {
    _availableSources.set(msg.robotId, {
      sources: msg.sources || [], active: msg.active || null,
    });
    updateCameraPickerHint();
    return;
  }
  if (msg.type === "robot-command-result") {
    const pending = _pendingCommands.get(msg.id);
    if (!pending) return;  // late reply after timeout — drop silently
    clearTimeout(pending.timeout);
    _pendingCommands.delete(msg.id);
    pending.resolve({ ok: !!msg.ok, data: msg.data, error: msg.error });
    return;
  }
  if (msg.type === "chat-reply") {
    setMessage(msg.text || "(no response)");
    _pending = false;
    $("phone-input").disabled = false;
    $("phone-input").focus();
  } else if (msg.type === "notice") {
    // Pip-initiated message (tool: send_to_phone) — desktop pushing to us.
    setEcho("");
    setMessage(msg.text || "");
  } else if (msg.type === "scene") {
    // Raw VLM observation push from desktop — like catwatcher, we just show
    // what the camera is seeing without Pip commentary on top.
    const section = $("phone-scene");
    const text = (msg.text || "").trim();
    if (text) {
      $("phone-scene-source").textContent = msg.source ? `📷 ${msg.source}` : "📷 Camera";
      $("phone-scene-text").textContent = text;
      section.hidden = false;
    } else {
      section.hidden = true;
    }
  } else if (msg.type === "aruco-status") {
    // Desktop pushes lock state when this phone is mounted on a robot. The
    // operator holding the phone overhead can't see the dashboard overlay,
    // so this is the in-hand confirmation that detection is working.
    const box = document.getElementById("phone-aruco-lock");
    const text = document.getElementById("phone-aruco-lock-text");
    if (!box || !text) return;
    box.hidden = false;
    if (msg.locked) {
      box.classList.add("locked");
      text.textContent = `Marker locked · id ${msg.markerId}`;
    } else {
      box.classList.remove("locked");
      text.textContent = msg.detail || "Scanning for marker…";
    }
    return;
  } else if (msg.type === "target-info") {
    // Desktop tells us which robot the joypad will drive. If null, hide
    // both the drive surface AND the panic stop button — neither makes
    // sense when there's nothing to control / stop.
    const driveSection = $("phone-drive");
    const cmdSection = $("phone-command");
    const targetEl = $("phone-drive-target");
    if (msg.target?.name) {
      driveSection.hidden = false;
      if (cmdSection) cmdSection.hidden = false;
      targetEl.textContent = `Driving: ${msg.target.name}`;
    } else {
      driveSection.hidden = true;
      if (cmdSection) cmdSection.hidden = true;
      targetEl.textContent = "No robot connected";
      _joypad?.reset();
    }
  }
}

function wireJoypad() {
  const pad = $("phone-joypad");
  const knob = pad?.querySelector(".joypad-knob");
  if (!pad || !knob) return;
  _joypad = attachJoypad(pad, knob, {
    onDrive: (l, r) => _peer?.send({ type: "drive", l, r }),
    onStop:  ()     => _peer?.send({ type: "drive", l: 0, r: 0 }),
  });
}

// ── Tilt-drive ────────────────────────────────────────────────────
// Phone-as-steering-wheel + on-screen throttle pedals. Rolling the phone
// left/right (gamma axis) sets a turn rate; press-and-hold "Forward" or
// "Reverse" applies throttle. Maps to the same {type:"drive", l, r}
// protocol the joypad uses, mixed via differential drive (throttle ±
// turn → left / right motor). 10 Hz send rate (joystick parity).
//
// iOS Safari requires DeviceOrientationEvent.requestPermission() — a
// one-tap user gesture before motion data flows. We surface the prompt
// only when the user opts into Tilt mode (no friction for joypad users).
const TILT_MODE_KEY = "better-robotics:phone-drive-mode";
// Dead-zone covers IMU noise floor (~1°) + typical hand tremor + relaxed
// grip drift (3-6°). Anything inside this band = "go straight" intent —
// the operator gets to keep moving forward without locking their wrist.
const TILT_TURN_DEADZONE_DEG = 8;
const TILT_TURN_SATURATION_DEG = 35;  // ±35° = full turn rate; beyond clips
const TILT_THROTTLE = 60;             // base motor magnitude when a pedal is held (LLM-cap-safe range)
const TILT_SEND_HZ = 10;
// Brief grace period after a pointer-release event before zeroing the
// throttle. iOS Safari can preempt touches during sustained device
// motion (system gestures, capacitive-touch dropouts on hard tilts).
// 80 ms of grace means a quick re-press cancels the stop — common
// mobile-racing-game pattern to filter glitchy releases.
const TILT_RELEASE_GRACE_MS = 80;
let _tiltGamma = 0;                   // last orientation event's left-right roll
let _tiltBeta = 0;                    // front-back tilt (used in landscape)
let _tiltThrottle = 0;                // -1, 0, +1 from pedal state
let _tiltSendTimer = null;
let _tiltOrientationOn = false;
let _tiltMotionPermission = "unknown"; // "granted" | "denied" | "unknown"

// Returns the user's "left-right tilt to steer" reading in degrees,
// normalized so positive = turn right regardless of how the phone is
// physically oriented. The DeviceOrientationEvent axes (alpha/beta/gamma)
// are tied to the device frame, not the screen frame, so we re-map based
// on screen.orientation.angle:
//   0   (portrait primary): gamma → screen left-right
//   180 (portrait inverted): -gamma
//   90  (landscape primary, home button on left): beta → screen left-right
//   270 (landscape secondary, home button on right): -beta
function _tiltSteerAxisDeg() {
  const angle = ((screen.orientation?.angle ?? 0) % 360 + 360) % 360;
  if (angle === 90)  return _tiltBeta;
  if (angle === 270) return -_tiltBeta;
  if (angle === 180) return -_tiltGamma;
  return _tiltGamma;
}

function _tiltIsLandscape() {
  const angle = ((screen.orientation?.angle ?? 0) % 360 + 360) % 360;
  return angle === 90 || angle === 270;
}

function _tiltMix() {
  // Steering axis is in [-90, 90] roughly; positive = right tilt.
  // dead-zone + clip then normalize to the shared mix() convention
  // (which handles operator-perspective sign flip on reverse).
  let g = _tiltSteerAxisDeg();
  if (Math.abs(g) < TILT_TURN_DEADZONE_DEG) g = 0;
  if (g >  TILT_TURN_SATURATION_DEG) g =  TILT_TURN_SATURATION_DEG;
  if (g < -TILT_TURN_SATURATION_DEG) g = -TILT_TURN_SATURATION_DEG;
  const turnPct = g / TILT_TURN_SATURATION_DEG;        // -1..+1
  // 70% turn ratio = comfortable turn radius without pivot-in-place.
  const [l, r] = mix(_tiltThrottle * TILT_THROTTLE, turnPct * TILT_THROTTLE * 0.7);
  return { l, r };
}

function _tiltUpdateIndicator() {
  const fill = $("phone-tilt-fill");
  const neutral = $("phone-tilt-neutral");
  const read = $("phone-tilt-readout");
  if (!fill) return;
  const steer = _tiltSteerAxisDeg();
  const pct = Math.max(-1, Math.min(1, steer / TILT_TURN_SATURATION_DEG));
  // Center the bar at 50%; fill from center outward toward the tilt direction.
  const left = pct < 0 ? `${50 + pct * 50}%` : "50%";
  const width = `${Math.abs(pct) * 50}%`;
  fill.style.left = left;
  fill.style.width = width;
  // Neutral zone width tracks the dead-zone / saturation ratio so the
  // visual matches the actual "go straight" band whenever the constants
  // change. Set once per render — cheap.
  if (neutral) {
    const neutralPct = (TILT_TURN_DEADZONE_DEG / TILT_TURN_SATURATION_DEG) * 50;
    neutral.style.width = `${neutralPct * 2}%`;
  }
  if (read) {
    if (Math.abs(steer) < TILT_TURN_DEADZONE_DEG) {
      read.textContent = _tiltThrottle === 0 ? "Roll phone L/R to steer" : "Going straight";
    } else {
      read.textContent = `${steer > 0 ? "→ Right" : "← Left"} ${Math.round(Math.abs(steer))}°`;
    }
  }
}

function _tiltSendTick() {
  if (!_peer) return;
  const { l, r } = _tiltMix();
  // Skip the send when both motors would be zero AND we already sent zero
  // last tick — common case (phone flat, no pedal). Saves bandwidth.
  if (l === 0 && r === 0 && _tiltSendTimer?._lastZero) return;
  try { _peer.send({ type: "drive", l, r }); } catch {}
  _tiltSendTimer._lastZero = (l === 0 && r === 0);
}

function _tiltOrientationHandler(e) {
  // gamma: left-right roll. beta: front-back tilt. We need both because
  // the steering axis depends on whether the phone is in portrait or
  // landscape (handled by _tiltSteerAxisDeg).
  if (typeof e.gamma === "number") _tiltGamma = e.gamma;
  if (typeof e.beta  === "number") _tiltBeta  = e.beta;
  _tiltUpdateIndicator();
}

// Apply / remove the .landscape modifier on the tilt-drive container so
// CSS can reflow the pedals to bottom corners (controller-grip pattern)
// when the phone rotates. Hides the steering input when in portrait
// + tilt mode, with a hint to rotate.
function _tiltApplyOrientation() {
  const wrap = $("phone-drive-tilt-wrap");
  const hint = $("phone-tilt-orient-hint");
  if (!wrap) return;
  const land = _tiltIsLandscape();
  wrap.classList.toggle("landscape", land);
  if (hint) hint.hidden = land;
  _tiltUpdateIndicator();
}

async function _tiltRequestMotionPermission() {
  // iOS 13+ Safari: explicit user-gesture-bound permission request. Other
  // browsers: addEventListener works without the prompt. Treat the legacy
  // path as already-granted.
  const Klass = window.DeviceOrientationEvent;
  if (Klass && typeof Klass.requestPermission === "function") {
    try {
      const result = await Klass.requestPermission();
      _tiltMotionPermission = result;  // "granted" | "denied"
      return result === "granted";
    } catch { _tiltMotionPermission = "denied"; return false; }
  }
  _tiltMotionPermission = "granted";
  return true;
}

function _tiltStartOrientation() {
  if (_tiltOrientationOn) return;
  window.addEventListener("deviceorientation", _tiltOrientationHandler, { passive: true });
  _tiltOrientationOn = true;
}

function _tiltStopOrientation() {
  if (!_tiltOrientationOn) return;
  window.removeEventListener("deviceorientation", _tiltOrientationHandler);
  _tiltOrientationOn = false;
  _tiltGamma = 0;
  _tiltUpdateIndicator();
}

function _setDriveMode(mode) {
  const isTilt = mode === "tilt";
  $("phone-drive-joypad-wrap").hidden = isTilt;
  $("phone-drive-tilt-wrap").hidden = !isTilt;
  $("phone-drive-mode-joypad").setAttribute("aria-pressed", String(!isTilt));
  $("phone-drive-mode-tilt").setAttribute("aria-pressed", String(isTilt));
  try { localStorage.setItem(TILT_MODE_KEY, mode); } catch {}
  if (isTilt) {
    // iOS: show the permission button when we don't have permission yet.
    // The button has a real user-gesture; addEventListener inside an
    // arbitrary toggle wouldn't satisfy iOS's gesture requirement.
    const Klass = window.DeviceOrientationEvent;
    const needsPrompt = Klass && typeof Klass.requestPermission === "function"
                       && _tiltMotionPermission !== "granted";
    $("phone-tilt-permission").hidden = !needsPrompt;
    if (!needsPrompt) _tiltStartOrientation();
    _tiltApplyOrientation();
    // Joystick-mode is no longer the throttle source — kill any in-flight
    // joypad drive so swapping doesn't strand a non-zero throttle.
    _joypad?.reset();
    try { _peer?.send({ type: "drive", l: 0, r: 0 }); } catch {}
  } else {
    _tiltStopOrientation();
    _tiltThrottle = 0;
    if (_tiltSendTimer) { clearInterval(_tiltSendTimer); _tiltSendTimer = null; }
  }
}

function wireTiltDrive() {
  // Mode toggle: persist choice + swap UI.
  $("phone-drive-mode-joypad")?.addEventListener("click", () => _setDriveMode("joypad"));
  $("phone-drive-mode-tilt")?.addEventListener("click", () => _setDriveMode("tilt"));
  // Orientation change → re-apply class + hint. The browser fires both
  // orientationchange (legacy) and screen.orientation.change (modern);
  // listen to whichever surfaces first.
  const onOrient = () => _tiltApplyOrientation();
  if (screen.orientation?.addEventListener) {
    screen.orientation.addEventListener("change", onOrient);
  } else {
    window.addEventListener("orientationchange", onOrient);
  }
  // Permission prompt — explicit gesture handler so iOS approves.
  $("phone-tilt-permission")?.addEventListener("click", async () => {
    const ok = await _tiltRequestMotionPermission();
    $("phone-tilt-permission").hidden = ok;
    if (ok) _tiltStartOrientation();
  });
  // Pedals — pointer events so it works for both touch and mouse-on-tablet.
  // Throttle on press, zero on release. The interval driver runs only
  // while a pedal is held to keep the bandwidth profile flat.
  const startSend = () => {
    if (_tiltSendTimer) return;
    _tiltSendTimer = setInterval(_tiltSendTick, 1000 / TILT_SEND_HZ);
  };
  const stopSend = () => {
    if (_tiltSendTimer) { clearInterval(_tiltSendTimer); _tiltSendTimer = null; }
    try { _peer?.send({ type: "drive", l: 0, r: 0 }); } catch {}
  };
  // Pending grace timer per pedal. A pointer-release event schedules a
  // delayed stop; if the user re-presses (real intent: hold continuous)
  // before the timer fires, we cancel it. Filters capacitive-touch
  // dropouts during hard tilts that would otherwise spuriously stop.
  const pendingStop = new Map();  // dir -> timer id
  const cancelPending = (dir) => {
    const t = pendingStop.get(dir);
    if (t) { clearTimeout(t); pendingStop.delete(dir); }
  };
  const wirePedal = (id, dir) => {
    const btn = $(id);
    if (!btn) return;
    let activePid = null;
    const onWinUp = (e) => {
      if (activePid != null && e.pointerId !== activePid) return;
      activePid = null;
      window.removeEventListener("pointerup", onWinUp);
      window.removeEventListener("pointercancel", onWinUp);
      // Grace-period stop: a quick re-press cancels it. If genuinely
      // released, the timer fires and zeroes the throttle.
      cancelPending(dir);
      pendingStop.set(dir, setTimeout(() => {
        pendingStop.delete(dir);
        if (_tiltThrottle === dir) { _tiltThrottle = 0; stopSend(); }
      }, TILT_RELEASE_GRACE_MS));
    };
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      // Cancel any in-flight grace-stop from a previous release —
      // user re-pressed before the grace window expired, so they
      // were never really off the pedal.
      cancelPending(dir);
      activePid = e.pointerId;
      try { btn.setPointerCapture(e.pointerId); } catch {}
      _tiltThrottle = dir;
      startSend();
      // Window-level release listeners. iOS Safari can preempt the
      // pointer with a system gesture during heavy device motion;
      // listening on window catches the release even when the
      // button-level capture is lost mid-drive.
      window.addEventListener("pointerup", onWinUp);
      window.addEventListener("pointercancel", onWinUp);
    });
    // Intentionally NOT listening to pointerleave on the button —
    // pointer capture handles drift, and the window-level pointerup
    // catches the actual release reliably.
  };
  wirePedal("phone-tilt-forward", +1);
  wirePedal("phone-tilt-reverse", -1);
  // Restore last-used drive mode (defaults to joypad).
  let saved = "joypad";
  try { saved = localStorage.getItem(TILT_MODE_KEY) || "joypad"; } catch {}
  _setDriveMode(saved);
}

// Phone backgrounded (tab switch, screen lock, app switcher): emit a stop so
// the robot doesn't keep driving while the user can't see it, and kill any
// outgoing camera share (battery + privacy — don't keep streaming video
// the user can't see).
function wireBackgroundStop() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      _joypad?.reset();
      // Tilt-drive: also kill any held throttle so a backgrounded phone
      // doesn't drive into a wall while the user can't see the robot.
      if (_tiltThrottle !== 0) {
        _tiltThrottle = 0;
        if (_tiltSendTimer) { clearInterval(_tiltSendTimer); _tiltSendTimer = null; }
      }
      _peer?.send({ type: "drive", l: 0, r: 0 });
      _stopSharing();
    }
  });
}

// ── Phone-camera-as-helper ────────────────────────────────────────
//
// Toggle the phone's back camera into the paired WebRTC connection as
// an outgoing media stream. Desktop picks it up via peer.onTrack and
// registers it in its helpers list (helpers.js). Pairing layer handles
// renegotiation on addTrack — `negotiationneeded` fires, Peer
// re-offers, desktop answers, track lands on the other side.
let _shareStream = null;
let _shareSenders = [];

async function toggleShareCamera() {
  if (_shareStream) { _stopSharing(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch (err) {
    setMessage(`Camera unavailable: ${err.message || err}`);
    return;
  }
  _shareStream = stream;
  for (const t of stream.getVideoTracks()) {
    const sender = _peer?.addTrack?.(t, stream);
    if (sender) _shareSenders.push(sender);
    t.addEventListener("ended", () => _stopSharing());
  }
  const preview = $("phone-share-preview");
  if (preview) {
    preview.srcObject = stream;
    preview.hidden = false;
    preview.play?.().catch(() => {});
  }
  const btn = $("phone-share-btn");
  if (btn) { btn.textContent = "Stop sharing"; btn.classList.add("on"); }
}

function _stopSharing() {
  if (!_shareStream) return;
  for (const sender of _shareSenders) {
    try { _peer?.removeTrack?.(sender); } catch {}
  }
  _shareSenders = [];
  for (const t of _shareStream.getTracks()) { try { t.stop(); } catch {} }
  _shareStream = null;
  const preview = $("phone-share-preview");
  if (preview) { preview.srcObject = null; preview.hidden = true; }
  const btn = $("phone-share-btn");
  if (btn) { btn.textContent = "Share camera"; btn.classList.remove("on"); }
}

function wireShareCamera() {
  const section = $("phone-share");
  const btn = $("phone-share-btn");
  if (!section || !btn) return;
  section.hidden = false;
  btn.addEventListener("click", toggleShareCamera);
}

// Reconnect / QR-scan surface. Shown when there's no pair code, or after
// a connection failure. Lets the user re-pair without bouncing back to the
// desktop. Uses jsQR (loaded from CDN in phone.html) — BarcodeDetector
// isn't on iOS Safari yet, and jsQR works everywhere.
let _scanStream = null;
let _scanRaf = 0;
let _scanCanvas = null;

function showReconnect(message) {
  $("phone-reconnect").hidden = false;
  $("phone-reconnect-message").textContent = message || "";
  $("phone-cam-section").hidden = true;
}
function hideReconnect() {
  stopQrScan();
  $("phone-reconnect").hidden = true;
  $("phone-scanner").hidden = true;
}

function showScanError(text) {
  const el = $("phone-scanner-fallback");
  el.textContent = text;
  el.hidden = false;
}
function clearScanError() {
  $("phone-scanner-fallback").hidden = true;
}

async function startQrScan() {
  if (typeof window.jsQR !== "function") {
    showScanError("QR decoder didn't load. Reload the page or check your network.");
    return;
  }
  clearScanError();
  try {
    _scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch (err) {
    showScanError(`Couldn't open camera: ${err.message || err}.`);
    return;
  }
  $("phone-scanner").hidden = false;
  $("phone-scan-btn").hidden = true;
  const v = $("phone-scanner-video");
  v.srcObject = _scanStream;
  // Required on iOS Safari: video must play before videoWidth is non-zero.
  // Inline + muted attrs in the HTML cover the autoplay policy.
  await v.play().catch(() => {});

  _scanCanvas = _scanCanvas || document.createElement("canvas");
  const ctx = _scanCanvas.getContext("2d", { willReadFrequently: true });

  const tick = () => {
    if (!_scanStream) return;
    if (v.readyState >= v.HAVE_ENOUGH_DATA && v.videoWidth > 0) {
      // Downscale to ~480 on the long edge — jsQR is O(pixels), full HD
      // tanks fps on older phones, and 480 is plenty for a QR.
      const scale = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.round(v.videoWidth * scale);
      const h = Math.round(v.videoHeight * scale);
      if (_scanCanvas.width !== w) _scanCanvas.width = w;
      if (_scanCanvas.height !== h) _scanCanvas.height = h;
      ctx.drawImage(v, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const result = window.jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
      if (result?.data) {
        stopQrScan();
        // Same-origin pair URL → navigate. Cross-origin → user picked the
        // wrong QR; surface a hint rather than bouncing them out.
        try {
          const target = new URL(result.data, location.href);
          if (target.origin === location.origin && target.hash.startsWith("#pair=")) {
            // location.replace() does NOT reload when the new URL only
            // differs by fragment — it fires hashchange and keeps the JS
            // state, so init()/joinPairingRoom never see the new roomId.
            // Force a reload so the page restarts with the fresh hash.
            // Same pattern the nearby-pair button uses.
            location.replace(target.toString());
            location.reload();
            return;
          }
          showScanError(`That QR points to ${target.host}, not this dashboard.`);
        } catch {
          showScanError("That QR isn't a pair link.");
        }
        return;
      }
    }
    _scanRaf = requestAnimationFrame(tick);
  };
  tick();
}

function stopQrScan() {
  if (_scanRaf) { cancelAnimationFrame(_scanRaf); _scanRaf = 0; }
  if (_scanStream) {
    for (const t of _scanStream.getTracks()) { try { t.stop(); } catch {} }
    _scanStream = null;
  }
  const v = $("phone-scanner-video");
  if (v) v.srcObject = null;
  $("phone-scanner").hidden = true;
  $("phone-scan-btn").hidden = false;
}

function wireReconnect() {
  $("phone-scan-btn")?.addEventListener("click", startQrScan);
  $("phone-scanner-cancel")?.addEventListener("click", stopQrScan);
}

function wireCameraPicker() {
  const tap = $("phone-cam-tap");
  if (!tap) return;
  tap.addEventListener("click", () => {
    // Only show the picker when there's more than one source — single-
    // source case has nothing to pick from. updateCameraPickerHint
    // already hides the "Tap to switch source" overlay, but guard here too.
    const hasChoice = [..._availableSources.values()].some(s => (s.sources?.length || 0) > 1);
    if (!hasChoice) return;
    const wrap = $("phone-cam-picker");
    if (!wrap) return;
    if (!wrap.hidden) { wrap.hidden = true; return; }
    renderCameraPicker();
  });
  // Outside-click dismiss for the picker — matches dialog/menu patterns.
  document.addEventListener("click", (e) => {
    const wrap = $("phone-cam-picker");
    if (!wrap || wrap.hidden) return;
    if (wrap.contains(e.target) || tap.contains(e.target)) return;
    wrap.hidden = true;
  });
}

function wireAppMenu() {
  const btn = $("app-menu-btn");
  const menu = $("app-menu");
  if (!btn || !menu) return;
  btn.addEventListener("click", (e) => {
    if (menu.matches(":popover-open")) { menu.hidePopover(); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.left = `${Math.max(8, rect.left)}px`;
    menu.style.right = "auto";
    menu.showPopover?.();
  });
  document.addEventListener("click", (e) => {
    if (!menu.matches(":popover-open")) return;
    if (e.target.closest("#app-menu")) return;
    if (e.target.closest("#app-menu-btn")) return;
    menu.hidePopover();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.matches(":popover-open")) menu.hidePopover();
  });
  // Pull VERSION from sw.js (CI stamps it on every dashboard-asset change).
  fetch("sw.js").then(r => r.ok ? r.text() : "").then(t => {
    const m = t.match(/VERSION\s*=\s*"([^"]+)"/);
    if (m) $("app-menu-version").textContent = m[1];
  }).catch(() => {});
  $("menu-install").addEventListener("click", async () => {
    menu.hidePopover();
    if (_deferredInstallPrompt) {
      _deferredInstallPrompt.prompt();
      try { await _deferredInstallPrompt.userChoice; } catch {}
      _deferredInstallPrompt = null;
      _updateInstallMenuItem();
      return;
    }
    if (_isIOS()) {
      const pop = $("install-ios-popover");
      pop?.showPopover?.();
    }
  });
  $("menu-dashboard").addEventListener("click", () => menu.hidePopover());
  $("menu-repo").addEventListener("click", () => menu.hidePopover());
  _updateInstallMenuItem();

  $("menu-check-updates").addEventListener("click", async () => {
    const btn = $("menu-check-updates");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (!reg) throw new Error("no-sw");
      // Already-waiting worker: apply directly.
      if (reg.waiting) {
        btn.textContent = "Updating…";
        reg.waiting.postMessage("skip-waiting");
        return;  // controllerchange listener reloads
      }
      // Watch for the install that update() may trigger and apply once
      // it reaches "installed" — the explicit click is the opt-in.
      const applyOnInstall = () => {
        const next = reg.installing;
        next?.addEventListener("statechange", () => {
          if (next.state === "installed") next.postMessage("skip-waiting");
        }, { once: true });
      };
      reg.addEventListener("updatefound", applyOnInstall, { once: true });
      await reg.update();
      if (reg.installing || reg.waiting) {
        btn.textContent = "Updating…";
        return;
      }
      reg.removeEventListener("updatefound", applyOnInstall);
      btn.textContent = "Up to date";
    } catch {
      btn.textContent = "Up to date";
    }
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2000);
  });

  $("menu-hard-refresh").addEventListener("click", () => {
    menu.hidePopover();
    $("hard-refresh-dialog").showModal();
  });
  $("hard-refresh-close").addEventListener("click", () => $("hard-refresh-dialog").close());
  $("hard-refresh-cancel").addEventListener("click", () => $("hard-refresh-dialog").close());
  $("hard-refresh-confirm").addEventListener("click", async () => {
    const btn = $("hard-refresh-confirm");
    btn.disabled = true;
    btn.textContent = "Clearing…";
    try {
      // Capture cached asset URLs before nuking — used to bust the
      // browser's HTTP cache (the layer below the SW that
      // location.reload() doesn't flush). See app.js for the full reason.
      const sameOriginAssets = [];
      if (self.caches) {
        try {
          const names = await caches.keys();
          for (const n of names) {
            const c = await caches.open(n);
            const reqs = await c.keys();
            for (const r of reqs) {
              if (new URL(r.url).origin === location.origin) sameOriginAssets.push(r.url);
            }
          }
        } catch {}
      }
      const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
      await Promise.allSettled(regs.map(r => r.unregister()));
      if (self.caches) {
        const names = await caches.keys();
        await Promise.allSettled(names.map(n => caches.delete(n)));
      }
      if (indexedDB.databases) {
        const dbs = await indexedDB.databases();
        await Promise.allSettled(dbs.map(d => new Promise((res) => {
          if (!d.name) return res();
          const req = indexedDB.deleteDatabase(d.name);
          req.onsuccess = req.onerror = req.onblocked = () => res();
        })));
      }
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      try {
        for (const c of document.cookie.split(";")) {
          const eq = c.indexOf("=");
          const name = (eq > -1 ? c.substr(0, eq) : c).trim();
          if (!name) continue;
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=${location.pathname}`;
        }
      } catch {}
      const pageUrl = new URL("./", location.href).toString();
      const all = new Set([pageUrl, location.href, ...sameOriginAssets]);
      btn.textContent = "Refetching…";
      await Promise.allSettled(
        [...all].map(u => fetch(u, { cache: "reload" }).catch(() => {})),
      );
    } finally {
      location.reload();
    }
  });
}

// LAN discovery — request/accept flow.
//
// We publish a "better-robotics-phone" presence ad always-on while in
// showReconnect, so dashboards on the wifi see us (and may auto-accept
// us if they've trusted us). We subscribe for "better-robotics-mac"
// presence ads to populate the tappable list. Tapping a Mac publishes a
// signed pair-request targeted at its pubkey; the Mac prompts its user
// (or auto-accepts), then publishes a pair-response with a fresh roomId.
// We navigate to that room and the WebRTC pair starts.
//
// No three-state UI on the phone — trust is decided in the prompt on the
// Mac side. Every nearby Mac is uniformly tappable.

let _lobby = null;
let _myPubkey = null;

function deviceLabel() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  return "Phone";
}

function _setNearbyStatus(text, kind) {
  const status = $("phone-nearby-status");
  if (!status) return;
  if (!text) { status.hidden = true; status.textContent = ""; status.className = "phone-nearby-status"; return; }
  status.hidden = false;
  status.textContent = text;
  status.className = "phone-nearby-status" + (kind ? " " + kind : "");
}

let _pairClient = null;
function _getPairClient() {
  if (!_pairClient) _pairClient = pairRequestClient({ app: 'better-robotics-pair', sign: true, lobby: _lobby });
  return _pairClient;
}

async function _requestPairWith(macAd) {
  if (!macAd.data._pubkey) return;
  const macLabel = macAd.data.label || 'this computer';
  _setNearbyStatus(`Asking ${macLabel} to pair…`);
  const result = await _getPairClient().request({
    payload: { target: macAd.data._pubkey, label: deviceLabel() },
  });
  if (result.accepted && result.data && result.data.roomId) {
    _setNearbyStatus('Accepted — connecting…');
    // Mac trusts us per its own "Trust this phone" checkbox decision;
    // we don't auto-trust back because the phone has no surface for
    // the reciprocal choice yet. Leave trust binding to the explicit
    // QR path (phone.js init already calls _trust.trust when pk rides
    // in on the QR hash, and the pair-keys data-channel handshake
    // refreshes the label).
    location.replace(location.pathname + '#pair=' + result.data.roomId);
    location.reload();
    return;
  }
  // Distinguish the three failure paths so the user knows whether to
  // try again (network), check on the other device (timeout), or stop
  // trying (denied).
  if (result.reason === 'error') {
    _setNearbyStatus(`Couldn't reach the lobby. Check your wifi and try again.`, 'alert');
    return;
  }
  if (result.reason === 'timeout') {
    _setNearbyStatus(`No response from ${macLabel}. They may have missed the prompt — try again.`, 'alert');
    return;
  }
  _setNearbyStatus('Pair declined.', 'alert');
}

async function startNearbyDiscovery() {
  if (_lobby) return;  // idempotent — init might call us twice across reconnects
  _lobby = discover({ sign: true });
  _myPubkey = await getMyPubkeyB64();

  // Publish phone presence so the dashboard sees "iPhone on wifi" even
  // before we initiate anything. discover.js auto-republishes; the ad
  // TTLs out within 60s of tab close.
  const phoneAdId = "better-robotics-phone:" + _myPubkey;
  _lobby.publish(phoneAdId, {
    app: "better-robotics-phone",
    label: deviceLabel(),
  }, 60000);

  const wrap = $("phone-nearby");
  const list = $("phone-nearby-list");
  const emptyHint = $("phone-nearby-empty-hint");
  if (!wrap || !list) return;
  // Empty-lobby hint after 10s surfaces the common culprit (iCloud Private
  // Relay / VPN splits the phone onto a different public IP than the Mac,
  // and the Lobby groups by public IP). Cleared as soon as any mac appears.
  const hintTimer = setTimeout(() => {
    if (emptyHint && wrap.hidden) emptyHint.hidden = false;
  }, 10000);
  _lobby.onChange((ads) => {
    const macs = ads.filter(a => a.data && a.data.app === "better-robotics-mac" && a.data._pubkey);
    list.innerHTML = "";
    if (!macs.length) { wrap.hidden = true; return; }
    clearTimeout(hintTimer);
    if (emptyHint) emptyHint.hidden = true;
    wrap.hidden = false;
    for (const ad of macs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "phone-nearby-btn";
      btn.textContent = `Pair with ${ad.data.label || "this computer"}`;
      btn.addEventListener("click", () => _requestPairWith(ad));
      list.appendChild(btn);
    }
  });
}

async function init() {
  wireReconnect();
  wireCameraPicker();
  wireAppMenu();
  const match = location.hash.match(/^#pair=(.+)$/);
  if (!match) {
    setStatus("error", "Not paired");
    setMessage("");
    showReconnect("");
    startNearbyDiscovery();
    return;
  }
  // Hash format is now `pair=<roomId>(&pk=<pubkey>)?`. The pk is the
  // in-person trust binding: scanning a QR with pk = consenting that
  // this pubkey belongs to the device that printed the QR. Stored
  // before WebRTC even starts so the trust holds even if pair fails.
  const params = new URLSearchParams(match[1]);
  const roomId = (match[1].split("&")[0]) || "";
  const remotePk = params.get("pk");
  if (remotePk) {
    // Label is unknown until the data channel exchanges it. "Computer"
    // is a placeholder; the pair-keys handshake replaces it with what
    // the desktop calls itself ("Mac", "Windows", …).
    _trust.trust(remotePk, "Computer");
  }
  try {
    setStatus("connecting", "Connecting…");
    // Route pair stages through setMessage so the user sees where we're
    // stuck if something stalls — "offer sent, waiting for desktop…" tells
    // them way more than a forever-spinning "Connecting…".
    _peer = await joinPairingRoom(roomId, {
      onStatus: (s) => setMessage(s),
    });
    setStatus("connected", "Connected");
    setMessage("Hi — I'm Pip, running on your desktop. Ask me something.");
    hideReconnect();
    // Send the desktop our pubkey + label so it can trust us on future
    // discovery without re-scanning. Sent as soon as the channel is up.
    try {
      const myPk = await getMyPubkeyB64();
      _peer.send({ type: "pair-keys", pubkey: myPk, label: deviceLabel() });
    } catch {}
    _peer.onMessage((msg) => {
      // Desktop may send its own pubkey + label as part of pair-keys —
      // upgrade the trust entry from the placeholder label to the real
      // one (and re-trust the pubkey if the QR didn't carry pk for some
      // reason, e.g. a legacy QR from before signed mode).
      if (msg && msg.type === "pair-keys" && msg.pubkey) {
        _trust.trust(msg.pubkey, msg.label || "Computer");
        return;
      }
      onPeerMessage(msg);
    });
    _peer.onTrack(onPeerTrack);
    // Transient state: pairing.js handles ICE restart internally. We only
    // change the visible status, keep input enabled so typed messages queue
    // until the channel is back — the peer.send() no-ops while closed and
    // the next data channel write will catch up.
    _peer.onStatus((status, detail) => {
      if (status === "connected") {
        setStatus("connected", "Connected");
        $("phone-input").disabled = false;
      } else if (status === "reconnecting") {
        setStatus("connecting", detail || "Reconnecting…");
      } else if (status === "failed") {
        setStatus("error", "Disconnected");
        $("phone-input").disabled = true;
      }
    });
    _peer.onClose(() => {
      setStatus("error", "Disconnected");
      setMessage("Connection lost.");
      $("phone-input").disabled = true;
      $("phone-cam-section").hidden = true;
      _stopSharing();
      $("phone-share").hidden = true;
      showReconnect("Lost the desktop. Scan a fresh QR to reconnect.");
      startNearbyDiscovery();
    });
    $("phone-form").addEventListener("submit", handleSubmit);
    $("phone-input").disabled = false;
    $("phone-input").focus();
    wireJoypad();
    wireTiltDrive();
    wireStopButton();
    wireBackgroundStop();
    wireShareCamera();
  } catch (err) {
    setStatus("error", "Failed");
    setMessage(`Couldn't pair: ${err.message || err}`);
    showReconnect("Pair failed — try a fresh QR from the desktop.");
    startNearbyDiscovery();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Register SW so phone.html is installable + works offline after first visit.
// No banner here (the phone surface is thin); a new SW just installs and
// waits, the user triggers application via the menu's "Check for updates".
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
  let _swReloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (_swReloading) return;
    _swReloading = true;
    location.reload();
  });
}
