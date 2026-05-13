// Desktop-side state + UI for phones paired over WebRTC (pairing.js). Phones
// are intentionally session-scoped — the signal room has a 1h TTL and users
// re-pair when they come back. Nothing persisted to localStorage.
//
// The chat handler is injected from app.js so this module stays unaware of
// Pip's internals (see assistant.js's handleRemoteChat). webmcp-style tools
// in pip-tools.js call listPhones()/sendToPhone() to let the agent see and
// notify paired phones.
import { $ } from "./dom.js";
import { log } from "./log.js";
import { hostPairingRoom } from "./pairing.js";
import { sendPairById, pickMotorsTarget } from "./capabilities/runtime/signed-pair.js";
import { state } from "./state.js";
import { setPhoneStream } from "./helpers.js";
import { discover } from "./signal-sdk/v1/discover.js";
import { getMyPubkeyB64 } from "./signal-sdk/v1/peer-key.js";
import { makeTrustStore } from "./trust.js";
import { pairRequestClient } from "./signal-sdk/v1/pair-request.js";
const _trust = makeTrustStore("better-robotics:trust:v1");

// Single shared lobby in signed mode: ads carry our device pubkey so the
// peer side knows "this is the Mac I trusted before" without re-prompting.
//
// Pair model is request/accept (AirDrop-shaped):
//   - We publish "better-robotics-mac" presence ad always-on while the
//     dashboard is loaded. Phones on the same wifi see us and can tap.
//   - When a phone taps, it publishes a "better-robotics-pair-request"
//     targeted at our pubkey. We surface a modal: Accept / Deny / Trust.
//   - On Accept, we create a fresh WebRTC pair session and publish a
//     "better-robotics-pair-response" with the roomId; the phone joins.
//   - "Trust" stores the phone's pubkey for auto-accept on future requests.
//
// QR / pair dialog still exists for the cross-network case (phone not on
// the same wifi → no shared lobby → no discovery). Becomes the fallback,
// not the primary.
let _lobby = null;
let _myPubkey = null;
function getLobby() { return _lobby || (_lobby = discover({ sign: true })); }
function deviceLabel() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  if (/Mac/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "Computer";
}

const _phones = new Map();  // roomId → { id, label, peer, connectedAt, status, statusDetail }
// askId → { resolve, timeout, phoneId }. Keyed by askId so simultaneous
// asks to different phones don't collide.
const _pendingAsks = new Map();
let _pendingSession = null;
let _changeHandler = null;

export function setPhonesChangeHandler(fn) { _changeHandler = fn; }

export function listPhones() {
  return [..._phones.values()].map(p => ({
    id: p.id, label: p.label, connectedAt: p.connectedAt,
    status: p.status || "connected", statusDetail: p.statusDetail || "",
  }));
}

// Push a VLM scene description to every paired phone. Separate channel from
// notices/chat-replies so phones can render the stream of observations under
// the camera label rather than clobbering Pip's last reply.
export function broadcastSceneToPhones({ source, text }) {
  for (const p of _phones.values()) {
    p.peer.send({ type: "scene", source, text });
  }
}

// Wire (must match showAsk in mobile.js):
//   desktop→phone  { type:"ask",       askId, question, options, imageDataUrl }
//   phone→desktop  { type:"ask-reply", askId, answer }
// Resolves (never rejects) on timeout so Pip keeps operating. Late or
// mismatched askId is dropped — replies after timeout don't resurrect a
// resolved promise.
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

