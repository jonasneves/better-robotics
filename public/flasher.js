// Browser-side ESP32 flasher using esptool-js + Web Serial.
//
// Replaces the local-CLI flow (`make setup` → `idf.py flash` /
// `esptool.py write_flash`). The dashboard fetches the per-board bins it
// publishes for OTA, then esptool-js streams them to the chip over a
// Web Serial port the operator picks from the browser chooser. No
// driver install on macOS/Linux; Windows still needs the usual CP210x
// or CH340 USB-serial driver.
//
// Same browser constraint as the rest of the recovery UI — Chrome /
// Edge with Web Serial. esptool-js is dynamic-imported on first use so
// the ~250 KB module only downloads when actually flashing.
//
// UI host is the caller's problem. flashFirmware takes callbacks
// (onLog for human-facing status, onProgress for the bar, pickBoard
// for the variant choice).

let _esptoolModule = null;

async function ensureEsptoolLoaded() {
  if (_esptoolModule) return _esptoolModule;
  // Pin to a known release line — `latest` would silently break us on
  // a major version bump. esptool-js@^0.5 is the current stable.
  _esptoolModule = await import("https://cdn.jsdelivr.net/npm/esptool-js@0.5/+esm");
  return _esptoolModule;
}

// esptool-js expects "binary strings" (one char per byte) for file data,
// not Uint8Array. Convert via charCode mapping; chunked to avoid stack
// overflow from String.fromCharCode(...arr) on large bins.
function bytesToBinaryString(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

async function fetchBin(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`fetch ${path}: HTTP ${r.status}`);
  return bytesToBinaryString(await r.arrayBuffer());
}

async function fetchJson(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`fetch ${path}: HTTP ${r.status}`);
  return r.json();
}

// Map esptool's chip-name string to the IDF target string firmware reports
// in fw_info.chip. Lets the UI compare chip identity across the two
// surfaces without each side knowing the other's casing.
function chipNameToIdfTarget(chipName) {
  const s = (chipName || "").toLowerCase().replace(/-/g, "");
  if (s.startsWith("esp32c3")) return "esp32c3";
  if (s.startsWith("esp32s3")) return "esp32s3";
  if (s.startsWith("esp32s2")) return "esp32s2";
  if (s.startsWith("esp32")) return "esp32";
  return s;  // fallback — caller treats unknown as "no compatible board"
}

// Buffering terminal — esptool-js writes chip-detect / sync / write
// progress lines through this. The callback `onTrace(line)` is supplied
// by the caller; if it's a plain array push (no DOM work), it doesn't
// stall the main thread or break sync timing. An earlier version
// wrote each byte to log() / DOM directly, which drifted the DTR/RTS↔
// sync window enough that connect attempts timed out.
function makeBufferingTerminal(onTrace) {
  let buf = "";
  return {
    clean: () => {},
    writeLine: (line) => { if (line) onTrace(line); },
    write: (s) => {
      buf += s;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        if (line) onTrace(line);
        buf = buf.slice(nl + 1);
      }
    },
  };
}

