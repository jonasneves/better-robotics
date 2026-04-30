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

// state: "" (idle/disconnected) | "connected" | "connecting" | "error".
// Drives the dot color; text only renders for non-default detail messages.
function setStatus(state, text = "") {
  const dot = $("esp-serial-status-dot");
  const el = $("esp-serial-status");
  if (dot) dot.className = `dot${state ? ` ${state}` : ""}`;
  if (el) el.textContent = text;
}

// Last-used port hint persisted as VID:PID. SerialPort objects themselves
// can't be stored, but Chrome's getPorts() returns the granted set on the
// next visit, so we just need to identify which one to prefer when more
// than one is granted (e.g. ESP32 + Pi both connected at different times).
const LAST_PORT_KEY = "esp-serial-last-port";
function rememberPort(port) {
  try {
    const i = port.getInfo();
    if (i.usbVendorId && i.usbProductId) {
      localStorage.setItem(LAST_PORT_KEY, `${i.usbVendorId}:${i.usbProductId}`);
    }
  } catch {}
}
function pickKnown(ports) {
  if (ports.length <= 1) return ports[0] || null;
  let last = "";
  try { last = localStorage.getItem(LAST_PORT_KEY) || ""; } catch {}
  if (last) {
    for (const p of ports) {
      try {
        const i = p.getInfo();
        if (`${i.usbVendorId}:${i.usbProductId}` === last) return p;
      } catch {}
    }
  }
  return ports[0];
}
// Two-attempt open: macOS occasionally fails the first open() right after
// a previous disconnect because the kernel hasn't fully released the
// /dev/cu.usbserial node. A 200ms retry covers that without a user-visible
// glitch (the previous symptom was "reconnect 2-3 times until it works").
async function openWithRetry(port) {
  try { await port.open({ baudRate: 115200 }); }
  catch (err) {
    await new Promise((r) => setTimeout(r, 200));
    await port.open({ baudRate: 115200 });
  }
}

async function connect() {
  if (_port) return;
  // Skip the picker when we already have permission for a port. Chrome
  // persists the grant across dialog opens AND page reloads (per origin).
  // When more than one port is granted, prefer the one matching the
  // last-used VID:PID instead of prompting — typical case is the same
  // chip on the same machine, and the picker noise was the #1 friction.
  let known = [];
  try { known = await navigator.serial.getPorts(); } catch {}
  if (known.length >= 1) {
    _port = pickKnown(known);
    setStatus("connecting", "opening…");
  } else {
    setStatus("connecting", "requesting port…");
    try {
      _port = await navigator.serial.requestPort();
    } catch (err) {
      if (err.name !== "NotFoundError") setStatus("error", `pick cancelled: ${err.message}`);
      else setStatus("");
      return;
    }
  }
  try {
    await openWithRetry(_port);
  } catch (err) {
    setStatus("error", `open failed: ${err.message}`);
    _port = null;
    return;
  }
  rememberPort(_port);
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
  // Ordering matters: remove the element FIRST so ewt-console's
  // disconnectedCallback cancels its reader and releases the lock on
  // port.readable. THEN close the port. If we close first (or in parallel),
  // close() rejects or hangs because the reader still holds the lock, and
  // the port ends up in an "open" limbo — the install-dialog's later
  // port.open() then throws InvalidStateError ("port is already open").
  if (_consoleEl) {
    try { _consoleEl.remove(); } catch {}
    _consoleEl = null;
    // disconnectedCallback runs synchronously on removal, but reader
    // cancellation is async. Give the microtask queue a beat to drain.
    await new Promise((r) => setTimeout(r, 50));
  }
  if (_port) {
    // Two-attempt close: if the first throws (reader still locked, rare),
    // wait a bit longer and retry. If the second still fails, give up —
    // state is wedged but better than hanging forever. Won't clobber
    // future flash attempts because we still null out _port.
    try { await _port.close(); }
    catch {
      await new Promise((r) => setTimeout(r, 500));
      try { await _port.close(); } catch {}
    }
    _port = null;
  }
  $("esp-serial-console-host").innerHTML = "";
  $("esp-serial-connect").textContent = "Connect";
  setStatus("");
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
