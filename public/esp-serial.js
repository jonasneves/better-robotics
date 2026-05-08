// ESP32 serial monitor — same shape as recovery.js (Pi USB-CDC) so both
// Console modes share xterm.js + Web Serial. We used to mount <ewt-console>
// here, but that element is registered only as a side-effect of clicking
// esp-web-tools' Flash button (it lives inside a content-hashed install-
// dialog chunk that install-button.js lazy-imports). Until then it's an
// HTMLUnknownElement: setting `port` is a no-op, nothing pumps, terminal
// stays blank. The xterm path has no such ordering trap.
import { $ } from "./dom.js";
import { log } from "./log.js";

let _wired = false;
let _port = null;
let _reader = null;
let _writer = null;
let _readPump = null;
let _term = null;
let _fit = null;
let _resizeObs = null;
let _xtermModule = null;

// state: "" (idle/disconnected) | "connected" | "connecting" | "error".
// Drives the dot color; text only renders for non-default detail messages.
function setStatus(state, text = "") {
  const dot = $("esp-serial-status-dot");
  const el = $("esp-serial-status");
  if (dot) dot.className = `dot${state ? ` ${state}` : ""}`;
  if (el) el.textContent = text;
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
// /dev/cu.usbserial node; and a SerialPort that came back already-open
// from a prior tab/page session needs an explicit close() before retry.
//
// Then deassert DTR/RTS immediately. ESP32-CAM (and most ESP32 dev boards)
// wire DTR/RTS through transistors to EN + GPIO0 — Chrome's default
// asserted state on open() pulses those, which resets the chip and kills
// any active BLE session. Setting both low keeps the chip running.
async function openWithRetry(port) {
  try { await port.open({ baudRate: 115200 }); }
  catch (err) {
    if (err.name === "InvalidStateError") {
      try { await port.close(); } catch {}
    }
    await new Promise((r) => setTimeout(r, 200));
    await port.open({ baudRate: 115200 });
  }
  try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {}
}

async function connect() {
  if (_port) return;
  if (!("serial" in navigator)) {
    setStatus("error", "unsupported browser");
    log("Web Serial not supported — use Chrome or Edge on desktop");
    return;
  }
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

  const { Terminal, FitAddon } = await ensureXtermLoaded();
  const container = $("esp-serial-console-host");
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
  // Defer fit one frame so the dialog's open-animation layout has resolved
  // (same FitAddon early-measure trap as recovery.js — see comment there).
  await new Promise(r => requestAnimationFrame(r));
  try { _fit.fit(); } catch {}
  _resizeObs = new ResizeObserver(() => {
    const r = container.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    try { _fit?.fit(); } catch {}
  });
  _resizeObs.observe(container);
  _term.focus();

  _term.onData(async (data) => {
    if (!_writer) return;
    try { await _writer.write(new TextEncoder().encode(data)); }
    catch (err) { _term?.writeln(`\r\n[write error: ${err.message}]`); }
  });

  _writer = _port.writable.getWriter();
  _reader = _port.readable.getReader();
  _readPump = (async () => {
    try {
      while (true) {
        const { value, done } = await _reader.read();
        if (done) break;
        if (value) _term?.write(value);
      }
    } catch (err) {
      _term?.writeln(`\r\n[read error: ${err.message}]`);
    }
  })();

  $("esp-serial-connect").textContent = "Disconnect";
  setStatus("connected");
}

async function disconnect() {
  // Release order matters — same dance recovery.js does. Reader.cancel()
  // resolves before the in-flight read() promise settles, so releaseLock()
  // must wait for the read pump to actually exit, otherwise port.close()
  // rejects with "stream is locked" and the port stays in an "open" limbo
  // that blocks a subsequent flash attempt with InvalidStateError.
  try { await _reader?.cancel(); } catch {}
  try { await _readPump; } catch {}
  try { _reader?.releaseLock(); } catch {}
  try { _writer?.releaseLock(); } catch {}
  if (_port) {
    try { await _port.close(); }
    catch {
      await new Promise((r) => setTimeout(r, 500));
      try { await _port.close(); } catch {}
    }
  }
  await new Promise((r) => setTimeout(r, 100));
  _reader = _writer = _readPump = _port = null;
  _resizeObs?.disconnect();
  _resizeObs = null;
  _fit?.dispose();
  _fit = null;
  _term?.dispose();
  _term = null;
  $("esp-serial-console-host").innerHTML = "";
  $("esp-serial-connect").textContent = "Connect";
  setStatus("");
}

// Same purpose as recovery.releasePort — see comment there.
export async function releasePort() { if (_port) await disconnect(); }

export function init() {
  if (_wired) return;
  _wired = true;
  $("console-close").addEventListener("click", () => $("console-modal").close());
  $("esp-serial-connect").addEventListener("click", () => _port ? disconnect() : connect());
  // Auto-disconnect when the dialog closes — leaving the port open across
  // dialog hides would block other tools (Flash button) from reusing it.
  $("console-modal").addEventListener("close", () => { if (_port) disconnect(); });
}
