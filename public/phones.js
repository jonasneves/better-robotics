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

const _phones = new Map();  // roomId → { id, label, peer, connectedAt }
let _chatHandler = null;
let _pendingSession = null;

export function setPhoneChatHandler(fn) { _chatHandler = fn; }

export function listPhones() {
  return [..._phones.values()].map(p => ({
    id: p.id, label: p.label, connectedAt: p.connectedAt,
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

export function initPhones() {
  const pairBtn = $("pair-phone-btn");
  if (pairBtn) pairBtn.addEventListener("click", beginPairing);
  const closeBtn = $("pair-dialog-close");
  if (closeBtn) closeBtn.addEventListener("click", closePairing);
  const cancelBtn = $("pair-cancel-btn");
  if (cancelBtn) cancelBtn.addEventListener("click", closePairing);
}

function closePairing() {
  _pendingSession?.cancel();
  _pendingSession = null;
  $("pair-dialog").close();
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

  try {
    const peer = await session.waitForPeer();
    if (_pendingSession !== session) { peer.close(); return; }  // user cancelled
    const id = session.roomId;
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
      _phones.delete(id);
      log("phone disconnected", "phone");
      renderPhones();
    });
    // Tell the phone what it's driving (if anything). Sent once on connect —
    // phones.js doesn't watch state.devices for changes, so if the target
    // robot disconnects the phone will keep showing the old name until it
    // sends a drive message that fails silently. Acceptable for v1.
    sendTargetInfo(peer);
    renderPhones();
    _pendingSession = null;
    // Let the user see the "Connected" text briefly before the dialog closes.
    setTimeout(() => { if (dialog.open) dialog.close(); }, 800);
  } catch (err) {
    if (_pendingSession === session) {
      statusEl.textContent = `Pairing failed: ${err.message || err}`;
      _pendingSession = null;
    }
  }
}

async function onPhoneMessage(id, peer, msg) {
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
  const heading = $("phones-heading");
  const list = $("phones-list");
  if (!list || !heading) return;
  if (_phones.size === 0) {
    heading.hidden = true;
    list.innerHTML = "";
    return;
  }
  heading.hidden = false;
  list.innerHTML = [..._phones.values()].map(p => {
    const dotClass = p.status === "connected" ? "connected"
      : p.status === "reconnecting" ? "connecting"
      : "error";
    const statusLine = p.status === "connected"
      ? `Chat + joypad · ${escapeHtml(p.id.slice(0, 8))}…`
      : p.status === "reconnecting"
        ? `Reconnecting… · ${escapeHtml(p.statusDetail || "")}`
        : `Offline · ${escapeHtml(p.statusDetail || "")}`;
    return `
      <section class="card phone-tile">
        <div class="row">
          <div class="robot-identity">
            <div class="label">
              <span class="dot ${dotClass}"></span>
              ${escapeHtml(p.label)}
              <span class="type-badge">PHONE</span>
            </div>
            <div class="status">${statusLine}</div>
          </div>
        </div>
      </section>
    `;
  }).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
