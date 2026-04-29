// Browser-side ESP32 flasher using esptool-js + Web Serial.
//
// Replaces the local-CLI flow (`make setup` → `idf.py flash` /
// `esptool.py write_flash`). The dashboard fetches the same 4 bins it
// publishes for OTA, then esptool-js streams them to the chip over a
// Web Serial port the operator picks from the browser chooser. No
// driver install on macOS/Linux; Windows still needs the usual CP210x
// or CH340 USB-serial driver.
//
// Same browser constraint as the rest of the recovery UI — Chrome /
// Edge with Web Serial. esptool-js is dynamic-imported on first use so
// the ~250 KB module only downloads when actually flashing.

import { $ } from "./dom.js";
import { log } from "./log.js";

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

// Adapter: esptool-js wants a `terminal` object with clean/writeLine/write.
// The recovery dialog's xterm Terminal has slightly different methods
// (write/writeln). Bridge them.
function makeXtermAdapter(term) {
  return {
    clean: () => term.write("\x1b[2J\x1b[H"),
    writeLine: (line) => term.writeln(line),
    write: (s) => term.write(s),
  };
}

// Returns a function the recovery dialog can call. Caller provides the
// already-open Web Serial port (so we share the same chooser session
// the operator just authorized) and the xterm Terminal for progress
// output. On success the chip resets into the new firmware; the recovery
// console then re-attaches to the same port at 115200 to follow boot.
export async function flashFirmware(port, term, onProgress = () => {}) {
  const { ESPLoader, Transport } = await ensureEsptoolLoaded();

  const transport = new Transport(port, true);
  const loader = new ESPLoader({
    transport,
    baudrate: 921600,                  // sync at 115200, switch up after
    romBaudrate: 115200,
    terminal: makeXtermAdapter(term),
  });

  // main() syncs with the bootloader (asserts EN+GPIO0, reads chip
  // signature, picks ROM stub). Throws if the chip isn't in download
  // mode — most CAM-MB boards have auto-reset wiring so a fresh
  // serial.open() pulse will land here cleanly.
  await loader.main();

  // Fetch the same bins CI publishes for OTA. Offsets match the
  // partition layout (matches arduino-esp32 min_spiffs):
  //   0x01000 bootloader
  //   0x08000 partition table
  //   0x0E000 ota_data_initial
  //   0x10000 application
  term.writeln("\r\nFetching firmware bins…");
  const [bootloader, partitions, otaData, app] = await Promise.all([
    fetchBin("firmware/bins/bootloader.bin"),
    fetchBin("firmware/bins/partitions.bin"),
    fetchBin("firmware/bins/boot_app0.bin"),
    fetchBin("firmware/bins/esp32_robot.bin"),
  ]);
  term.writeln(`bootloader=${bootloader.length} part=${partitions.length} ota=${otaData.length} app=${app.length}`);

  const fileArray = [
    { data: bootloader, address: 0x1000 },
    { data: partitions, address: 0x8000 },
    { data: otaData,    address: 0xE000 },
    { data: app,        address: 0x10000 },
  ];

  await loader.writeFlash({
    fileArray,
    flashSize: "keep",
    flashMode: "keep",
    flashFreq: "keep",
    eraseAll: false,
    compress: true,
    reportProgress: (fileIndex, written, total) => {
      const pct = total ? Math.round((written / total) * 100) : 0;
      onProgress(fileIndex, pct);
    },
  });

  term.writeln("\r\nFlash complete. Resetting…");
  await loader.hardReset();
  // Caller is responsible for closing/reopening the Transport — we leave
  // the port in the same state we got it.
}
