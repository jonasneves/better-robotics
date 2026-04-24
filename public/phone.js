import { $ } from "./dom.js";
import { joinPairingRoom } from "./pairing.js";
import { attachJoypad } from "./joypad.js";
import { discover } from "./discover.js";

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

// LAN discovery — desktops with an open Pair dialog on the same wifi
// broadcast a pair room. Render each as a one-tap join button so the
// reconnect surface offers "skip the QR" before the camera scan.
//
// We also PUBLISH a "phone-ready" ad while we're in this state so
// dashboards on the same wifi can surface "iPhone on wifi" without the
// user having to open a pair dialog first. Symmetric presence: each side
// knows the other is around without anyone clicking anything.
let _lobby = null;
function deviceLabel() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  return "Phone";
}
function startNearbyDiscovery() {
  if (_lobby) return;  // idempotent — init might call us twice across reconnects
  _lobby = discover();
  const wrap = $("phone-nearby");
  const list = $("phone-nearby-list");

  // Publish "I'm a phone, ready to pair." Random per page-load is fine —
  // server TTL clears stale ads from prior tabs/reloads. Dashboards on
  // the same wifi pick this up and show a passive presence indicator.
  const phoneAdId = "better-robotics-phone-ready:" + (crypto.randomUUID?.() || Math.random().toString(36).slice(2));
  _lobby.publish(phoneAdId, {
    app: "better-robotics-phone-ready",
    label: deviceLabel(),
  }, 60000);

  if (!wrap || !list) return;
  _lobby.onChange((ads) => {
    const desktops = ads.filter(a => a.data && a.data.app === "better-robotics-pair" && a.data.roomId);
    list.innerHTML = "";
    if (!desktops.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    for (const ad of desktops) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "phone-nearby-btn";
      btn.textContent = `Pair with ${ad.data.label || "this computer"}`;
      btn.addEventListener("click", () => {
        // Same code path as scanning the QR: navigate to the same URL the
        // QR encodes. location.replace avoids a back-button trap.
        location.replace(location.pathname + "#pair=" + ad.data.roomId);
        location.reload();
      });
      list.appendChild(btn);
    }
  });
}

async function init() {
  wireReconnect();
  const match = location.hash.match(/^#pair=(.+)$/);
  if (!match) {
    setStatus("error", "Not paired");
    setMessage("Tap “Scan QR to connect” below, or open the dashboard on your desktop and tap “Pair phone” to generate a code.");
    showReconnect("No pairing code yet.");
    startNearbyDiscovery();
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
    hideReconnect();
    _peer.onMessage(onPeerMessage);
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
      showReconnect("Lost the desktop. Scan a fresh QR to reconnect.");
      startNearbyDiscovery();
    });
    $("phone-form").addEventListener("submit", handleSubmit);
    $("phone-input").disabled = false;
    $("phone-input").focus();
    wireJoypad();
    wireBackgroundStop();
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
