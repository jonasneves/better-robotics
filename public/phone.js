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

// Pip asked a question — show the modal, wait for the user to tap an option
// (or Skip / timeout at the other end). Only one ask at a time on screen;
// if a second arrives while the first is open, the new one replaces it and
// the prior ask resolves as skipped server-side when its timer fires.
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

function onPeerMessage(msg) {
  if (msg.type === "ask") { showAsk(msg); return; }
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
    // Route pair stages through setMessage so the user sees where we're
    // stuck if something stalls — "offer sent, waiting for desktop…" tells
    // them way more than a forever-spinning "Connecting…".
    _peer = await joinPairingRoom(roomId, {
      onStatus: (s) => setMessage(s),
    });
    setStatus("connected", "Connected");
    setMessage("Hi — I'm Pip, running on your desktop. Ask me something.");
    _peer.onMessage(onPeerMessage);
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
