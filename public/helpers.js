import { $, escapeHtml } from "./dom.js";
import { listPhones, sendToPhone, setPhonesChangeHandler } from "./phones.js";

// Helpers are non-mobile observers/operators (paired phones, this laptop's
// webcam). Sibling concept to robots — same card visual language, distinct
// backing data. Robots are controllable mobile actors; helpers are extra
// eyes / extra hands that the operator brings into the session.

const LAPTOP_ID = "laptop";

// Singleton state for "this laptop's webcam". One camera per laptop is the
// common case; if multi-cam ever matters we'll grow this into a Map.
const _laptop = {
  id: LAPTOP_ID,
  label: "This laptop's camera",
  status: "idle",     // "idle" | "starting" | "live" | "error"
  error: null,
  stream: null,
  trackSettings: null,
  startedAt: null,
};

// Phone cameras the user has toggled on from phone.html. phones.js pushes
// into this via setPhoneStream when peer.onTrack fires. keyed by phoneId
// (the pairing roomId) → { stream, trackSettings, startedAt }.
const _phoneStreams = new Map();

let _videoEls = new Map();  // helperId → <video> element (live video)

// Subscribers fired whenever the laptop camera transitions (idle/starting/
// live/error). phones.js uses this to push the live stream to paired phones.
const _laptopChangeListeners = new Set();
export function onLaptopChange(cb) {
  _laptopChangeListeners.add(cb);
  return () => _laptopChangeListeners.delete(cb);
}
export function getLaptopStream() {
  return _laptop.status === "live" ? _laptop.stream : null;
}
function emitLaptopChange() {
  for (const cb of _laptopChangeListeners) {
    try { cb(getLaptopStream()); } catch (err) { console.warn("[helpers] laptop listener", err); }
  }
}

export function initHelpers() {
  setPhonesChangeHandler(() => render());
  render();
}

export function listHelpers() {
  const out = [];
  for (const p of listPhones()) {
    const ps = _phoneStreams.get(p.id);
    out.push({
      id: `phone:${p.id}`, kind: "phone", label: p.label || "Phone",
      status: p.status, connectedAt: p.connectedAt,
      live: !!ps,
      resolution: ps?.trackSettings
        ? { width: ps.trackSettings.width, height: ps.trackSettings.height }
        : null,
    });
  }
  out.push({
    id: LAPTOP_ID, kind: "laptop", label: _laptop.label,
    status: _laptop.status === "live" ? "connected" : _laptop.status,
    resolution: _laptop.trackSettings
      ? { width: _laptop.trackSettings.width, height: _laptop.trackSettings.height }
      : null,
  });
  return out;
}

// Wire in from phones.js: peer.onTrack → setPhoneStream(phoneId, stream).
// Null stream clears the entry (phone stopped sharing or disconnected).
export function setPhoneStream(phoneId, stream) {
  if (stream) {
    const track = stream.getVideoTracks()[0];
    _phoneStreams.set(phoneId, {
      stream,
      startedAt: Date.now(),
      trackSettings: track ? track.getSettings() : null,
    });
  } else {
    _phoneStreams.delete(phoneId);
    _videoEls.delete(`phone:${phoneId}`);
  }
  render();
}

export function getPhoneStream(phoneId) {
  return _phoneStreams.get(phoneId)?.stream || null;
}

export async function startHelperCamera(helperId) {
  if (helperId === LAPTOP_ID) return await startLaptopCam();
  if (helperId.startsWith("phone:")) {
    // MVP: desktop can't remotely flip the phone's camera on. User has to
    // tap "Share camera" on phone.html. Surface that here so Pip's tool
    // call returns a guidance message rather than a hard error.
    const phoneId = helperId.slice("phone:".length);
    if (_phoneStreams.has(phoneId)) return { ok: true, already: true };
    return { error: "tap Share camera on the phone to start" };
  }
  return { error: `unknown helper: ${helperId}` };
}

export async function stopHelperCamera(helperId) {
  if (helperId === LAPTOP_ID) { stopLaptopCam(); return { ok: true }; }
  if (helperId.startsWith("phone:")) {
    // Same constraint as start: phone owns its camera. Stop happens when
    // the user taps the button on phone.html or when the track ends.
    return { error: "tap Stop sharing on the phone to end the stream" };
  }
  return { error: `unknown helper: ${helperId}` };
}

