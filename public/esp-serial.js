// ESP32 USB serial console + flash. Companion to recovery.js (Pi USB-CDC);
// shares xterm.js + Web Serial primitives via xterm-host.js.
import { $ } from "./dom.js";
import { log } from "./log.js";
import { mountTerminal } from "./xterm-host.js";

let _wired = false;
let _port = null;
let _reader = null;
let _writer = null;
let _readPump = null;
let _term = null;
let _fit = null;
let _resizeObs = null;

const ENCODER = new TextEncoder();

// state: "" (idle/disconnected) | "connected" | "connecting" | "error".
// Drives the dot color; text only renders for non-default detail messages.
function setStatus(state, text = "") {
  const dot = $("esp-serial-status-dot");
  const el = $("esp-serial-status");
  if (dot) dot.className = `dot${state ? ` ${state}` : ""}`;
  if (el) el.textContent = text;
}

// ESP32 USB-UART bridges + native USB. Filtering on these keeps an
// authorized Pi gadget from being silently picked when the user clicks
// Connect in ESP mode, and narrows the picker to ESP-class chips.
//   - 0x10c4 Silicon Labs CP210x  (ESP32-CAM, most ESP32-DevKit)
//   - 0x1a86 WCH CH340/CH341       (cheap ESP32-WROOM clones)
//   - 0x0403 FTDI FT232            (older boards)
//   - 0x303a Espressif native USB  (ESP32-S3 / -C3)
const ESP_FILTERS = [
  { usbVendorId: 0x10c4 },
  { usbVendorId: 0x1a86 },
  { usbVendorId: 0x0403 },
  { usbVendorId: 0x303a },
];
function isEspPort(port) {
  try {
    const { usbVendorId } = port.getInfo();
    return ESP_FILTERS.some(f => f.usbVendorId === usbVendorId);
  } catch { return false; }
}
function pickKnownEsp(ports) {
  return ports.find(isEspPort) || null;
}
async function pickOrRequestPort({ unfiltered = false } = {}) {
  if (unfiltered) {
    // Escape hatch: filtered picker came back empty. Honour the user's
    // choice but warn if VID isn't in our known-ESP list — keeps the
    // "Pi gadget got picked in ESP mode" footgun contained as a
    // post-pick warning instead of a pre-pick block.
    const port = await navigator.serial.requestPort();
    const info = (() => { try { return port.getInfo(); } catch { return {}; } })();
    if (!ESP_FILTERS.some(f => f.usbVendorId === info.usbVendorId)) {
      log(`ESP: picked port vid=0x${(info.usbVendorId||0).toString(16)} pid=0x${(info.usbProductId||0).toString(16)} — not a known ESP USB-UART VID, connecting anyway`);
    }
    return port;
  }
  let known = [];
  try { known = await navigator.serial.getPorts(); } catch {}
  return pickKnownEsp(known) || await navigator.serial.requestPort({ filters: ESP_FILTERS });
}
// Two-attempt open: macOS occasionally fails the first open() right after
// a previous disconnect because the kernel hasn't fully released the
// /dev/cu.usbserial node; and a SerialPort that came back already-open
// from a prior tab/page session needs an explicit close() before retry.
async function openWithRetry(port) {
  try { await port.open({ baudRate: 115200 }); }
  catch (err) {
    if (err.name === "InvalidStateError") {
      try { await port.close(); } catch {}
    }
    await new Promise((r) => setTimeout(r, 200));
    await port.open({ baudRate: 115200 });
  }
}

// Hand a closed port to esptool-js; let it run its own reset sequence.
// An earlier version did an open()→close() probe here, but each open()
// pulses DTR/RTS and resets the chip — by the time esptool tried to
// enter download mode the chip had already booted into normal firmware
// (which doesn't speak the esptool protocol) and sync timed out with
// "No serial data received". The right defense for a wedged port is
// the catch block in installEsp32 below, which triggers forget +
// re-prompt only when esptool actually fails to open.
async function preparePortForInstall(port) {
  // Defensive close — handles same-tab wedge from a prior session.
  // close() on an already-closed port throws; the catch swallows.
  try { await port.close(); } catch {}
  return port;
}

function isPortLockedError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return err.name === "InvalidStateError" || msg.includes("already open");
}