export async function initPhones() {
  const pairBtn = $("pair-phone-btn");
  if (pairBtn) pairBtn.addEventListener("click", beginPairing);
  const closeBtn = $("pair-dialog-close");
  if (closeBtn) closeBtn.addEventListener("click", dismissPairingDialog);
  const cancelBtn = $("pair-cancel-btn");
  if (cancelBtn) cancelBtn.addEventListener("click", closePairing);
  const pairDialog = $("pair-dialog");
  if (pairDialog) pairDialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    dismissPairingDialog();
  });
  // Wire the request prompt buttons.
  $("pair-request-accept")?.addEventListener("click", () => _resolveRequestPrompt(true));
  $("pair-request-deny")?.addEventListener("click", () => _resolveRequestPrompt(false));

  // Lazily-loaded — but we need it before we can publish presence or
  // know which incoming requests target us.
  _myPubkey = await getMyPubkeyB64();

  // Always-on Mac presence so phones on the wifi see us without us
  // having to open a dialog. discover.js auto-republishes every 25s.
  getLobby().publish("better-robotics-mac:" + _myPubkey, {
    app: "better-robotics-mac",
    label: deviceLabel(),
  }, 60000);

  getLobby().onChange(renderPhonePresence);
  _initPairListener();
}

// Robot camera → phone bridge. Keyed per robot id; pairing.js's
// negotiationneeded handler re-offers after addTrack so the track lands
// on the phone automatically.
//
// Stream sources, in priority order (one stream forwarded at a time):
//   1. attachedCameraStream — phone-as-eye mounted on the robot.
//   2. cameraStream — robot's native camera. ESP32's MJPEG goes through
//      mjpeg-restream's canvas captureStream; Pi WebRTC cams produce one
//      directly.
//
// When forwarding the attached stream, skip the source phone (would echo
// its own camera back). attachedFromPhoneId === phone.id is the marker.
function availableSourcesFor(entry) {
  const sources = [];
  if (entry.cameraStream) {
    sources.push({
      id: "native",
      kind: "native",
      label: "Robot camera",
      fwType: entry.fwType || null,
    });
  }
  if (entry.attachedCameraStream) {
    sources.push({
      id: "attached",
      kind: "attached",
      label: "Phone-mounted camera",
      fromPhoneId: entry.attachedFromPhoneId || null,
    });
  }
  return sources;
}

// Default: attached preferred over native. Phone overrides via
// subscribe-source messages, recorded in phone.robotSourcePrefs.
function resolveStreamForPhone(phone, entry) {
  const pref = phone.robotSourcePrefs?.get(entry.id);
  if (pref === "native" && entry.cameraStream) return entry.cameraStream;
  if (pref === "attached"
      && entry.attachedCameraStream
      && entry.attachedFromPhoneId !== phone.id) {
    return entry.attachedCameraStream;
  }
  // Default: attached (when not the source phone) > native.
  if (entry.attachedCameraStream && entry.attachedFromPhoneId !== phone.id) {
    return entry.attachedCameraStream;
  }
  return entry.cameraStream || null;
}

function syncRobotMedia(phone, entry) {
  if (!phone || phone.status === "failed") return;
  if (!phone.robotSenders) phone.robotSenders = new Map();
  const prev = phone.robotSenders.get(entry.id) || [];
  for (const s of prev) { try { phone.peer.removeTrack(s); } catch {} }
  phone.robotSenders.delete(entry.id);
  // Always re-publish the source list — kept in sync with track changes
  // so the phone's picker shows what's actually available right now.
  try {
    phone.peer.send({
      type: "available-sources",
      robotId: entry.id,
      sources: availableSourcesFor(entry),
      active: phone.robotSourcePrefs?.get(entry.id) || null,
    });
  } catch {}
  const stream = resolveStreamForPhone(phone, entry);
  if (!stream) return;
  const senders = [];
  for (const t of stream.getVideoTracks()) {
    const s = phone.peer.addTrack(t, stream);
    if (s) senders.push(s);
  }
  if (senders.length) phone.robotSenders.set(entry.id, senders);
}

export function notifyRobotStreamChange(entry) {
  for (const p of _phones.values()) syncRobotMedia(p, entry);
}

function closePairing() {
  // Explicit cancel: kill the session and close the UI. Wired to the
  // Cancel button (user explicitly aborts).
  if (_pendingSession) {
    try { getLobby().remove("better-robotics-pair:" + _pendingSession.roomId); } catch {}
  }
  _pendingSession?.cancel();
  _pendingSession = null;
  $("pair-dialog").classList.remove("has-ready-phones");
  $("pair-dialog").close();
}

