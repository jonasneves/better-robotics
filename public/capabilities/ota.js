// Routes updates to the right data plane: ESP32 + WiFi joined → PNA-direct
// HTTP POST to the robot's /ota endpoint (dashboard pushes over WiFi, seconds);
// otherwise BLE stream with flow-controlled WithoutResponse chunk writes.
import {
  OTA_DATA_CHAR_UUID, OTA_STATUS_CHAR_UUID,
  decodeJson,
} from "../ble.js";
import { freshUrl } from "../dom.js";
import { logFor, log } from "../log.js";
import { state } from "../state.js";

// Stream a single-file OTA bundle to the Pi. The dashboard constructs a
// minimal bundle on the fly (no reboot; optional service restart) and reuses
// the existing ota-data char. Dest path still goes through the firmware's
// allowed-prefix whitelist — no new security surface.
export async function uploadFile(id, filename, destPath, contentBytes, { restart, mode = "644" } = {}) {
  const entry = state.devices.get(id);
  if (!entry?.otaDataChar) {
    log("file upload not supported by this firmware");
    return false;
  }
  let bin = "";
  for (let i = 0; i < contentBytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, contentBytes.subarray(i, i + 0x8000));
  }
  const manifest = { files: [{ src: filename, dest: destPath, mode }] };
  if (restart) manifest.restart = restart;
  const bundle = { manifest, files: { [filename]: btoa(bin) } };
  const payload = new TextEncoder().encode(JSON.stringify(bundle));
  await acquireWakeLock();
  try {
    logFor(entry, `uploading ${filename} → ${destPath} (${contentBytes.length} B)`);
    await streamOtaBytes(entry, payload);
    return true;
  } catch (err) {
    logFor(entry, `upload failed: ${err.message}`);
    return false;
  } finally {
    await releaseWakeLock();
  }
}

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

// macOS putting the display to sleep throttles the BLE write loop enough to
// stall a 10-minute stream; hold a wake lock for the duration of the OTA.
let wakeLock = null;
async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); }
  catch { wakeLock = null; }
}
async function releaseWakeLock() {
  if (wakeLock) { try { await wakeLock.release(); } catch {} wakeLock = null; }
}

async function streamOtaBytes(entry, bytes) {
  const ch = entry.otaDataChar;
  // All frames WithResponse. The WithoutResponse speedup needs the OTA
  // characteristic to advertise WRITE_WITHOUT_RESPONSE property, which
  // neither Pi nor ESP32 firmware declares today — Chrome then either
  // silently drops writes or mis-falls-back, and OTA stalls. Reverting
  // pending a follow-up firmware change that adds the property.
  try { await ch.writeValueWithResponse(new Uint8Array([0x00])); } catch {}
  const begin = new Uint8Array(5);
  begin[0] = 0x01;
  new DataView(begin.buffer).setUint32(1, bytes.length, false);
  await ch.writeValueWithResponse(begin);
  const CHUNK = 180;  // safe under negotiated ATT MTU on macOS/Chrome.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    const frame = new Uint8Array(slice.length + 1);
    frame[0] = 0x02;
    frame.set(slice, 1);
    await ch.writeValueWithResponse(frame);
  }
  await ch.writeValueWithResponse(new Uint8Array([0x03]));
}

async function buildBundle(entry, manifestUrl) {
  manifestUrl = manifestUrl || entry.fwInfo?.bundle_url;
  const manifest = await (await fetch(freshUrl(manifestUrl), { cache: "no-cache" })).json();
  const files = {};
  for (const spec of manifest.files || []) {
    const src = spec.src;
    const buf = await (await fetch(freshUrl(`firmware/pi_robot/${src}`), { cache: "no-cache" })).arrayBuffer();
    // Chunked to avoid stack overflow from spreading into String.fromCharCode.
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    files[src] = btoa(bin);
  }
  return { manifest, files };
}