export function takeHelperSnapshot(helperId) {
  if (helperId === LAPTOP_ID) return captureLaptopFrame();
  if (helperId.startsWith("phone:")) {
    const phoneId = helperId.slice("phone:".length);
    return captureFromVideoEl(helperId, _phoneStreams.has(phoneId));
  }
  return { error: `unknown helper: ${helperId}` };
}

async function startLaptopCam() {
  if (_laptop.status === "live") return { ok: true, already: true };
  _laptop.status = "starting";
  _laptop.error = null;
  render();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    _laptop.stream = stream;
    _laptop.status = "live";
    _laptop.startedAt = Date.now();
    const track = stream.getVideoTracks()[0];
    _laptop.trackSettings = track ? track.getSettings() : null;
    track?.addEventListener("ended", () => stopLaptopCam());
    render();
    emitLaptopChange();
    return { ok: true };
  } catch (err) {
    _laptop.status = "error";
    _laptop.error = err?.message || String(err);
    _laptop.stream = null;
    render();
    return { error: _laptop.error };
  }
}

function stopLaptopCam() {
  if (_laptop.stream) {
    for (const t of _laptop.stream.getTracks()) { try { t.stop(); } catch {} }
  }
  _laptop.stream = null;
  _laptop.trackSettings = null;
  _laptop.startedAt = null;
  _laptop.status = "idle";
  _laptop.error = null;
  _videoEls.delete(LAPTOP_ID);
  render();
  emitLaptopChange();
}

function captureLaptopFrame(maxDim = 640, quality = 0.8) {
  return captureFromVideoEl(LAPTOP_ID, _laptop.status === "live", maxDim, quality);
}

// Shared between laptop + phone helpers. The videoEl is looked up from
// _videoEls (populated in wire() after render); isLive guards against
// stale video elements left over from a just-ended stream.
function captureFromVideoEl(helperId, isLive, maxDim = 640, quality = 0.8) {
  const v = _videoEls.get(helperId);
  if (!v || !isLive) {
    return { error: `${helperId}: no live stream — start the camera first` };
  }
  let w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) return { error: `${helperId}: frame not ready yet` };
  if (Math.max(w, h) > maxDim) {
    const s = maxDim / Math.max(w, h);
    w = Math.round(w * s); h = Math.round(h * s);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  try {
    canvas.getContext("2d").drawImage(v, 0, 0, w, h);
    return { imageDataUrl: canvas.toDataURL("image/jpeg", quality), width: w, height: h };
  } catch (err) {
    return { error: `frame capture failed: ${err?.message || err}` };
  }
}

function render() {
  const list = $("helpers-list");
  if (!list) return;
  const phones = listPhones();
  const cards = [];

  for (const p of phones) cards.push(renderPhoneCard(p));
  cards.push(renderLaptopCard());

  if (phones.length === 0 && _laptop.status === "idle") {
    list.innerHTML = `
      ${cards.join("")}
      <div class="helpers-empty hint">No phones paired yet — tap "Pair phone" to add one.</div>
    `;
  } else {
    list.innerHTML = cards.join("");
  }
  wire();
}

function statusClass(p) {
  if (p.status === "connected") return "status-connected";
  if (p.status === "reconnecting" || p.status === "starting") return "status-connecting";
  if (p.status === "error") return "status-error";
  return "";
}