// Flash flow split into two stages so the caller can pop a board picker
// between chip detection and write:
//
//   1. loader.main()          → detects chip; pickBoard resolves variant
//   2. fetch manifest + write → uses manifest's per-target flash offsets
//
// Callbacks the caller supplies:
//   onLog(text)                  — user-facing status line (one short message)
//   onProgress(fileIndex, pct)   — progress bar update during writeFlash
//   pickBoard({chip, chipName})  — returns variant id ("aithinker_cam_webrtc"
//                                  etc.) or null to cancel
//
// Returns { board, chip } on success, null on cancel.
export async function flashFirmware(port, { onLog = () => {}, onProgress = () => {}, onTrace = () => {}, pickBoard }) {
  if (!pickBoard) throw new Error("flashFirmware: pickBoard callback required");

  const { ESPLoader, Transport } = await ensureEsptoolLoaded();

  // Match esp-web-tools' configuration exactly — same Transport tracing
  // flag, same baud through sync and flash. Bumping to 921600 for flash
  // saves time but isn't worth it if it ever destabilizes sync; revisit
  // once the install path is confirmed reliable across hardware.
  const transport = new Transport(port, true);
  const loader = new ESPLoader({
    transport,
    baudrate: 115200,
    romBaudrate: 115200,
    enableTracing: false,
    debugLogging: false,
    terminal: makeBufferingTerminal(onTrace),
  });

  // esptool-js method names drift between minor versions (v0.4's
  // `loader.hardReset()` is gone in v0.5; v0.5's `transport.hardReset()`
  // also isn't there in some patch releases; transport.setRTS exists
  // but is a no-op while the transport's reader/writer locks are still
  // held on the port). The flash itself is done by the time we hit
  // this, so the post-flash reset is best-effort.
  //
  // Order: try the documented method names, then release the transport
  // and drive port.setSignals directly. Any failure is swallowed —
  // worst case the chip stays in stub-loader mode until the user
  // power-cycles, which is fine because the firmware is already on it.
  async function resetChip() {
    const attempt = async (label, fn) => {
      try { await fn(); onTrace(`reset: ${label} ok`); return true; }
      catch (e) { onTrace(`reset: ${label} failed (${e?.message || e})`); return false; }
    };

    // 1. Library reset method if available (esptool-js handles its own
    //    RTS pulse). Don't early-return — we still need step 2.
    let libReset = false;
    if (typeof loader.after === "function")
      libReset = await attempt("loader.after(hard_reset)", () => loader.after("hard_reset"));
    if (!libReset && typeof loader.hardReset === "function")
      libReset = await attempt("loader.hardReset()", () => loader.hardReset());
    if (!libReset && typeof transport.hardReset === "function")
      libReset = await attempt("transport.hardReset()", () => transport.hardReset());

    // 2. Release the transport's reader/writer locks ALWAYS, even on the
    //    happy path. Without this, port.close() in installEsp32's finally
    //    silently fails ("port is locked") — Chrome's tab indicator stays
    //    on, and the port can't be reused for the live console or another
    //    install. Also unblocks setSignals on the raw port below.
    if (typeof transport.disconnect === "function")
      await attempt("transport.disconnect()", () => transport.disconnect());

    // 3. If the library reset didn't run, drive the reset manually now
    //    that the transport is released.
    //      RTS=true  → EN low  (reset asserted)
    //      DTR=false → IO0 high (normal boot, not download)
    if (!libReset) {
      await attempt("port.setSignals RTS=1 DTR=0", () =>
        port.setSignals({ requestToSend: true, dataTerminalReady: false }));
      await new Promise((r) => setTimeout(r, 100));
      await attempt("port.setSignals RTS=0 DTR=0", () =>
        port.setSignals({ requestToSend: false, dataTerminalReady: false }));
    }
  }

  // main() syncs with the bootloader (asserts EN+GPIO0, reads chip
  // signature, picks ROM stub). Throws if the chip isn't in download
  // mode — most CAM-MB boards have auto-reset wiring so a fresh
  // serial.open() pulse will land here cleanly.
  onLog("Detecting chip…");
  const chipName = await loader.main();
  const chip = chipNameToIdfTarget(chipName);
  onLog(`Detected: ${chipName}`);

  const board = await pickBoard({ chip, chipName });
  if (!board) {
    onLog("Cancelled. Resetting chip…");
    await resetChip();
    return null;
  }

  // Per-board manifest carries the flash offsets — bootloader sits at
  // 0x1000 on esp32 and 0x0 on esp32c3, so a single hardcoded offset
  // table doesn't work. build.sh writes this alongside the bins.
  onLog(`Fetching ${board} bundle…`);
  const manifest = await fetchJson(`firmware/bins/${board}/manifest.json`);
  if (manifest.chip && manifest.chip !== chip) {
    throw new Error(`Bundle is for ${manifest.chip}, connected chip is ${chip}. Flashing would brick the bootloader until USB recovery.`);
  }

  const fileArray = [];
  for (const f of manifest.files) {
    const data = await fetchBin(`firmware/bins/${board}/${f.path}`);
    fileArray.push({ data, address: parseInt(f.offset, 16) });
  }

  onLog("Writing firmware…");
  await loader.writeFlash({
    fileArray,
    flashSize: "keep",
    flashMode: "keep",
    flashFreq: "keep",
    eraseAll: false,
    compress: true,
    reportProgress: (fileIndex, written, total) => {
      const pct = total ? Math.round((written / total) * 100) : 0;
      onProgress(fileIndex, pct, manifest.files.length);
    },
  });

  onLog("Resetting chip…");
  await resetChip();
  return { board, chip };
}