// Direct HTTP POST to the ESP32's /ota endpoint over the local network. First
// call triggers Chrome's Private Network Access prompt when the target is a
// private IP; on allow the POST proceeds, on deny/timeout/error we return false
// and the caller falls back to BLE-stream.
async function pnaOtaUpload(entry, bytes) {
  const ip = entry.wifiStatus?.ip;
  if (!ip) return false;
  const url = `http://${ip}/ota`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    logFor(entry, `PNA direct OTA → ${url} (${bytes.length} B)`);
    const resp = await fetch(url, {
      method: "POST",
      mode: "cors",
      body: bytes,
      headers: { "Content-Type": "application/octet-stream" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      logFor(entry, `PNA returned ${resp.status}`);
      return false;
    }
    logFor(entry, "PNA OTA committed — robot restarting");
    return true;
  } catch (err) {
    clearTimeout(timer);
    logFor(entry, `PNA failed: ${err.message}`);
    return false;
  }
}

export async function updateFirmware(id) {
  const entry = state.devices.get(id);
  if (!entry || !entry.otaDataChar) {
    log("Update not supported by this firmware");
    return;
  }

  // Pi path: bundle-only OTA. Falls back to the default manifest URL when
  // fw-info wouldn't parse — lets us unstick a Pi whose FW_INFO read is
  // truncated by an MTU issue (otaDataChar still present).
  const bundleUrl = entry.fwInfo?.bundle_url
    || (entry.otaDataChar && !entry.fwInfo?.url ? "firmware/pi_robot/ota-manifest.json" : null);
  if (bundleUrl) {
    logFor(entry, `fetching bundle (${bundleUrl})…`);
    let bytes;
    try {
      const bundle = await buildBundle(entry, bundleUrl);
      bytes = new TextEncoder().encode(JSON.stringify(bundle));
      const stamp = bundle.manifest.commit ? ` · commit ${bundle.manifest.commit}` : "";
      logFor(entry, `bundle ready: ${bundle.manifest.files.length} files, ${bytes.length} B${stamp}`);
    } catch (err) {
      logFor(entry, `bundle build failed: ${err.message}`);
      return;
    }
    await acquireWakeLock();
    try {
      logFor(entry, `OTA streaming bundle ${bytes.length} B…`);
      try {
        await streamOtaBytes(entry, bytes);
        logFor(entry, "OTA commit sent — robot applying bundle");
      } catch (err) {
        logFor(entry, `OTA failed: ${err.message}`);
      }
    } finally {
      await releaseWakeLock();
    }
    return;
  }

  // ESP32 path: single-binary OTA. Pis no longer expose `url` — only ESP32 does.
  const fetchUrl = entry.fwInfo?.url;
  if (!fetchUrl) {
    logFor(entry, "no firmware source (fw-info missing url / bundle_url)");
    return;
  }
  logFor(entry, `fetching ${fetchUrl}…`);
  let bytes;
  try {
    const resp = await fetch(freshUrl(fetchUrl), { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    bytes = new Uint8Array(await resp.arrayBuffer());
  } catch (err) {
    logFor(entry, `fetch failed: ${err.message}`);
    return;
  }
  await acquireWakeLock();
  try {
    // PNA-direct: dashboard POSTs the bin to the ESP32's /ota endpoint over
    // the local network (~seconds). On deny/timeout/error, fall back to
    // BLE-stream (~30s with WithoutResponse chunks).
    if (entry.fwInfo?.type === "esp32"
        && entry.wifiStatus?.st === "joined"
        && entry.wifiStatus?.ip) {
      if (await pnaOtaUpload(entry, bytes)) return;
    }
    logFor(entry, `OTA streaming over BLE (~30s for ~1.6 MB)…`);
    try {
      await streamOtaBytes(entry, bytes);
      logFor(entry, "OTA commit sent — robot restarting");
    } catch (err) {
      logFor(entry, `OTA failed: ${err.message}`);
    }
  } finally {
    await releaseWakeLock();
  }
}

export async function updateFromFile(id) {
  const entry = state.devices.get(id);
  if (!entry || !entry.otaDataChar) {
    log("Update not supported by this firmware");
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".py,.bin";
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Local file — always BLE-stream. data:/blob: URLs aren't reachable from the ESP32.
    logFor(entry, `OTA streaming ${file.name} (${bytes.length} B)…`);
    await acquireWakeLock();
    try {
      await streamOtaBytes(entry, bytes);
      logFor(entry, "OTA commit sent — robot restarting");
    } catch (err) {
      logFor(entry, `OTA failed: ${err.message}`);
    } finally {
      await releaseWakeLock();
    }
  });
  input.click();
}

export const ota = {
  name: "ota",
  schema: { type: "bundle-ota" },
  initEntry: () => ({
    otaDataChar: null, otaStatusChar: null,
    otaStatus: { st: "idle" }, fwInfo: null,
  }),

  async probe(entry, service) {
    try {
      entry.otaDataChar   = await service.getCharacteristic(OTA_DATA_CHAR_UUID);
      entry.otaStatusChar = await service.getCharacteristic(OTA_STATUS_CHAR_UUID);
      // fw-info is read once in app.js connect() before any capability probe.
      entry.otaStatus = decodeJson(await entry.otaStatusChar.readValue()) || { st: "idle" };
      await entry.otaStatusChar.startNotifications();
      entry.otaStatusChar.addEventListener("characteristicvaluechanged", (e) => {
        entry.otaStatus = decodeJson(e.target.value) || { st: "idle" };
        const { st, n = 0, total = 0, err: errMsg } = entry.otaStatus;
        const pct = total ? Math.round(100 * n / total) : 0;
        logFor(entry, `OTA ${st}${total ? ` ${pct}%` : ""}${errMsg ? ` — ${errMsg}` : ""}`);
        renderEntry(entry);
      });
    } catch {
      entry.otaDataChar = null;
    }
  },

  cleanup(entry) {
    entry.otaDataChar = entry.otaStatusChar = null;
    entry.fwInfo = null;
  },

  // OTA controls live in the ⋯ menu; app.js wires them to updateFirmware/updateFromFile.
  renderSection() { return ""; },
  wireActions() {},
};
