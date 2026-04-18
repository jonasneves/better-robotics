// Recovery console. Web Serial → Pi's USB-CDC-ACM (/dev/ttyGS0). This is
// the last-resort escape hatch — independent of pi-robot.service, so it
// works when BLE is dead, the firmware is crashing, or something weird is
// happening that the dashboard can't touch.
//
// Setup side: Pi is configured with a composite USB gadget (ECM + ACM) by
// usb-gadget.service. Plug USB-C to the host; a "BetterPi" serial device
// shows up; user picks it via the browser's port chooser. serial-getty runs
// a login prompt on the Pi side.
import { $, wireDialogOutsideClick } from "./dom.js";
import { log } from "./log.js";

let _port = null;
let _reader = null;
let _writer = null;
let _readLoop = null;

function appendOutput(text) {
  const out = $("recovery-output");
  out.textContent += text;
  out.scrollTop = out.scrollHeight;
}

function setStatus(msg) {
  $("recovery-status").textContent = msg;
}

async function connect() {
  if (!("serial" in navigator)) {
    log("Web Serial not supported — use Chrome or Edge on desktop");
    setStatus("unsupported browser");
    return;
  }
  try {
    _port = await navigator.serial.requestPort();
    await _port.open({ baudRate: 115200 });
    setStatus("connected");
    $("recovery-connect").textContent = "Disconnect";
    $("recovery-output").textContent = "";
    // Async reader loop — pushes decoded bytes into the output pane.
    const decoder = new TextDecoderStream();
    _port.readable.pipeTo(decoder.writable).catch(() => {});
    _reader = decoder.readable.getReader();
    _writer = _port.writable.getWriter();
    _readLoop = (async () => {
      try {
        while (true) {
          const { value, done } = await _reader.read();
          if (done) break;
          if (value) appendOutput(value);
        }
      } catch (err) {
        appendOutput(`\n[read error: ${err.message}]\n`);
      }
    })();
  } catch (err) {
    if (err.name !== "NotFoundError") log(`Recovery connect error: ${err.message}`);
    setStatus("disconnected");
  }
}

async function disconnect() {
  try { await _reader?.cancel(); } catch {}
  try { await _writer?.close(); } catch {}
  try { await _port?.close(); } catch {}
  _reader = _writer = _port = _readLoop = null;
  setStatus("disconnected");
  $("recovery-connect").textContent = "Connect via USB serial";
}

async function send() {
  if (!_writer) return;
  const input = $("recovery-input");
  const cmd = input.value;
  input.value = "";
  try {
    await _writer.write(new TextEncoder().encode(cmd + "\n"));
  } catch (err) {
    appendOutput(`\n[write error: ${err.message}]\n`);
  }
}

export function openRecoveryDialog() {
  $("recovery-modal").showModal();
}

export function initRecovery() {
  $("recovery-close").addEventListener("click", () => $("recovery-modal").close());
  wireDialogOutsideClick($("recovery-modal"));
  $("recovery-connect").addEventListener("click", () => _port ? disconnect() : connect());
  $("recovery-send").addEventListener("click", send);
  $("recovery-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); send(); }
  });
}