function dismissPairingDialog() {
  // Close the UI but leave the session alive. If a phone connects
  // before the natural 30s timeout, it registers normally and shows
  // up in the helpers list. Wired to × and Esc — gestures that
  // should mean "I'm done with this dialog," not "abort the operation."
  $("pair-dialog").classList.remove("has-ready-phones");
  $("pair-dialog").close();
}

// Latest phone-presence ads, cached so the pair dialog can render its
// nearby-phones state on open without waiting for the next discovery tick.
let _lastPhoneAds = [];

// Passive presence: count badge in the helpers heading. Pair flow
// is driven by phones sending requests, not by us deciding ahead.
function renderPhonePresence(ads) {
  _lastPhoneAds = (ads || []).filter(a => a.data && a.data.app === "better-robotics-phone");
  const btn = $("pair-phone-btn");
  if (btn) {
    const total = _lastPhoneAds.length;
    btn.classList.toggle("has-nearby", total > 0);
    const label = total === 0
      ? "Pair a phone"
      : total === 1
        ? `Pair a phone — ${_lastPhoneAds[0].data.label || "1 phone"} nearby`
        : `Pair a phone — ${total} phones nearby`;
    // Mirror the title to aria-label so screen-reader users hear the same
    // presence info sighted users see in the tooltip + dot.
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }
  _renderPairDialogNearby();
}

// If the pair dialog is open and phones are nearby, surface the same-wifi
// shortcut inline so the user doesn't need to close + use the menu.
// Hidden when no phones are detected — dialog falls back to QR-only.
function _renderPairDialogNearby() {
  const dialog = $("pair-dialog");
  const hintEl = $("pair-nearby-hint");
  if (!dialog || !hintEl || !dialog.open) return;
  if (_lastPhoneAds.length === 0) {
    hintEl.hidden = true;
    return;
  }
  hintEl.hidden = false;
  const count = _lastPhoneAds.length === 1 ? "Phone" : `${_lastPhoneAds.length} phones`;
  hintEl.textContent = `${count} nearby — open phone.html and tap "${deviceLabel()}" instead of scanning.`;
}

// ── Incoming pair-requests ────────────────────────────────────────
//
// Protocol lives in signal/client/pair-request.js now — we supply
// the match rule (ads targeted at our pubkey), the trust lookup,
// and the UI (existing modal in this file). The library owns
// nonce-dedup, subscribe filter, response publish, and timeout.
//
// Transport: the wss://signal.neevs.io discover lobby (cross-network,
// always-on).
let _wssPairClient = null;

async function _onPairRequest(req) {
  const senderPubkey = req.senderPubkey;
  const senderLabel  = req.payload.label || 'Phone';
  if (!senderPubkey) return;
  if (_trust.isAutoAccept(senderPubkey)) {
    log(`auto-accepting paired phone "${senderLabel}"`, 'phone');
    await _respondAndHostPair(true, senderPubkey, senderLabel, req, false);
    return;
  }
  const decision = await _showRequestPrompt(senderLabel, senderPubkey);
  if (!decision) { await req.deny(); return; }
  await _respondAndHostPair(decision.accepted, senderPubkey, senderLabel, req, decision.trust);
}

const _pairOnRequestOpts = {
  // Pubkey-target match — attackers on the same wifi can publish to
  // any address, but only ads addressed to our key fire the prompt.
  match: (ad) => ad.data.target === _myPubkey,
  onError: (err) => log("pair-request handler: " + (err && err.message || err), "phone"),
};

function _initPairListener() {
  if (_wssPairClient) return;
  _wssPairClient = pairRequestClient({ app: 'better-robotics-pair', sign: true, lobby: getLobby() });
  _wssPairClient.onRequest(_onPairRequest, _pairOnRequestOpts);
}

