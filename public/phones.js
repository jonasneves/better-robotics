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
  const codeEl = $("pair-code");
  const urlEl = $("pair-url");
  qrEl.innerHTML = "";
  codeEl.textContent = "";
  urlEl.textContent = "";
  statusEl.textContent = "Generating room…";
  dialog.showModal();

  const session = hostPairingRoom();
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
  codeEl.textContent = session.roomId;
  urlEl.textContent = urlText;
  statusEl.textContent = "Waiting for phone…";

  try {
    const peer = await session.waitForPeer();
    if (_pendingSession !== session) { peer.close(); return; }  // user cancelled
    const id = session.roomId;
    _phones.set(id, { id, label: "Phone", peer, connectedAt: Date.now() });
    statusEl.textContent = "Connected";
    log("phone paired", "phone");

    peer.onMessage((msg) => onPhoneMessage(id, peer, msg));
    peer.onClose(() => {
      _phones.delete(id);
      log("phone disconnected", "phone");
      renderPhones();
    });
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
  if (msg.type !== "chat") return;
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
  list.innerHTML = [..._phones.values()].map(p => `
    <section class="card phone-tile">
      <div class="row">
        <div class="robot-identity">
          <div class="label">
            <span class="dot connected"></span>
            ${escapeHtml(p.label)}
            <span class="type-badge">PHONE</span>
          </div>
          <div class="status">Chat only · ${escapeHtml(p.id.slice(0, 8))}…</div>
        </div>
      </div>
    </section>
  `).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
