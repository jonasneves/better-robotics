// Desktop-side state + UI for phones paired over WebRTC (pairing.js). Phones
// are intentionally session-scoped — the signal room has a 1h TTL and users
// re-pair when they come back. Nothing persisted to localStorage.
//
// The chat handler is injected from app.js so this module stays unaware of
// Pip's internals (see assistant.js's handleRemoteChat). webmcp-style tools
// in pip-tools.js call listPhones()/sendToPhone() to let the agent see and
// notify paired phones.
import { $ } from "./dom.js";
// helpers.js owns the visible card render now; phones.js notifies via
// setPhonesChangeHandler so this module stays unaware of the dashboard layout.
import { log } from "./log.js";
import { hostPairingRoom } from "./pairing.js";
import { sendPairById, pickMotorsTarget } from "./capabilities/runtime/signed-pair.js";
import { getLaptopStream, onLaptopChange } from "./helpers.js";
import { discover } from "./discover.js";

// Single shared lobby instance — desktop publishes a pairing ad while the
// dialog is open so a phone on the same wifi can land directly on the
// pairing room without scanning the QR. Removed on cancel/connect so a
// stale ad doesn't survive past its room.
let _lobby = null;
function getLobby() { return _lobby || (_lobby = discover()); }
function deviceLabel() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  if (/Mac/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "Computer";
}

const _phones = new Map();  // roomId → { id, label, peer, connectedAt, status, statusDetail }
// askId → { resolve, timeout, phoneId } — outstanding ask_human requests.
// Keyed by askId, not phoneId, so simultaneous asks to different phones
// (or the same one, though Pip shouldn't) don't collide.
const _pendingAsks = new Map();
let _chatHandler = null;
let _pendingSession = null;
// helpers.js subscribes to phone-state changes so it can re-render the
// "Your helpers" section. Kept as a single handler — only one consumer.
let _changeHandler = null;

export function setPhoneChatHandler(fn) { _chatHandler = fn; }
export function setPhonesChangeHandler(fn) { _changeHandler = fn; }

export function listPhones() {
  return [..._phones.values()].map(p => ({
    id: p.id, label: p.label, connectedAt: p.connectedAt,
    status: p.status || "connected", statusDetail: p.statusDetail || "",
  }));
}

export function sendToPhone(id, text) {
  const p = _phones.get(id);
  if (!p) return false;
  p.peer.send({ type: "notice", text });
  return true;
}

// Push a VLM scene description to every paired phone. Separate channel from
// notices/chat-replies so phones can render the stream of observations under
// the camera label rather than clobbering Pip's last reply.
export function broadcastSceneToPhones({ source, text }) {
  for (const p of _phones.values()) {
    p.peer.send({ type: "scene", source, text });
  }
}

// ask_human primitive — send the phone user a question + optional image,
// block until they answer or timeout. Resolves with { answer, timed_out }:
// answer is a string when the user tapped an option or typed a reply,
// null when they skipped, and the promise resolves (not rejects) on timeout
// so Pip can keep operating instead of crashing on a distracted user.
//
// PROTOCOL PARITY — must match phone.js:
//   desktop → phone  { type:"ask",       askId, question, options, imageDataUrl }
//   phone → desktop  { type:"ask-reply", askId, answer }
// The receiver on phone.js is showAsk(); its response path posts ask-reply
// back here, resolved by the "ask-reply" branch in onPhoneMessage below.
// askId must round-trip identical or the lookup silently drops the reply
// (malformed/unknown reply ids are ignored, by design — late-after-timeout
// replies shouldn't resurrect a resolved promise). If you rename any field
// on either side, update both at once.
export function askHuman(phoneId, { question, options = [], imageDataUrl = null, timeoutMs = 60000 } = {}) {
  const phone = _phones.get(phoneId);
  if (!phone) return Promise.reject(new Error(`phone ${phoneId} not paired`));
  const askId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (!_pendingAsks.has(askId)) return;
      _pendingAsks.delete(askId);
      resolve({ answer: null, timed_out: true });
    }, timeoutMs);
    _pendingAsks.set(askId, { resolve, timeout, phoneId });
    phone.peer.send({ type: "ask", askId, question, options, imageDataUrl });
  });
}

export function initPhones() {
  const pairBtn = $("pair-phone-btn");
  if (pairBtn) pairBtn.addEventListener("click", beginPairing);
  const closeBtn = $("pair-dialog-close");
  if (closeBtn) closeBtn.addEventListener("click", closePairing);
  const cancelBtn = $("pair-cancel-btn");
  if (cancelBtn) cancelBtn.addEventListener("click", closePairing);
  // Live presence: subscribe to phone-ready ads on the same wifi so the
  // user sees discovery is healthy before opening the pair dialog. Same
  // lobby instance the dialog uses for publishing — getLobby is shared.
  getLobby().onChange(renderPhonePresence);
  // Laptop camera → phone(s) bridge: whenever the laptop transitions, sync
  // every paired phone's media tracks. Goes both ways — going live adds
  // tracks, stopping removes them. Phones connected later pick up the live
  // stream in onPhonePaired.
  onLaptopChange((stream) => {
    for (const p of _phones.values()) syncPhoneMedia(p, stream);
  });
}