function renderPhoneCard(p) {
  const cls = statusClass(p);
  const statusText = p.status === "connected"
    ? ""
    : p.status === "reconnecting"
      ? "Reconnecting…"
      : p.status === "error"
        ? "Offline"
        : escapeHtml(p.status);
  const ps = _phoneStreams.get(p.id);
  const live = !!ps;
  const helperId = `phone:${p.id}`;
  const meta = live
    ? `Sharing camera · ${ps.trackSettings?.width || "?"}×${ps.trackSettings?.height || "?"}`
    : escapeHtml(`id ${p.id.slice(0, 8)}…`);
  const body = live
    ? `<video class="helper-video" data-helper-video="${escapeHtml(helperId)}" autoplay playsinline muted></video>`
    : "";
  return `
    <section class="card robot helper ${cls}" data-helper-id="${escapeHtml(helperId)}">
      <div class="row">
        <div class="robot-identity">
          <div class="label-btn">
            ${escapeHtml(p.label || "Phone")}
            <span class="type-badge">PHONE</span>
          </div>
          ${statusText ? `<div class="status">${statusText}</div>` : ""}
        </div>
      </div>
      <div class="robot-secondary">
        <div class="robot-meta">${meta}</div>
        <div class="robot-cta">
          <button class="secondary sm" data-action="phone-notice" data-phone-id="${escapeHtml(p.id)}">Send notice</button>
        </div>
      </div>
      ${body ? `<div class="robot-body">${body}</div>` : ""}
    </section>
  `;
}

function renderLaptopCard() {
  const live = _laptop.status === "live";
  const starting = _laptop.status === "starting";
  const errored = _laptop.status === "error";
  const cls = live ? "status-connected" : starting ? "status-connecting" : errored ? "status-error" : "";
  const statusText = errored ? "Error" : starting ? "Starting…" : "";
  const res = _laptop.trackSettings
    ? `${_laptop.trackSettings.width || "?"}×${_laptop.trackSettings.height || "?"}`
    : "";
  const meta = live ? `Streaming · ${escapeHtml(res)}` : "Idle";
  const action = live
    ? `<button class="secondary sm" data-action="laptop-stop">Stop</button>`
    : `<button class="sm" data-action="laptop-start" ${starting ? "disabled" : ""}>${starting ? "Starting…" : "Start"}</button>`;
  // Body only renders when there's something to show: live video or an error.
  // Idle state is fully described by the Start button — no instruction prose
  // needed (the verb does the work).
  let body = "";
  if (live) body = `<video class="helper-video" data-helper-video="${LAPTOP_ID}" autoplay playsinline muted></video>`;
  else if (errored) body = `<div class="hint">${escapeHtml(_laptop.error || "Camera unavailable")}</div>`;
  return `
    <section class="card robot helper ${cls}" data-helper-id="${LAPTOP_ID}">
      <div class="row">
        <div class="robot-identity">
          <div class="label-btn">
            ${escapeHtml(_laptop.label)}
            <span class="type-badge">CAM</span>
          </div>
          ${statusText ? `<div class="status">${statusText}</div>` : ""}
        </div>
      </div>
      <div class="robot-secondary">
        <div class="robot-meta">${meta}</div>
        <div class="robot-cta">${action}</div>
      </div>
      ${body ? `<div class="robot-body">${body}</div>` : ""}
    </section>
  `;
}

function wire() {
  const list = $("helpers-list");
  if (!list) return;

  list.querySelectorAll('[data-action="laptop-start"]').forEach(btn => {
    btn.addEventListener("click", () => startLaptopCam());
  });
  list.querySelectorAll('[data-action="laptop-stop"]').forEach(btn => {
    btn.addEventListener("click", () => stopLaptopCam());
  });
  list.querySelectorAll('[data-action="phone-notice"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const phoneId = btn.dataset.phoneId;
      const text = prompt("Notice text to send to phone:");
      if (text == null || text.trim() === "") return;
      sendToPhone(phoneId, text.trim());
    });
  });
  // Mount the live MediaStream into the freshly-rendered <video> elements.
  // Has to happen after innerHTML rebuild — srcObject before DOM attach is
  // OK but we re-render on every state change so we re-attach unconditionally.
  const lv = list.querySelector(`[data-helper-video="${LAPTOP_ID}"]`);
  if (lv && _laptop.stream) {
    lv.srcObject = _laptop.stream;
    _videoEls.set(LAPTOP_ID, lv);
  }
  for (const [phoneId, entry] of _phoneStreams) {
    const helperId = `phone:${phoneId}`;
    const pv = list.querySelector(`[data-helper-video="${CSS.escape(helperId)}"]`);
    if (pv && entry.stream) {
      pv.srcObject = entry.stream;
      _videoEls.set(helperId, pv);
    }
  }
}
