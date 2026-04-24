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
import { state } from "./state.js";
import { getLaptopStream, onLaptopChange, setPhoneStream } from "./helpers.js";
import { discover } from "./discover.js";
import { getMyPubkeyB64 } from "./peer-key.js";
import { makeTrustStore } from "./trust.js";
import { pairRequestClient } from "./pair-request.js";
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

export async function initPhones() {
  const pairBtn = $("pair-phone-btn");
  if (pairBtn) pairBtn.addEventListener("click", beginPairing);
  const closeBtn = $("pair-dialog-close");
  if (closeBtn) closeBtn.addEventListener("click", closePairing);
  const cancelBtn = $("pair-cancel-btn");
  if (cancelBtn) cancelBtn.addEventListener("click", closePairing);
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

  // Laptop camera → phone(s) bridge: whenever the laptop transitions, sync
  // every paired phone's media tracks. Phones connected later pick up the
  // live stream in onPhonePaired.
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

// Passive presence — just a count badge in the helpers heading so the
// user knows discovery is healthy. The pair flow itself is now driven
// by phones sending requests, not by us deciding ahead of time.
function renderPhonePresence(ads) {
  const phones = (ads || []).filter(a => a.data && a.data.app === "better-robotics-phone");
  const total = phones.length;
  const badge = $("phone-presence");
  if (!badge) return;
  if (total === 0) { badge.hidden = true; return; }
  badge.hidden = false;
  badge.classList.remove("alert");
  badge.textContent = total === 1
    ? `${phones[0].data.label || "Phone"} on wifi`
    : `${total} phones on wifi`;
}

// ── Incoming pair-requests ────────────────────────────────────────
//
// Protocol lives in signal/client/pair-request.js now — we supply
// the match rule (ads targeted at our pubkey), the trust lookup,
// and the UI (existing modal in this file). The library owns
// nonce-dedup, subscribe filter, response publish, and timeout.
let _pairClient = null;
function _initPairListener() {
  if (_pairClient) return;
  _pairClient = pairRequestClient({ app: 'better-robotics-pair', sign: true, lobby: getLobby() });
  _pairClient.onRequest(async (req) => {
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
  }, {
    // Pubkey-target match — attackers on the same wifi can publish to
    // any address, but only ads addressed to our key fire the prompt.
    match: (ad) => ad.data.target === _myPubkey,
    // Route library-level handler errors into the in-app debug log
    // so hostPairingRoom failures (etc.) stay diagnosable from the
    // floating panel instead of only the browser console.
    onError: (err) => log("pair-request handler: " + (err && err.message || err), "phone"),
  });
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
  // Push the laptop's current camera stream if there is one so the
  // newly-connected phone can immediately use it as a helper.
  const stream = getLaptopStream();
  if (stream) syncPhoneMedia(_phones.get(id), stream);
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
  statusEl.textContent = "Waiting for phone…";

  try {
    const peer = await session.waitForPeer();
    if (_pendingSession !== session) { peer.close(); return; }  // user cancelled
    statusEl.textContent = "Connected";
    _registerPairedPhone(session.roomId, peer, "Phone");
    _pendingSession = null;
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

function renderPhones() {
  _changeHandler?.();
}