// Per-phone book-keeping for the RTCRtpSenders we've added (so we can
// removeTrack when the source goes away). One sender per laptop track.
function syncPhoneMedia(phone, stream) {
  if (!phone || phone.status === "failed") return;
  // Remove anything we previously added.
  if (phone.laptopSenders?.length) {
    for (const s of phone.laptopSenders) phone.peer.removeTrack(s);
    phone.laptopSenders = [];
  }
  if (!stream) return;
  const senders = [];
  for (const t of stream.getVideoTracks()) {
    const s = phone.peer.addTrack(t, stream);
    if (s) senders.push(s);
  }
  phone.laptopSenders = senders;
}

function closePairing() {
  if (_pendingSession) {
    try { getLobby().remove("better-robotics-pair:" + _pendingSession.roomId); } catch {}
  }
  _pendingSession?.cancel();
  _pendingSession = null;
  $("pair-dialog").classList.remove("has-ready-phones");
  $("pair-dialog").close();
}

// Count of phones currently broadcasting "ready to pair" on this wifi.
// Drives both the helpers-heading presence badge and the pair-dialog
// switch from "QR primary" to "phone is right there, just tap it on
// the phone screen" mode.
function renderPhonePresence(ads) {
  const phones = (ads || []).filter(a => a.data && a.data.app === "better-robotics-phone-ready");
  const count = phones.length;
  // Helpers heading badge — passive indicator, visible whenever at least
  // one unpaired phone is on the wifi.
  const badge = $("phone-presence");
  if (badge) {
    if (count > 0) {
      badge.hidden = false;
      const label = phones[0].data.label || "Phone";
      badge.textContent = count === 1 ? `${label} on wifi` : `${count} phones on wifi`;
    } else {
      badge.hidden = true;
    }
  }
  // Pair dialog: when phone-ready peers exist, surface that and de-emphasize
  // the QR. The room is already advertised on the lobby — the phone just
  // needs to tap "Pair with this computer" on its own screen.
  const dialog = $("pair-dialog");
  const hint = $("pair-presence-text");
  if (dialog) {
    const presence = $("pair-presence");
    if (presence) {
      presence.hidden = count === 0;
      if (count > 0 && hint) {
        hint.textContent = count === 1
          ? `${phones[0].data.label || "Phone"} ready — tap "Pair with this computer" on it.`
          : `${count} phones ready — tap "Pair with this computer" on the one you want.`;
      }
    }
    dialog.classList.toggle("has-ready-phones", count > 0);
  }
}