// Modal prompt promise — single in-flight; if a second request comes
// while one is open, queue it (rare, and simpler than racing).
let _promptInflight = null;
const _promptQueue = [];
let _promptResolver = null;
function _resolveRequestPrompt(accepted) {
  if (!_promptResolver) return;
  const trust = !!$("pair-request-trust")?.checked;
  const r = _promptResolver;
  _promptResolver = null;
  $("pair-request-dialog")?.close();
  r({ accepted, trust });
}
function _showRequestPrompt(label, pubkey) {
  if (_promptInflight) {
    return new Promise(resolve => _promptQueue.push({ label, pubkey, resolve }));
  }
  return _promptInflight = new Promise((resolve) => {
    const dialog = $("pair-request-dialog");
    if (!dialog) { resolve(null); _promptInflight = null; return; }
    $("pair-request-label").textContent = label;
    const trustCb = $("pair-request-trust");
    if (trustCb) trustCb.checked = false;
    _promptResolver = (decision) => {
      _promptInflight = null;
      resolve(decision);
      const next = _promptQueue.shift();
      if (next) {
        // Re-enter for the queued one — same promise contract.
        _showRequestPrompt(next.label, next.pubkey).then(next.resolve);
      }
    };
    dialog.showModal();
    // Auto-dismiss after 30s — phone stops waiting then anyway.
    setTimeout(() => {
      if (_promptResolver) _resolveRequestPrompt(false);
    }, 30000);
  });
}


async function _respondAndHostPair(accepted, senderPubkey, senderLabel, req, autoTrust) {
  if (!accepted) { await req.deny(); return; }
  let session;
  try {
    session = await hostPairingRoom({ onStatus: () => {} });
  } catch (err) {
    log("hostPairingRoom failed: " + (err.message || err), "phone");
    await req.deny();
    return;
  }
  await req.accept({ roomId: session.roomId });
  // Memorize trust BEFORE the WebRTC handshake — the user already
  // consented; if pairing fails, the trust still holds (next attempt
  // won't re-prompt).
  if (autoTrust) _trust.trust(senderPubkey, senderLabel);
  try {
    const peer = await session.waitForPeer();
    _registerPairedPhone(session.roomId, peer, senderLabel);
  } catch (err) {
    log("pair waitForPeer failed: " + (err.message || err), "phone");
  }
}

// Common peer setup — used by both the QR flow (beginPairing) and the
// request/accept flow (_respondAndHostPair). Adds the phone to _phones,
// wires data channel handlers, sends our pair-keys greeting.
function _registerPairedPhone(id, peer, defaultLabel) {
  // If a QR session was waiting in the background and *this* pair came in
  // through a different room (i.e. the wifi-tap path), retire the QR
  // session and close its dialog — the user got what they wanted via the
  // other route, the QR has no purpose now. (QR-flow callers null
  // _pendingSession after this call, so the id-mismatch guard skips them.)
  if (_pendingSession && _pendingSession.roomId !== id) {
    try { getLobby().remove("better-robotics-pair:" + _pendingSession.roomId); } catch {}
    _pendingSession.cancel();
    _pendingSession = null;
    const dialog = $("pair-dialog");
    if (dialog?.open) dialog.close();
  }
  _phones.set(id, { id, label: defaultLabel || "Phone", peer, connectedAt: Date.now(), status: "connected", statusDetail: "" });
  log("phone paired", "phone");
  try { peer.send({ type: "pair-keys", pubkey: _myPubkey, label: deviceLabel() }); } catch {}
  peer.onMessage((msg) => {
    if (msg && msg.type === "pair-keys" && msg.pubkey) {
      // Phone returns its pubkey. We may already trust it (autoTrust
      // path), but this also catches the QR path where trust gets
      // bound here, and refreshes the label.
      _trust.trust(msg.pubkey, msg.label || "Phone");
      const phone = _phones.get(id);
      if (phone && msg.label) { phone.label = msg.label; renderPhones(); }
      return;
    }
    onPhoneMessage(id, peer, msg);
  });
  peer.onStatus((status, detail) => {
    const phone = _phones.get(id);
    if (!phone) return;
    phone.status = status;
    phone.statusDetail = detail || "";
    renderPhones();
    if (status === "connected") sendTargetInfo(peer);
  });
  peer.onClose(() => {
    const lastDriven = _phones.get(id)?.lastTarget;
    if (lastDriven) { try { sendPairById(lastDriven, "motors", 0, 0); } catch {} }
    for (const [askId, p] of _pendingAsks) {
      if (p.phoneId !== id) continue;
      clearTimeout(p.timeout);
      _pendingAsks.delete(askId);
      p.resolve({ answer: null, timed_out: true });
    }
    _phones.delete(id);
    setPhoneStream(id, null);  // clear any helper-list entry for this phone's camera
    log("phone disconnected", "phone");
    renderPhones();
  });
  // Phone camera comes in through peer.onTrack — user taps "Share camera"
  // on phone.html, pairing.js renegotiates, track lands here. Stream
  // flows to helpers.js and renders as a helper card with inline video.
  peer.onTrack((e) => {
    const stream = e.streams?.[0] || new MediaStream([e.track]);
    setPhoneStream(id, stream);
    e.track.addEventListener("ended", () => {
      if (stream.getTracks().every(t => t.readyState === "ended")) {
        setPhoneStream(id, null);
      }
    });
  });
  sendTargetInfo(peer);
  // Same for any robot cameras that are already streaming — phone sees
  // the robot's view as soon as it pairs, not only if it pairs first.
  const phone = _phones.get(id);
  for (const entry of state.devices.values()) {
    if (entry.cameraStream) syncRobotMedia(phone, entry);
  }
}

