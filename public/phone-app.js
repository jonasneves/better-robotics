import { $ } from "./dom.js";
import { joinPairingRoom } from "./pairing.js";

let _peer = null;
let _pending = false;

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

function onPeerMessage(msg) {
  if (msg.type === "chat-reply") {
    setMessage(msg.text || "(no response)");
    _pending = false;
    $("phone-input").disabled = false;
    $("phone-input").focus();
  } else if (msg.type === "notice") {
    // Pip-initiated message (tool: send_to_phone) — desktop pushing to us.
    setEcho("");
    setMessage(msg.text || "");
  }
}

async function init() {
  const match = location.hash.match(/^#pair=(.+)$/);
  if (!match) {
    setStatus("error", "No pairing code");
    setMessage("This page needs a pairing code. Open the dashboard on your desktop and tap “Pair phone” to generate one.");
    return;
  }
  const roomId = match[1];
  try {
    setStatus("connecting", "Connecting…");
    _peer = await joinPairingRoom(roomId);
    setStatus("connected", "Connected");
    setMessage("Hi — I'm Pip, running on your desktop. Ask me something.");
    _peer.onMessage(onPeerMessage);
    _peer.onClose(() => {
      setStatus("error", "Disconnected");
      setMessage("Connection lost. Re-open the pair QR on the desktop to reconnect.");
      $("phone-input").disabled = true;
    });
    $("phone-form").addEventListener("submit", handleSubmit);
    $("phone-input").disabled = false;
    $("phone-input").focus();
  } catch (err) {
    setStatus("error", "Failed");
    setMessage(`Couldn't pair: ${err.message || err}`);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