async function beginPairing() {
  const dialog = $("pair-dialog");
  const statusEl = $("pair-status");
  const qrEl = $("pair-qr");
  const urlEl = $("pair-url");
  qrEl.innerHTML = "";
  urlEl.textContent = "";
  statusEl.textContent = "Generating room…";
  dialog.showModal();

  // onStatus gives us live pair-progress to surface in the dialog — without
  // it, a stuck negotiation looks identical to a working one (just "Waiting
  // for phone…" forever). Stage echoes go through statusEl so the user can
  // distinguish "phone never showed up" from "phone here but p2p stalled".
  const session = await hostPairingRoom({
    onStatus: (s) => { statusEl.textContent = s; },
  });
  _pendingSession = session;

  const url = new URL("phone.html", window.location.href);
  url.hash = `pair=${session.roomId}`;
  const urlText = url.toString();

  // qrcode-generator is loaded globally in index.html.
  if (window.qrcode) {
    const qr = window.qrcode(0, "L");
    qr.addData(urlText);
    qr.make();
    qrEl.innerHTML = qr.createSvgTag({ margin: 2, scalable: true });
  } else {
    qrEl.textContent = "(QR library not loaded)";
  }
  urlEl.textContent = urlText;
  statusEl.textContent = "Waiting for phone…";

  // Advertise this pairing room to LAN peers — phone.html (loaded without a
  // #pair= hash) shows desktops on the wifi as one-tap join targets.
  try {
    getLobby().publish("better-robotics-pair:" + session.roomId, {
      app: "better-robotics-pair",
      roomId: session.roomId,
      label: deviceLabel(),
      pageUrl: urlText
    }, 60000);
  } catch {}

  try {
    const peer = await session.waitForPeer();
    if (_pendingSession !== session) { peer.close(); return; }  // user cancelled
    const id = session.roomId;
    // Room is now occupied — drop the ad so no second phone tries to
    // hijack the same pairing.
    try { getLobby().remove("better-robotics-pair:" + session.roomId); } catch {}
    _phones.set(id, { id, label: "Phone", peer, connectedAt: Date.now(), status: "connected", statusDetail: "" });
    statusEl.textContent = "Connected";
    log("phone paired", "phone");

    peer.onMessage((msg) => onPhoneMessage(id, peer, msg));
    // Status events from the pairing layer: reconnecting is transient, failed
    // is terminal. We only drop the phone from the UI on terminal; reconnecting
    // just re-renders the card with the new state badge so the user can see
    // what's happening instead of the connection going silent.
    peer.onStatus((status, detail) => {
      const phone = _phones.get(id);
      if (!phone) return;
      phone.status = status;
      phone.statusDetail = detail || "";
      renderPhones();
      // When we come back to connected after a drop, re-push target info
      // so the phone's joypad picks the right robot.
      if (status === "connected") sendTargetInfo(peer);
    });
    peer.onClose(() => {
      // Safety stop: if this phone was driving a robot and drops offline,
      // zero the motors so the robot doesn't keep running on its last
      // command. Firmware watchdog would catch it in ~600ms anyway, but
      // we can be explicit here at zero cost.
      const lastDriven = _phones.get(id)?.lastTarget;
      if (lastDriven) { try { sendPairById(lastDriven, "motors", 0, 0); } catch {} }
      // Resolve any in-flight asks against this phone as timeouts so Pip
      // unblocks gracefully; without this, tool calls would hang forever.
      for (const [askId, p] of _pendingAsks) {
        if (p.phoneId !== id) continue;
        clearTimeout(p.timeout);
        _pendingAsks.delete(askId);
        p.resolve({ answer: null, timed_out: true });
      }
      _phones.delete(id);
      log("phone disconnected", "phone");
      renderPhones();
    });
    // Tell the phone what it's driving (if anything). Sent once on connect —
    // phones.js doesn't watch state.devices for changes, so if the target
    // robot disconnects the phone will keep showing the old name until it
    // sends a drive message that fails silently. Acceptable for v1.
    sendTargetInfo(peer);
    // Phase A media: if the laptop is already streaming, pipe its tracks to
    // this fresh phone. Future sources (robot cam, other phones) plug into
    // syncPhoneMedia the same way.
    syncPhoneMedia(_phones.get(id), getLaptopStream());
    renderPhones();
    _pendingSession = null;
    // Let the user see the "Connected" text briefly before the dialog closes.
    setTimeout(() => { if (dialog.open) dialog.close(); }, 800);
  } catch (err) {
    if (_pendingSession === session) {
      // Inline retry beats "close the dialog and click Pair again" — failure
      // mode for pairing is almost always transient (ICE flakiness, captive
      // portal mid-negotiation), so the right affordance is one click.
      statusEl.innerHTML = "";
      const msg = document.createElement("span");
      msg.textContent = `${err.message || err} `;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "secondary sm";
      retry.textContent = "Try again";
      retry.style.marginLeft = "8px";
      retry.addEventListener("click", () => beginPairing());
      statusEl.appendChild(msg);
      statusEl.appendChild(retry);
      _pendingSession = null;
    }
  }
}

async function onPhoneMessage(id, peer, msg) {
  if (msg.type === "ask-reply") {
    const pending = _pendingAsks.get(msg.askId);
    if (!pending) return;  // late reply after timeout — drop silently
    clearTimeout(pending.timeout);
    _pendingAsks.delete(msg.askId);
    pending.resolve({ answer: msg.answer ?? null, timed_out: false });
    return;
  }
  if (msg.type === "chat") {
    const text = (msg.text || "").trim();
    if (!text) return;
    if (!_chatHandler) {
      peer.send({ type: "chat-reply", text: "Pip isn't wired to the phone path yet — check initPhones/setPhoneChatHandler." });
      return;
    }
    try {
      const reply = await _chatHandler(text);
      peer.send({ type: "chat-reply", text: reply ?? "(no response)" });
    } catch (err) {
      peer.send({ type: "chat-reply", text: `Error: ${err.message || err}` });
    }
    return;
  }
  if (msg.type === "drive") {
    // Route phone joypad output to the first connected robot with motors.
    // Drop silently when no robot is available — phone UI already hides the
    // joypad when target-info says "no target", so this should be rare.
    const target = pickMotorsTarget();
    if (!target) return;
    const phone = _phones.get(id);
    if (phone) phone.lastTarget = target.id;  // remember for safety-stop on disconnect
    const l = Math.max(-100, Math.min(100, Number(msg.l) || 0));
    const r = Math.max(-100, Math.min(100, Number(msg.r) || 0));
    sendPairById(target.id, "motors", l, r);
    return;
  }
}

function sendTargetInfo(peer) {
  const target = pickMotorsTarget();
  peer.send({
    type: "target-info",
    target: target ? { id: target.id, name: target.name } : null,
  });
}

function renderPhones() {
  _changeHandler?.();
}