async function connect({ unfiltered = false } = {}) {
  if (_port) return;
  if (!("serial" in navigator)) {
    setStatus("error", "unsupported browser");
    log("Web Serial not supported — use Chrome or Edge on desktop");
    return;
  }
  setStatus("connecting", "opening…");
  try {
    _port = await pickOrRequestPort({ unfiltered });
  } catch (err) {
    if (err.name !== "NotFoundError") setStatus("error", `pick cancelled: ${err.message}`);
    else setStatus("");
    if (err.name === "NotFoundError" && !unfiltered) {
      $("esp-serial-show-all").hidden = false;
    }
    return;
  }
  $("esp-serial-show-all").hidden = true;
  try {
    await openWithRetry(_port);
    // Deassert DTR/RTS — ESP32-CAM (and most ESP32 dev boards) wire those
    // through transistors to EN + GPIO0. Chrome's default asserted state
    // on open() pulses them, which resets the chip and kills any active
    // BLE session.
    try { await _port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {}
  } catch (err) {
    setStatus("error", `open failed: ${err.message}`);
    _port = null;
    return;
  }

  ({ term: _term, fit: _fit, resizeObs: _resizeObs } = await mountTerminal($("esp-serial-console-host")));
  _term.focus();

  _term.onData(async (data) => {
    if (!_writer) return;
    try { await _writer.write(ENCODER.encode(data)); }
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
  $("esp-serial-show-all").hidden = true;
  setStatus("");
}

// Catalog drives the picker UI. Each entry maps a board to the chip it
// runs on, the USB VID/PID hint that suggests it (best-effort — both
// bridges ship with both boards depending on batch), and the resolver
// for the WebRTC toggle (camera-capable boards have two bundle variants).
const BOARDS = [
  {
    id: "aithinker_cam",
    chip: "esp32",
    label: "AI-Thinker ESP32-CAM",
    sub: "Camera + PSRAM. The headline board.",
    usbHints: [0x10c4],  // CP210x is the typical AI-Thinker programmer bridge
    webrtc: { capable: true, on: "aithinker_cam_webrtc", off: "aithinker_cam" },
  },
  {
    id: "devkit",
    chip: "esp32",
    label: "ESP32 DevKitV1 / WROOM-32",
    sub: "Classic ESP32 module. No camera, ~25 usable GPIOs.",
    usbHints: [0x1a86],  // CH340 typical on cheap DevKits
    webrtc: { capable: false },
  },
  {
    id: "c3_supermini",
    chip: "esp32c3",
    label: "ESP32-C3 SuperMini",
    sub: "RISC-V single core, native USB. No camera.",
    usbHints: [0x303a],  // Espressif native USB-CDC-JTAG
    webrtc: { capable: false },
  },
];

const LAST_BOARD_KEY = "esp-flash:last-board";

function resolveBundleId(board, webrtcChecked) {
  if (board.webrtc.capable) {
    return webrtcChecked ? board.webrtc.on : board.webrtc.off;
  }
  return board.id;
}

// Install-dialog state machine. One <dialog> hosts the full arc —
// connecting → picking → flashing → done — so the operator sees one
// surface from click to chip-reset instead of a sequence of modals.
function setFlashStatus(text) { $("esp-flash-status").textContent = text; }
function setFlashSubtitle(text) { $("esp-flash-subtitle").textContent = text || ""; }

// In-memory esptool trace buffer. Written to as plain array pushes (no
// DOM) so it doesn't stall sync timing the way per-byte DOM writes did.
// Flushed to the <pre> on disclosure open.
let _flashTrace = [];
function pushFlashTrace(line) {
  _flashTrace.push(line);
  // Live tail: if the disclosure is open while the install runs, append
  // each line and pin scroll to the bottom. Closed → buffer-only, full
  // render on next open.
  const details = $("esp-flash-details");
  if (details?.open) {
    const pre = $("esp-flash-trace");
    if (pre.textContent) pre.appendChild(document.createTextNode("\n"));
    pre.appendChild(document.createTextNode(line));
    pre.scrollTop = pre.scrollHeight;
  }
}
function renderFlashTrace() {
  const pre = $("esp-flash-trace");
  pre.textContent = _flashTrace.join("\n");
  pre.scrollTop = pre.scrollHeight;
}
function setFlashProgress(pct, sub = "") {
  $("esp-flash-progress-fill").style.width = `${pct}%`;
  $("esp-flash-progress-sub").textContent = sub;
}
function resetFlashDialog() {
  $("esp-flash-pick").hidden = true;
  $("esp-flash-progress").hidden = true;
  setFlashProgress(0, "");
  $("esp-flash-install").hidden = false;
  $("esp-flash-install").disabled = true;
  $("esp-flash-cancel").disabled = false;
  $("esp-flash-cancel").textContent = "Cancel";
  $("esp-flash-empty").hidden = true;
  $("esp-flash-webrtc-wrap").hidden = true;
  $("esp-flash-boards").innerHTML = "";
  setFlashSubtitle("");
  $("esp-flash-status").classList.remove("success", "error");
  _flashTrace = [];
  $("esp-flash-details").open = false;
  $("esp-flash-trace").textContent = "";
}
function flashDialogState(state) {
  const install = $("esp-flash-install");
  const cancel  = $("esp-flash-cancel");
  switch (state) {
    case "connecting":
      $("esp-flash-pick").hidden = true;
      $("esp-flash-progress").hidden = true;
      install.disabled = true;
      cancel.disabled = false;
      cancel.textContent = "Cancel";
      break;
    case "picking":
      $("esp-flash-pick").hidden = false;
      $("esp-flash-progress").hidden = true;
      cancel.disabled = false;
      cancel.textContent = "Cancel";
      break;
    case "flashing":
      $("esp-flash-pick").hidden = true;
      $("esp-flash-progress").hidden = false;
      install.disabled = true;
      cancel.disabled = true;
      break;
    case "done":
      $("esp-flash-pick").hidden = true;
      $("esp-flash-progress").hidden = false;
      install.hidden = true;
      cancel.disabled = false;
      cancel.textContent = "Done";
      $("esp-flash-status").classList.add("success");
      $("esp-flash-status").classList.remove("error");
      break;
    case "error":
      install.disabled = true;
      cancel.disabled = false;
      cancel.textContent = "Close";
      $("esp-flash-status").classList.add("error");
      $("esp-flash-status").classList.remove("success");
      break;
  }
}

// Picker promise managed via module-level resolver — the install/cancel
// buttons have permanent listeners (wired once in init()) that drive
// this. Avoids a per-call add/removeEventListener dance and the listener
// leak that comes with it. Null when no pick is in flight.
let _pickerResolve = null;

function pickBoardInDialog({ chip, chipName, portInfo = {} }) {
  return new Promise((resolve) => {
    _pickerResolve = (val) => { _pickerResolve = null; resolve(val); };

    const compatible = BOARDS.filter(b => b.chip === chip);
    setFlashStatus(`Detected: ${chipName || chip}`);
    setFlashSubtitle(chipName || chip);

    const boardsEl = $("esp-flash-boards");
    boardsEl.innerHTML = "";
    if (compatible.length === 0) {
      $("esp-flash-empty").hidden = false;
      $("esp-flash-webrtc-wrap").hidden = true;
      $("esp-flash-install").disabled = true;
    } else {
      $("esp-flash-empty").hidden = true;
      // VID hint + last-used: VID match wins; otherwise last-used if that
      // board is in the compatible set; otherwise first compatible.
      const vid = portInfo.usbVendorId;
      const byHint = compatible.find(b => vid && b.usbHints.includes(vid));
      const lastId = localStorage.getItem(LAST_BOARD_KEY);
      const byLast = compatible.find(b => b.id === lastId);
      const preselect = (byHint || byLast || compatible[0]).id;

      for (const b of compatible) {
        const label = document.createElement("label");
        label.className = "esp-flash-board-option";
        label.innerHTML = `
          <input type="radio" name="esp-flash-board" value="${b.id}"${b.id === preselect ? " checked" : ""}>
          <span class="esp-flash-board-title">${b.label}</span>
          <span class="esp-flash-board-sub meta">${b.sub}</span>`;
        boardsEl.appendChild(label);
      }
      $("esp-flash-install").disabled = false;
    }
    syncWebrtcVisibility();
    syncBundleVersion();
    // Subtitle: prefer the preselected board's friendly label over the
    // bare chip name set during detect.
    const initial = boardsEl.querySelector("input[name='esp-flash-board']:checked");
    const initialBoard = initial && BOARDS.find(b => b.id === initial.value);
    if (initialBoard) setFlashSubtitle(initialBoard.label);
    flashDialogState("picking");
    // HIG: one keypress to commit on the happy path. Focus the Install
    // button after the boards render so power users can hit Enter.
    $("esp-flash-install").focus();
  });
}

function syncWebrtcVisibility() {
  const picked = $("esp-flash-boards").querySelector("input[name='esp-flash-board']:checked");
  const board  = picked && BOARDS.find(b => b.id === picked.value);
  $("esp-flash-webrtc-wrap").hidden = !(board && board.webrtc.capable);
}

// Bundle version line. Reflects what's about to be flashed — fetched
// from the picked variant's manifest.json. Used as a sanity check so
// the operator can cross-reference what they're installing against
// what the chip reports after boot (fw_info.version).
function humanRelative(isoStr) {
  const t = Date.parse(isoStr);
  if (Number.isNaN(t)) return "";
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

let _versionFetchToken = 0;  // latest-wins guard for in-flight fetches
async function syncBundleVersion() {
  const versionEl = $("esp-flash-version");
  if (!versionEl) return;
  const picked = $("esp-flash-boards").querySelector("input[name='esp-flash-board']:checked");
  if (!picked) { versionEl.textContent = ""; return; }
  const board = BOARDS.find(b => b.id === picked.value);
  if (!board) { versionEl.textContent = ""; return; }
  const bundleId = resolveBundleId(board, $("esp-flash-webrtc-cb").checked);

  const token = ++_versionFetchToken;
  versionEl.textContent = "Loading bundle…";
  try {
    const r = await fetch(`firmware/bins/${bundleId}/manifest.json`, { cache: "no-cache" });
    if (token !== _versionFetchToken) return;  // user changed picks mid-flight
    if (!r.ok) {
      versionEl.textContent = "Bundle not published yet for this board.";
      return;
    }
    const m = await r.json();
    if (token !== _versionFetchToken) return;
    let text = `Bundle: ${m.version || "unknown"}`;
    if (m.built_at) {
      const ago = humanRelative(m.built_at);
      if (ago) text += ` · built ${ago}`;
    }
    versionEl.textContent = text;
  } catch {
    if (token !== _versionFetchToken) return;
    versionEl.textContent = "";
  }
}

// Canonical install entry point. Both flash buttons (front-page setup
// card, serial-console modal) route here. Returns { board, chip } on
// success, null on cancel.
export async function installEsp32() {
  if (!("serial" in navigator)) {
    log("Web Serial not supported — use Chrome or Edge on desktop");
    return null;
  }
  // init() binds the install-dialog button listeners. Idempotent (the
  // _wired flag short-circuits repeat calls), but must be called here
  // because front-page entry can fire before the user opens the console
  // modal — and the console modal's mode-switch is the other init trigger.
  init();
  // Release any console port we hold — Web Serial open() throws if the
  // port is already in use by another caller in this tab.
  if (_port) await disconnect();

  // pickOrRequestPort must be called synchronously from the user-gesture
  // handler. The dialog opens *after* the port is in hand so a port-pick
  // cancel doesn't leave an empty dialog on screen.
  let port;
  try {
    port = await pickOrRequestPort();
  } catch (err) {
    if (err.name !== "NotFoundError") log(`ESP port pick: ${err.message}`);
    return null;
  }

  resetFlashDialog();
  flashDialogState("connecting");
  setFlashStatus("Connecting to chip…");
  const modal = $("esp-flash-modal");
  if (!modal.open) modal.showModal();

  await preparePortForInstall(port);

  const runFlash = async (p) => {
    const portInfo = (() => { try { return p.getInfo(); } catch { return {}; } })();
    const { flashFirmware } = await import("./flasher.js");
    return await flashFirmware(p, {
      onLog: setFlashStatus,
      onProgress: (fileIndex, pct, totalFiles) => {
        flashDialogState("flashing");
        setFlashProgress(pct, `File ${fileIndex + 1} of ${totalFiles} — ${pct}%`);
      },
      onTrace: pushFlashTrace,
      pickBoard: ({ chip, chipName }) => pickBoardInDialog({ chip, chipName, portInfo }),
    });
  };

  let result = null;
  try {
    result = await runFlash(port);
  } catch (err) {
    if (isPortLockedError(err)) {
      // Cached SerialPort wedged (held by another tab / kernel race /
      // phantom-open). Revoke the grant and re-prompt for a fresh handle,
      // then retry once.
      log(`ESP install: port locked (${err.message}); revoking grant and re-prompting`);
      try { await port.forget(); } catch {}
      try {
        port = await navigator.serial.requestPort({ filters: ESP_FILTERS });
        await preparePortForInstall(port);
        result = await runFlash(port);
      } catch (err2) {
        if (err2.name === "NotFoundError") {
          modal.close();
          return null;
        }
        log(`Install retry failed: ${err2.message}`);
        setFlashStatus(`Install failed: ${err2.message}`);
        flashDialogState("error");
      }
    } else {
      log(`Install failed: ${err.message}`);
      setFlashStatus(`Install failed: ${err.message}. If the chip is an AI-Thinker bare module, hold the BOOT button while clicking Install.`);
      flashDialogState("error");
    }
  } finally {
    // Deassert RTS+DTR before close so the FTDI driver doesn't latch
    // either line in an asserted state at port close — when RTS stays
    // asserted, EN stays low and the chip sits in reset until the user
    // physically replugs. Belt and suspenders with esptool-js's own
    // "Hard resetting via RTS pin..." that runs at writeFlash exit.
    try { await port.setSignals({ requestToSend: false, dataTerminalReady: false }); } catch {}
    // Small breathing room for the FTDI driver to apply those signals
    // and for the chip's boot sequence to start running on its own.
    await new Promise((r) => setTimeout(r, 300));
    try { await port.close(); } catch {}
  }

  if (result) {
    setFlashProgress(100, "Done.");
    flashDialogState("done");
    setFlashStatus(`Installed ${result.board}. If the chip doesn't boot in a few seconds, unplug and replug it — auto-reset isn't reliable on every USB-UART bridge.`);
  } else if (result === null && !$("esp-flash-status").textContent.startsWith("Install failed")) {
    // Cancelled at the picker — close immediately.
    modal.close();
  }
  return result;
}

// Same purpose as recovery.releasePort — see comment there.
export async function releasePort() { if (_port) await disconnect(); }

export function init() {
  if (_wired) return;
  _wired = true;
  $("console-close").addEventListener("click", () => $("console-modal").close());
  $("esp-serial-connect").addEventListener("click", () => _port ? disconnect() : connect());
  $("esp-serial-show-all")?.addEventListener("click", () => connect({ unfiltered: true }));
  // Serial-console Flash button: install, then reopen the console if the
  // user had it connected before. installEsp32 handles its own disconnect.
  $("esp-serial-flash").addEventListener("click", async () => {
    const wasConnected = !!_port;
    await installEsp32();
    if (wasConnected) await connect();
  });
  // Auto-disconnect when the dialog closes — leaving the port open across
  // dialog hides would block other tools (Flash button) from reusing it.
  $("console-modal").addEventListener("close", () => { if (_port) disconnect(); });

  // Install-dialog button wiring — bound once, driven by state. Cancel
  // doubles as Close in done/error states (its label changes accordingly).
  $("esp-flash-install").addEventListener("click", () => {
    if (!_pickerResolve) return;
    const picked = $("esp-flash-boards").querySelector("input[name='esp-flash-board']:checked");
    if (!picked) return;
    const board = BOARDS.find(b => b.id === picked.value);
    localStorage.setItem(LAST_BOARD_KEY, board.id);
    _pickerResolve(resolveBundleId(board, $("esp-flash-webrtc-cb").checked));
  });
  $("esp-flash-cancel").addEventListener("click", () => {
    if (_pickerResolve) _pickerResolve(null);
    else $("esp-flash-modal").close();
  });
  $("esp-flash-close").addEventListener("click", () => {
    if (_pickerResolve) _pickerResolve(null);
    $("esp-flash-modal").close();
  });
  $("esp-flash-boards").addEventListener("change", () => {
    syncWebrtcVisibility();
    syncBundleVersion();
    const picked = $("esp-flash-boards").querySelector("input[name='esp-flash-board']:checked");
    const board  = picked && BOARDS.find(b => b.id === picked.value);
    if (board) setFlashSubtitle(board.label);
  });
  $("esp-flash-webrtc-cb").addEventListener("change", syncBundleVersion);
  // Lazy-render the esptool trace on disclosure open. Buffer is appended
  // to throughout the install with no DOM cost; the textContent assignment
  // here is one shot.
  $("esp-flash-details").addEventListener("toggle", (e) => {
    if (e.target.open) renderFlashTrace();
  });
  // Backstop: Escape closes <dialog> directly — make sure a pending pick
  // resolves so installEsp32's await doesn't hang.
  $("esp-flash-modal").addEventListener("close", () => {
    if (_pickerResolve) _pickerResolve(null);
  });
}
