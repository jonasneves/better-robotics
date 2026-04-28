// Browser-resident terminal into a Pi over a WebRTC DataChannel.
//
// Architecture: dashboard opens a `shell` DataChannel to the Pi via
// webrtc-robot.js. The Pi's libpeer-based pi-robot-rtc daemon spawns a PTY
// running `bash -i` and bridges its stdin/stdout to the channel. xterm.js
// renders the byte stream; user keystrokes flow back through channel.send().
//
// Auth model: the WebRTC peer-trust IS the auth boundary. Today this is
// "if you can reach <robot>.local:82/webrtc/offer, you're trusted" — same
// LAN trust the dashboard already extends for OTA over PNA. SSH-over-
// DataChannel can be layered on top later if the trust model needs upgrade
// (run ssh2 in a WebContainer, hand it a Duplex over the channel).

import { $ } from "./dom.js";
import { state } from "./state.js";
import { log } from "./log.js";
import { openChannel, closePeer } from "./webrtc-robot.js";

let _wired = false;
let _activeRobotId = null;
let _channel = null;
let _term = null;
let _fit = null;
let _resizeObs = null;
let _xtermModule = null;

// state: "" (idle) | "connecting" | "connected" | "error". Same shape
// as recovery.js / esp-serial.js — keeps the patterns parallel.
function setStatus(s, text = "") {
  $("shell-status-dot").className = `dot${s ? ` ${s}` : ""}`;
  $("shell-status").textContent = text;
}

async function ensureXtermLoaded() {
  if (_xtermModule) return _xtermModule;
  if (!document.querySelector('link[data-xterm-css]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.css";
    link.dataset.xtermCss = "1";
    document.head.appendChild(link);
  }
  const [core, fit] = await Promise.all([
    import("https://cdn.jsdelivr.net/npm/@xterm/xterm@5/+esm"),
    import("https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10/+esm"),
  ]);
  _xtermModule = { Terminal: core.Terminal, FitAddon: fit.FitAddon };
  return _xtermModule;
}

async function connect() {
  const id = _activeRobotId;
  if (!id) return;
  const entry = state.devices.get(id);
  if (!entry) return;
  setStatus("connecting", "Negotiating peer connection…");
  try {
    _channel = await openChannel(id, entry.name, "shell", {
      onStatus: (s) => setStatus("connecting", s),
    });
  } catch (err) {
    setStatus("error", `Couldn't reach pi-robot-rtc: ${err.message || err}`);
    log(`shell: ${err.message || err}`);
    return;
  }
  setStatus("connected");
  $("shell-connect").textContent = "Disconnect";

  const { Terminal, FitAddon } = await ensureXtermLoaded();
  const container = $("shell-term");
  container.innerHTML = "";
  _term = new Terminal({
    fontSize: 13,
    fontFamily: '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace',
    cursorBlink: true,
    convertEol: false,
    theme: { background: "#1e1e1e", foreground: "#e4e4e4", cursor: "#e4e4e4" },
  });
  _fit = new FitAddon();
  _term.loadAddon(_fit);
  _term.open(container);
  // Same raf-deferred fit dance as recovery.js — pre-fit measures a mid-
  // animation container and picks too few rows.
  await new Promise(r => requestAnimationFrame(r));
  try { _fit.fit(); } catch {}
  _resizeObs = new ResizeObserver(() => {
    const r = container.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    try { _fit?.fit(); } catch {}
  });
  _resizeObs.observe(container);
  _term.focus();
  _term.write("\x1b[2J\x1b[H");

  // Channel binary-mode for raw PTY bytes; xterm.js can write Uint8Array
  // directly. Prefer ArrayBuffer for fewer allocs on hot path.
  _channel.binaryType = "arraybuffer";
  _channel.addEventListener("message", (e) => {
    if (typeof e.data === "string") _term?.write(e.data);
    else _term?.write(new Uint8Array(e.data));
  });
  _channel.addEventListener("close", () => {
    _term?.writeln("\r\n[channel closed]");
    setStatus("error", "Disconnected");
    $("shell-connect").textContent = "Connect";
  });
  // Keystrokes → bytes over the channel. Encoder reused per onData call;
  // hot path on terminal input.
  const enc = new TextEncoder();
  _term.onData((data) => {
    if (_channel?.readyState !== "open") return;
    try { _channel.send(enc.encode(data)); }
    catch (err) { _term?.writeln(`\r\n[send error: ${err.message}]`); }
  });
}

function disconnect() {
  try { _channel?.close(); } catch {}
  _channel = null;
  _resizeObs?.disconnect();
  _resizeObs = null;
  _fit?.dispose();
  _fit = null;
  _term?.dispose();
  _term = null;
  if (_activeRobotId) closePeer(_activeRobotId);
  setStatus("");
  $("shell-connect").textContent = "Connect";
}

function initOnce() {
  if (_wired) return;
  _wired = true;
  $("shell-close").addEventListener("click", () => $("shell-modal").close());
  $("shell-connect").addEventListener("click", () => _channel ? disconnect() : connect());
  $("shell-modal").addEventListener("close", () => { if (_channel) disconnect(); });
}

export function openShellDialog(robotId) {
  initOnce();
  _activeRobotId = robotId;
  const entry = state.devices.get(robotId);
  $("shell-subtitle").textContent = entry ? ` · ${entry.name}` : "";
  setStatus("");
  $("shell-modal").showModal();
}