async function beginPairing() {
  const dialog = $("pair-dialog");
  const statusEl = $("pair-status");
  const qrEl = $("pair-qr");
  const urlEl = $("pair-url");
  // If a previous session was dismissed (× or Esc) and is still
  // waiting in the background, retire it now — opening this dialog
  // means the user wants a fresh QR.
  if (_pendingSession) {
    try { getLobby().remove("better-robotics-pair:" + _pendingSession.roomId); } catch {}
    _pendingSession.cancel();
    _pendingSession = null;
  }
  qrEl.innerHTML = "";
  urlEl.textContent = "";
  statusEl.textContent = "Generating room…";
  statusEl.classList.add("is-waiting");
  dialog.showModal();
  _renderPairDialogNearby();

  // onStatus gives us live pair-progress to surface in the dialog — without
  // it, a stuck negotiation looks identical to a working one (just "Waiting
  // for phone…" forever). Stage echoes go through statusEl so the user can
  // distinguish "phone never showed up" from "phone here but p2p stalled".
  const session = await hostPairingRoom({
    onStatus: (s) => { statusEl.textContent = s; },
  });
  _pendingSession = session;

  // QR-fallback path: encode our pubkey alongside the room id so a
  // cross-network phone can establish trust without going through the
  // request/accept lobby (which only works on the same wifi).
  const myPubkey = _myPubkey || await getMyPubkeyB64();
  const url = new URL("phone.html", window.location.href);
  url.hash = `pair=${session.roomId}&pk=${myPubkey}`;
  const urlText = url.toString();

  if (window.qrcode) {
    const qr = window.qrcode(0, "L");
    qr.addData(urlText);
    qr.make();
    qrEl.innerHTML = qr.createSvgTag({ margin: 2, scalable: true });
  } else {
    qrEl.textContent = "(QR library not loaded)";
  }
  urlEl.textContent = urlText;
  urlEl.title = `${urlText}\n\nClick to copy`;
  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(urlText);
      const orig = urlEl.textContent;
      urlEl.textContent = "Copied!";
      setTimeout(() => { if (urlEl.textContent === "Copied!") urlEl.textContent = orig; }, 1200);
    } catch {}
  };
  urlEl.onclick = copyUrl;
  urlEl.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copyUrl(); }
  };
  statusEl.textContent = "Waiting for phone…";
  statusEl.classList.add("is-waiting");

  try {
    const peer = await session.waitForPeer();
    if (_pendingSession !== session) { peer.close(); return; }  // user cancelled
    _registerPairedPhone(session.roomId, peer, "Phone");
    _pendingSession = null;
    statusEl.classList.remove("is-waiting");
    if (dialog.open) {
      statusEl.textContent = "Connected";
      setTimeout(() => { if (dialog.open) dialog.close(); }, 800);
    }
    // Dialog already dismissed: phone shows up in the helpers list — no
    // popup; the operator chose to dismiss the UI, surfacing it now would
    // surprise them.
  } catch (err) {
    if (_pendingSession === session) {
      try { getLobby().remove("better-robotics-pair:" + session.roomId); } catch {}
      _pendingSession = null;
      statusEl.classList.remove("is-waiting");
      if (dialog.open) {
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
      }
    }
  }
}

