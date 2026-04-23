// ESP32 serial monitor — companion to recovery.js (Pi). Different tool because
// ESP32 firmware is line-buffered Serial.println output, not a TTY: ewt-console
// (a log box with optional input) is the right granularity, not xterm. We
// already load esp-web-tools@10 for the Flash button (index.html), so the
// <ewt-console> element is in the bundle for free. See README architecture
// note + the architectural reflection where this got picked.
import { $ } from "./dom.js";

let _wired = false;
let _port = null;
let _consoleEl = null;

function setStatus(msg) {
  const el = $("esp-serial-status");
  if (el) el.textContent = msg;
}

async function connect() {
  if (_port) return;
  setStatus("requesting port…");
  try {
    _port = await navigator.serial.requestPort();
  } catch (err) {
    if (err.name !== "NotFoundError") setStatus(`pick cancelled: ${err.message}`);
    else setStatus("disconnected");
    return;
  }
  // Open the port BEFORE handing it to <ewt-console>. ewt-console assumes the
  // port is already open and starts reading immediately on insert; without
  // open() it just shows the empty pane (the dialog reads "connected" but
  // nothing streams). 115200 8N1 matches the Arduino default Serial.begin.
  try {
    await _port.open({ baudRate: 115200 });
  } catch (err) {
    setStatus(`open failed: ${err.message}`);
    _port = null;
    return;
  }
  // Create <ewt-console> fresh with port set BEFORE the element is inserted
  // into the DOM — its connectedCallback runs the moment we appendChild and
  // assumes a port exists. Static-HTML insertion crashes ewt internally.
  _consoleEl = document.createElement("ewt-console");
  _consoleEl.port = _port;
  _consoleEl.setAttribute("allow-input", "");
  const host = $("esp-serial-console-host");
  host.innerHTML = "";
  host.appendChild(_consoleEl);
  $("esp-serial-connect").textContent = "Disconnect";
  setStatus("connected");
}

async function disconnect() {
  if (_consoleEl) {
    // Removing the element fires disconnectedCallback in ewt-console, which
    // closes the underlying port. Belt-and-braces: try the port.close too.
    try { _consoleEl.remove(); } catch {}
    _consoleEl = null;
  }
  if (_port) { try { await _port.close(); } catch {} _port = null; }
  $("esp-serial-console-host").innerHTML = "";
  $("esp-serial-connect").textContent = "Connect";
  setStatus("disconnected");
}

export function init() {
  if (_wired) return;
  _wired = true;
  $("esp-serial-close").addEventListener("click", () => $("esp-serial-modal").close());
  $("esp-serial-connect").addEventListener("click", () => _port ? disconnect() : connect());
  // Auto-disconnect when the dialog closes — leaving the port open across
  // dialog hides would block other tools (Flash button) from reusing it.
  $("esp-serial-modal").addEventListener("close", () => { if (_port) disconnect(); });
}

export function openESPSerialDialog() {
  $("esp-serial-modal").showModal();
}
