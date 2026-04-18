// OTA capability. Two characteristics for the transfer (ota-data, ota-status)
// plus one read-only (fw-info) that declares the firmware's type and where to
// fetch its binary. Updates route to the right data plane: ESP32 + WiFi
// joined → BLE-signaled URL-trigger (robot pulls over WiFi, 20-60x faster);
// otherwise full BLE stream. OTA has no card section — the actions sit in
// the ⋯ menu, exposed as updateFirmware / updateFromFile exports.
import {
  OTA_DATA_CHAR_UUID, OTA_STATUS_CHAR_UUID, FW_INFO_CHAR_UUID,
  decodeJson,
} from "../ble.js";
import { logFor, log } from "../log.js";
import { state } from "../state.js";

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

// Keep the screen (and thus BLE radio's task scheduling) awake during a
// potentially-long OTA. macOS putting the display to sleep has been observed
// to throttle the BLE write loop enough to stall a 10-minute stream.
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

export async function updateFirmware(id) {
  const entry = state.devices.get(id);
  if (!entry || !entry.otaDataChar) {
    log("Update not supported by this firmware");
    return;
  }
  const fetchUrl = entry.fwInfo?.url || "firmware/pi_robot/pi_robot.py";
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
    // URL-trigger path: ESP32 with WiFi joined can pull the binary itself
    // over WiFi — 10 min → 10 sec on a 1.6 MB bin.
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
        // Give the ESP32 ~8 s to start fetching. If status is "failed" in
        // that window the URL-trigger path didn't work (TLS handshake, DNS,
        // connection refused) and we fall back to BLE stream.
        await new Promise(r => setTimeout(r, 8000));
        if (entry.otaStatus?.st !== "failed") return;
        logFor(entry, `URL-trigger failed (${entry.otaStatus.err || "?"}) — falling back to BLE stream`);
      }
    }

    // Fallback: stream the whole binary over BLE.
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
    // Local file — always BLE-stream. URL-trigger needs a URL the robot can
    // reach, and a data:/blob: URL isn't useful to the ESP32.
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
  initEntry: () => ({
    otaDataChar: null, otaStatusChar: null,
    otaStatus: { st: "idle" }, fwInfo: null,
  }),

  async probe(entry, service) {
    try {
      entry.otaDataChar   = await service.getCharacteristic(OTA_DATA_CHAR_UUID);
      entry.otaStatusChar = await service.getCharacteristic(OTA_STATUS_CHAR_UUID);
      try {
        const info = await service.getCharacteristic(FW_INFO_CHAR_UUID);
        entry.fwInfo = decodeJson(await info.readValue());
      } catch {}
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

  // OTA controls live in the ⋯ menu, not the card body. Nothing to render
  // inline; app.js wires the menu to updateFirmware/updateFromFile directly.
  renderSection() { return ""; },
  wireActions() {},
};