async function onPhoneMessage(id, peer, msg) {
  if (msg.type === "subscribe-source") {
    // Phone picked a different camera source for a given robot. Record
    // the preference and re-sync media so the new track lands. Cleared
    // on disconnect (robotSourcePrefs lives on the phone object only).
    const phone = _phones.get(id);
    if (!phone) return;
    if (!phone.robotSourcePrefs) phone.robotSourcePrefs = new Map();
    if (msg.sourceId) phone.robotSourcePrefs.set(msg.robotId, msg.sourceId);
    else phone.robotSourcePrefs.delete(msg.robotId);
    const entry = state.devices.get(msg.robotId);
    if (entry) syncRobotMedia(phone, entry);
    return;
  }
  if (msg.type === "ask-reply") {
    const pending = _pendingAsks.get(msg.askId);
    if (!pending) return;  // late reply after timeout — drop silently
    clearTimeout(pending.timeout);
    _pendingAsks.delete(msg.askId);
    pending.resolve({ answer: msg.answer ?? null, timed_out: false });
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
  if (msg.type === "robot-command") {
    const reqId = msg.id;
    const reply = (body) => { try { peer.send({ type: "robot-command-result", id: reqId, ...body }); } catch {} };
    try {
      const result = await dispatchRobotCommand(msg.capability, msg.args || {});
      reply(result);
    } catch (err) {
      reply({ ok: false, error: String(err.message || err) });
    }
    return;
  }
}

// Phone-issued commands relayed over WebRTC. Whitelist here is the trust
// boundary — the phone is already authenticated by the pair ceremony, but
// we still refuse anything not explicitly enumerated so a malformed message
// can't reach the BLE ops channel.
//
// Target selection: most-recently-connected robot with the required
// characteristic. `lastConnectedAt` is a plain timestamp, so the newer
// session wins when multiple robots are paired.
async function dispatchRobotCommand(capability, args) {
  const cap = String(capability || "");
  if (cap === "stop") {
    const target = pickMotorsTargetMostRecent();
    if (!target) return { ok: false, error: "no robot connected" };
    try {
      await sendPairById(target.id, "motors", 0, 0);
      return { ok: true, data: { robot: target.name, applied: { l: 0, r: 0 } } };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }
  return { ok: false, error: "unknown capability" };
}

function pickMotorsTargetMostRecent() {
  let best = null;
  for (const e of state.devices.values()) {
    if (e.status !== "connected" || !e.motorsChar) continue;
    if (!best || (e.lastConnectedAt || 0) > (best.lastConnectedAt || 0)) best = e;
  }
  return best;
}

function sendTargetInfo(peer) {
  const target = pickMotorsTarget();
  peer.send({
    type: "target-info",
    target: target ? { id: target.id, name: target.name } : null,
  });
}

// Re-broadcast to all paired phones when a robot connects/disconnects on the
// desktop. Without this, a phone that paired BEFORE any robot was connected
// stayed wedged with target=null (joypad + panic-stop hidden) because the
// only target-info send was at pair time.
export function broadcastTargetInfo() {
  for (const p of _phones.values()) {
    if (p.status === "failed") continue;
    try { sendTargetInfo(p.peer); } catch {}
  }
}

function renderPhones() {
  _changeHandler?.();
}
