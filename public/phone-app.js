import { $ } from "./dom.js";
import { joinPairingRoom } from "./pairing.js";
import { attachJoypad } from "./joypad.js";

let _peer = null;
let _pending = false;
let _joypad = null;

function setStatus(state, text) {
  const dot = $("phone-status-dot");
  dot.className = `dot${state ? ` ${state}` : ""}`;
  $("phone-status-text").textContent = text;
}

function transportLabel(transport) {
  if (transport === "p2p") return "Connected · P2P";
  if (transport === "relay") return "Connected · relay";
  return "Disconnected";
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
  } else if (msg.type === "target-info") {
    // Desktop tells us which robot the joypad will drive. If null, hide the
    // drive surface so we don't look like we're controlling something.
    const driveSection = $("phone-drive");
    const targetEl = $("phone-drive-target");
    if (msg.target?.name) {
      driveSection.hidden = false;
      targetEl.textContent = `Driving: ${msg.target.name}`;
    } else {
      driveSection.hidden = true;
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

// Phone backgrounded (tab switch, screen lock, app switcher): emit a stop so
// the robot doesn't keep driving while the user can't see it.
function wireBackgroundStop() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      _joypad?.reset();
      _peer?.send({ type: "drive", l: 0, r: 0 });
    }
  });
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
    _peer = await joinPairingRoom(roomId, {
      onStatus: (s) => { $("phone-status-text").textContent = s; },
    });
    setStatus("connected", transportLabel(_peer.transport));
    setMessage("Hi — I'm Pip, running on your desktop. Ask me something.");
    _peer.onMessage(onPeerMessage);
    _peer.onTransportChange((t) => {
      // P2P → relay shift is usually transient; only flag as "error" when
      // everything's actually down. Relay mode still works end-to-end, just
      // higher latency for drive commands.
      setStatus(t === "closed" ? "error" : "connected", transportLabel(t));
    });
    _peer.onClose(() => {
      setStatus("error", "Disconnected");
      setMessage("Connection lost. Re-open the pair QR on the desktop to reconnect.");
      $("phone-input").disabled = true;
    });
    $("phone-form").addEventListener("submit", handleSubmit);
    $("phone-input").disabled = false;
    $("phone-input").focus();
    wireJoypad();
    wireBackgroundStop();
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
