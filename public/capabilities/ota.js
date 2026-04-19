// Routes updates to the right data plane: ESP32 + WiFi joined →
// BLE-signaled URL-trigger (robot pulls over WiFi, 20-60x faster); otherwise
// full BLE stream.
import {
  OTA_DATA_CHAR_UUID, OTA_STATUS_CHAR_UUID,
  decodeJson,
} from "../ble.js";
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
  // Clear any lingering OTA session before starting a fresh one (0x00 abort).
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
  // Query-string cache-bust beats Cache-Control: unique URL bypasses the GH
  // Pages CDN as well as the browser cache. Otherwise a freshly-published
  // manifest can be served stale for a minute after CI finishes.
  const busted = `${manifestUrl}${manifestUrl.includes("?") ? "&" : "?"}v=${Date.now()}`;
  const manifest = await (await fetch(busted, { cache: "no-cache" })).json();
  const files = {};
  for (const spec of manifest.files || []) {
    const src = spec.src;
    const url = `firmware/pi_robot/${src}`;
    const buf = await (await fetch(url, { cache: "no-cache" })).arrayBuffer();
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
    const resp = await fetch(fetchUrl, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    bytes = new Uint8Array(await resp.arrayBuffer());
  } catch (err) {
    logFor(entry, `fetch failed: ${err.message}`);
    return;
  }
  await acquireWakeLock();
  try {
    // URL-trigger: ESP32 pulls the binary itself over WiFi — 10 min → 10 sec
    // on a 1.6 MB bin.
    const canUrlTrigger =
      entry.fwInfo?.type === "esp32" && entry.wifiStatus?.st === "joined";
    if (canUrlTrigger) {
      const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = [...new Uint8Array(hashBuf)]
        .map(b => b.toString(16).padStart(2, "0")).join("");
      const absoluteUrl = new URL(fetchUrl, location.href).toString();
      const payload = JSON.stringify({ url: absoluteUrl, size: bytes.length, sha256 });
      const frame = new Uint8Array(1 + payload.length);
      frame[0] = 0x04;
      frame.set(new TextEncoder().encode(payload), 1);
      logFor(entry, `OTA trigger — will fetch ${bytes.length} B over WiFi`);
      let triggerSent = false;
      try {
        await entry.otaDataChar.writeValueWithResponse(frame);
        triggerSent = true;
      } catch (err) {
        logFor(entry, `OTA trigger failed: ${err.message} — falling back to BLE stream`);
      }
      if (triggerSent) {
        // ~8 s grace window: if status is "failed" by then (TLS/DNS/refused),
        // fall back to BLE stream.
        await new Promise(r => setTimeout(r, 8000));
        if (entry.otaStatus?.st !== "failed") return;
        logFor(entry, `URL-trigger failed (${entry.otaStatus.err || "?"}) — falling back to BLE stream`);
      }
    }

    logFor(entry, `OTA streaming ${bytes.length} B…`);
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
