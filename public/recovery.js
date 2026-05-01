// Works even when BLE is dead: the USB gadget runs under its own systemd unit
// (usb-gadget.service) independently of pi-robot. xterm.js is dynamic-imported
// on first Connect so the ~250KB library only downloads when actually used.
import { $ } from "./dom.js";
import { log } from "./log.js";

let _port = null;
let _reader = null;
let _writer = null;
let _readPump = null;
let _term = null;
let _fit = null;
let _resizeObs = null;
let _xtermModule = null;

// state: "" (idle/disconnected) | "connected" | "error" — drives the dot color.
// text is shown alongside only when it carries info beyond the dot
// (e.g. error detail). Default/connected states render dot-only.
function setStatus(state, text = "") {
  $("recovery-status-dot").className = `dot${state ? ` ${state}` : ""}`;
  $("recovery-status").textContent = text;
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

// Last-used port hint persisted as VID:PID — same purpose and shape as
// esp-serial.js (kept inlined rather than shared to avoid a new module
// for ~15 lines that don't otherwise leak between the two consoles).
const LAST_PORT_KEY = "recovery-last-port";
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

async function connect() {
  if (!("serial" in navigator)) {
    log("Web Serial not supported — use Chrome or Edge on desktop");
    setStatus("error", "unsupported browser");
    return;
  }
  // Skip the picker when permission is already granted for at least one
  // port (Chrome persists across page reloads). Pick the last-used VID:PID
  // when multiple are granted, falling back to the first.
  let known = [];
  try { known = await navigator.serial.getPorts(); } catch {}
  try {
    _port = known.length >= 1 ? pickKnown(known) : await navigator.serial.requestPort();
    // Two-attempt open: macOS sometimes fails the first open() right
    // after a prior disconnect (kernel /dev/cu.* not fully released);
    // and a SerialPort that came back already-open from a prior tab/page
    // session needs an explicit close() before the retry will take.
    try { await _port.open({ baudRate: 115200 }); }
    catch (err) {
      if (err.name === "InvalidStateError") {
        try { await _port.close(); } catch {}
      }
      await new Promise((r) => setTimeout(r, 200));
      await _port.open({ baudRate: 115200 });
    }
    // Deassert DTR/RTS — harmless for Pi USB-CDC, critical when the
    // user accidentally points this at an ESP32 (DTR/RTS map to EN/GPIO0
    // on most ESP32 boards; default asserted state would reset it and
    // kill an active BLE session).
    try { await _port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {}
    rememberPort(_port);
  } catch (err) {
    if (err.name !== "NotFoundError") log(`Recovery connect error: ${err.message}`);
    setStatus("");
    return;
  }
  setStatus("connected");  // dot-only; no text
  $("recovery-connect").textContent = "Disconnect";

  const { Terminal, FitAddon } = await ensureXtermLoaded();
  const container = $("recovery-term");
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
  // Defer fit one frame so the dialog's open-animation layout has resolved.
  // Without this, FitAddon measures a mid-transition container and picks too
  // few rows; when the container later reaches full size, xterm pads by
  // inserting rows at the TOP of the main buffer, which shoves all previous
  // content (getty banner, login prompt) to the bottom of the viewport —
  // that's the "cut / empty top" rendering we were seeing.
  await new Promise(r => requestAnimationFrame(r));
  try { _fit.fit(); } catch {}
  _resizeObs = new ResizeObserver(() => {
    const r = container.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;  // ignore closing-dialog zero boxes
    try { _fit?.fit(); } catch {}
  });
  _resizeObs.observe(container);
  _term.focus();
  // Clear before any serial buffer flush — belt + suspenders alongside the
  // raf-deferred fit. Getty buffers from a prior session can flush into
  // xterm as leading blank lines right after the reader starts.
  _term.write("\x1b[2J\x1b[H");

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
}

async function disconnect() {
  // Release order matters: reader.cancel() resolves before the in-flight
  // read() promise settles, so releaseLock() must wait for the read pump
  // to actually exit — otherwise it throws "pending read", port.close()
  // then rejects with "stream is locked", and the port stays open. The
  // next port.open() (e.g. flashFlow's requestPort+open) fails with
  // "port is already open" even though the session looks gone.
  try { await _reader?.cancel(); } catch {}
  try { await _readPump; } catch {}
  try { _reader?.releaseLock(); } catch {}
  try { _writer?.releaseLock(); } catch {}
  try { await _port?.close(); } catch {}
  // Brief grace for the macOS kernel to release /dev/cu.usbserial-*.
  // Without this, an immediate flash-flow port.open() can still race.
  await new Promise((r) => setTimeout(r, 100));
  _reader = _writer = _readPump = _port = null;
  _resizeObs?.disconnect();
  _resizeObs = null;
  _fit?.dispose();
  _fit = null;
  _term?.dispose();
  _term = null;
  setStatus("disconnected");
  $("recovery-connect").textContent = "Connect via USB serial";
}

// Lazy-loaded from app.js on first "Recovery" menu click; one-time setup
// guarded by the flag, dialog-open behavior on every call.
let _initialized = false;
function initOnce() {
  if (_initialized) return;
  _initialized = true;
  $("recovery-close").addEventListener("click", () => $("recovery-modal").close());
  $("recovery-connect").addEventListener("click", () => _port ? disconnect() : connect());
  $("recovery-flash").addEventListener("click", flashFlow);
  // No outside-click dismiss — terminal session is real work; accidental
  // clicks outside the modal used to kill the connection and scrollback.
  // Explicit × button is the only way out.
  $("recovery-modal").addEventListener("close", () => { if (_port) disconnect(); });
}

// Browser-side firmware flash. Disconnects any active serial console
// session (esptool-js needs exclusive access to the port), runs the
// flash sequence, then re-opens the console at 115200 to watch boot
// of the freshly-flashed firmware.
async function flashFlow() {
  if (!("serial" in navigator)) {
    setStatus("error", "unsupported browser");
    log("Web Serial not supported — use Chrome or Edge on desktop");
    return;
  }
  if (!confirm("Flash the latest firmware to the connected ESP32?\n\n"
             + "This erases the chip's app + bootloader + partition table "
             + "and replaces them with the build CI most recently published "
             + "to public/firmware/bins/.")) return;
  // Detach the live console session so esptool-js can claim the port.
  const reconnectAfter = !!_port;
  if (_port) await disconnect();

  let port;
  try {
    port = await navigator.serial.requestPort();
    try { await port.open({ baudRate: 115200 }); }
    catch (err) {
      // Same SerialPort instance can come back from requestPort() in an
      // already-open state when a prior session (this tab or another) didn't
      // fully release it. Close + retry recovers it without a page reload.
      if (err.name === "InvalidStateError") {
        try { await port.close(); } catch {}
        await new Promise((r) => setTimeout(r, 200));
        await port.open({ baudRate: 115200 });
      } else throw err;
    }
  } catch (err) {
    if (err.name !== "NotFoundError") log(`Recovery flash port: ${err.message}`);
    setStatus("");
    return;
  }
  setStatus("connected", "flashing…");
  $("recovery-flash").disabled = true;

  // Need a terminal to render esptool-js's progress output; reuse the
  // recovery-term pane. Pulls in xterm if not already loaded.
  const { Terminal } = await ensureXtermLoaded();
  const container = $("recovery-term");
  container.innerHTML = "";
  const term = new Terminal({
    fontSize: 13,
    fontFamily: '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace',
    convertEol: true,
    theme: { background: "#1e1e1e", foreground: "#e4e4e4", cursor: "#e4e4e4" },
  });
  term.open(container);

  try {
    const { flashFirmware } = await import("./flasher.js");
    await flashFirmware(port, term, (fileIndex, pct) => {
      setStatus("connected", `flashing file ${fileIndex} ${pct}%`);
    });
    setStatus("connected", "flash done");
  } catch (err) {
    log(`Flash failed: ${err.message}`);
    term.writeln(`\r\n[flash error: ${err.message}]`);
    setStatus("error", err.message);
  } finally {
    try { await port.close(); } catch {}
    term.dispose();
    $("recovery-flash").disabled = false;
  }

  // Re-open the live console so the operator can watch boot. If the
  // chip auto-resets after flash (esptool-js's hardReset does this),
  // they'll see the boot sequence land in the freshly-cleared term.
  if (reconnectAfter) await connect();
}

export function openRecoveryDialog() {
  initOnce();
  $("recovery-modal").showModal();
}
