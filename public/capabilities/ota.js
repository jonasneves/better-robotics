// Routes updates to the right data plane: ESP32 + WiFi joined → PNA-direct
// HTTP POST to the robot's /ota endpoint (dashboard pushes over WiFi, seconds);
// otherwise BLE stream with flow-controlled WithoutResponse chunk writes.
import {
  OTA_DATA_CHAR_UUID, OTA_STATUS_CHAR_UUID,
  decodeJson, encodeJson,
} from "../ble.js";
import { freshUrl, escapeHtml, fetchWithTimeout } from "../dom.js";
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
  const payload = encodeJson(bundle);
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

// Injected from app.js to avoid a circular import. Called right after a
// commit succeeds (PNA or BLE) so app.js's onDisconnected handler knows
// the upcoming BLE drop is the firmware rebooting and can auto-retry the
// connection instead of leaving the entry idle for the user to click.
let _markExpectingReconnect = () => {};
export function setExpectingReconnectHandler(fn) { _markExpectingReconnect = fn; }

// Patch the existing OTA section's text/progress in place. Avoids rebuilding
// the card's innerHTML on every progress tick (which would destroy hovered
// elements and flicker). Falls back to a full re-render if the section isn't
// in the DOM (collapsed card, or the section hasn't been created yet).
//
// Two progress signals: entry.otaSent (browser, per-chunk, accurate) and
// entry.otaStatus.n (firmware notify, throttled every 32 KB / 250 ms).
// Math.max picks whichever is higher — sent leads during active uploads,
// firmware-reported wins on post-refresh reconnect when sent is back to 0.
// Label upgrades to "committing" client-side once we've sent everything but
// the firmware hasn't notified "done" yet — so the bar doesn't sit at "100%
// receiving" while we wait the install round-trip.
function patchOtaSection(entry) {
  const section = entry.node?.querySelector(".ota-section");
  if (!section) { renderEntry(entry); return; }
  const { st, n: confirmed = 0, total = 0, err } = entry.otaStatus || {};
  const sent = entry.otaSent || 0;
  const display = Math.max(sent, confirmed);
  const pct = total ? Math.round(100 * display / total) : 0;
  const looksDone = total && sent >= total;
  const label = looksDone && (st === "receiving" || !st) ? "committing" : (st || "idle");
  const meta = section.querySelector(".meta");
  if (meta) meta.textContent = err ? `${st} — ${err}` : total ? `${label} · ${pct}%` : label;
  const progress = section.querySelector(".ota-progress");
  if (progress && total) { progress.value = display; progress.max = total; }
  // Mirror progress into the active-ops chip on the identity row, so the
  // top-level "OTA receiving N%" stays in sync with the inline section.
  // Without this the chip stayed frozen at 0% (only renderEntry rebuilds
  // the chips and the upload path patches the section, not the chip).
  const chip = entry.node?.querySelector('.op-chip[data-op="ota"]');
  if (chip) chip.textContent = total ? `OTA ${label} ${pct}%` : `OTA ${label}`;
}

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

// Coalesce per-chunk patchOtaSection calls to one paint per frame. A 1.6 MB
// OTA fires ~9000 chunks; without throttling that's ~9000 querySelector +
// DOM-write tuples for an animation that the screen can't show faster than
// ~60 fps anyway. RAF caps us at ~60 paints/sec naturally and drops the rest.
let _otaPendingPatch = false;
function patchOtaSectionThrottled(entry) {
  if (_otaPendingPatch) return;
  _otaPendingPatch = true;
  requestAnimationFrame(() => {
    _otaPendingPatch = false;
    patchOtaSection(entry);
  });
}

// Stream the bundle to the robot's WebRTC peer over a DataChannel.
//
// Pi flow: RTC daemon (low priv `robot` user) stages to /tmp/...json,
// replies "staged"; we then BLE-trigger apply-staged-ota which the root
// pi_robot.py service picks up and applies. Two-step because privilege
// boundaries — bulk transfer at user privs, apply at root privs.
//
// ESP32 flow: webrtc_peer.c routes the channel directly into the same
// esp_ota_* state as BLE/HTTP OTA. On commit, the chip restarts itself
// 500 ms after sending "staged". No apply-staged-ota call — the chip is
// already rebooting; trying to BLE-write would fail and confuse the
// dashboard. The "staged" reply doubles as "we're about to reboot."
//
// Throws on any failure — caller falls back to BLE-stream.
async function streamOtaViaWebRTC(entry, bytes) {
  // Pi requires the ops channel to trigger the privileged apply. ESP32
  // commits inline (see comment above), so the ops channel is unused.
  if (entry.fwType === "pi" && !entry.opsChar) {
    throw new Error("no ops channel — can't trigger apply");
  }
  const { openChannel, closePeer } = await import("../webrtc-robot.js");
  let channel;
  try {
    channel = await openChannel(entry.id, entry.name, "ota", {
      onStatus: (s) => logFor(entry, `ota webrtc: ${s}`),
      robotType: entry.fwType,
      signalChar: entry.signalChar,
    });
  } catch (err) {
    throw new Error(`webrtc open: ${err.message || err}`);
  }
  try {
    channel.binaryType = "arraybuffer";
    // Pi RTC replies with {type:"staged"} when the file is closed and
    // sized correctly; resolve the staging step on that. {type:"error"}
    // surfaces from the Pi side (write/open failure, size mismatch).
    const stagedAck = new Promise((resolve, reject) => {
      const onMsg = (e) => {
        if (typeof e.data !== "string") return;
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === "staged") { channel.removeEventListener("message", onMsg); resolve(msg); }
        else if (msg.type === "error") { channel.removeEventListener("message", onMsg); reject(new Error(msg.error)); }
      };
      channel.addEventListener("message", onMsg);
      // Bound the wait — 60 s covers a 1.6 MB transfer easily; longer
      // than that means the Pi is wedged or never sending the ack.
      setTimeout(() => reject(new Error("staged ack timeout")), 60000);
    });

    logFor(entry, `ota webrtc: channel state=${channel.readyState}, sending begin`);
    channel.send(JSON.stringify({ type: "begin", size: bytes.length }));

    // Give the begin message a moment to land before flooding chunks —
    // helps observability of any "begin lost" failure mode by separating
    // it in time from the bulk data sends.
    await new Promise((r) => setTimeout(r, 50));
    logFor(entry, `ota webrtc: post-begin state=${channel.readyState} buffered=${channel.bufferedAmount}`);

    // Chunk size: keep below SCTP's default max-message limit (16 KB
    // is the universal floor across Chrome / aiortc; both can negotiate
    // higher via sctp.maxMessageSize but 16 KB always works).
    const CHUNK = 16 * 1024;
    entry.otaSent = 0;
    patchOtaSection(entry);
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
      channel.send(slice);
      entry.otaSent = i + slice.length;
      patchOtaSectionThrottled(entry);
      // Backpressure: queue can grow unbounded if we send faster than
      // SCTP drains. Pause when buffered amount climbs past 1 MB.
      while (channel.bufferedAmount > 1 * 1024 * 1024) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    logFor(entry, `ota webrtc: all chunks sent, sending commit`);
    channel.send(JSON.stringify({ type: "commit" }));
    await stagedAck;
    entry.otaSent = bytes.length;
    patchOtaSection(entry);

    if (entry.fwType === "pi") {
      // Pi-only: trigger the privileged apply. The existing _apply_bundle
      // path runs as root and drives the OTA status notifies the dashboard
      // already renders. Body matches the apply-staged-ota verb's args
      // shape (path is allowlisted on the Pi side).
      const applyMsg = encodeJson({
        op: "apply-staged-ota",
        args: { path: "/tmp/pi-robot-staged-ota.json" },
      });
      await entry.opsChar.writeValueWithResponse(applyMsg);
    }
    // ESP32: chip is restarting on its own; nothing more to do.
  } finally {
    try { channel?.close(); } catch {}
    closePeer(entry.id);
  }
}

async function streamOtaBytes(entry, bytes) {
  const ch = entry.otaDataChar;
  // All chunks go WithResponse. WithoutResponse speedup was observed
  // dropping chunks silently on both bless (Pi) and arduino-esp32, making
  // Update.end fail at commit time — the firmware's otaReceived counter
  // only advances on writes that actually arrived, so a small silent drop
  // never trips the in-flight stall check but accumulates by commit. Until
  // we have a proper drop-detect-and-resend protocol, WithResponse is the
  // correct default: slower (ESP32 1.6 MB ≈ 3-5 min) but reliable.
  entry.otaSent = 0;
  patchOtaSection(entry);
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
    // Per-chunk increment + RAF-coalesced patch — accurate (the ack means
    // the firmware processed the chunk, since ATT_WRITE_RSP is sent post-
    // callback) and cheap (one paint per frame, not 9000 paints over 30s).
    entry.otaSent = i + slice.length;
    patchOtaSectionThrottled(entry);
  }
  await ch.writeValueWithResponse(new Uint8Array([0x03]));
  entry.otaSent = bytes.length;
  patchOtaSection(entry);  // final state — render synchronously, not throttled.
}

async function buildBundle(entry, manifestUrl) {
  manifestUrl = manifestUrl || entry.fwInfo?.bundle_url;
  const manifest = await (await fetchWithTimeout(freshUrl(manifestUrl), { cache: "no-cache" })).json();
  // Files are independent — fetch in parallel. Order in `files` object is
  // preserved (Promise.all + map) so the firmware sees them in manifest order.
  const entries = await Promise.all((manifest.files || []).map(async (spec) => {
    const src = spec.src;
    // 60s per file — bundle binaries can be a few MB on a slow connection.
    const buf = await (await fetchWithTimeout(freshUrl(`firmware/pi_robot/${src}`), { cache: "no-cache" }, 60000)).arrayBuffer();
    // Chunked to avoid stack overflow from spreading into String.fromCharCode.
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return [src, btoa(bin)];
  }));
  return { manifest, files: Object.fromEntries(entries) };
}

// Direct HTTP POST to the ESP32's /ota endpoint over the local network. First
// call triggers Chrome's Private Network Access prompt when the target is a
// private IP; on allow the POST proceeds, on deny/timeout/error we return false
// and the caller falls back to BLE-stream.
async function pnaOtaUpload(entry, bytes) {
  const ip = entry.wifiStatus?.ip;
  if (!ip) return false;
  // Port 81 — the firmware's HTTP server runs on :81 (same listener that
  // serves /stream). Default port 80 lands on nothing → ERR_CONNECTION_REFUSED.
  const url = `http://${ip}:81/ota`;

  // Render the OTA card immediately so the user sees the upload happen.
  // Without this, PNA looks silent — BLE-stream gets per-chunk firmware
  // notifies that drive entry.otaStatus.n; PNA doesn't, so the only
  // feedback would be log lines. XHR over fetch() because XHR's
  // upload.onprogress reports bytes-sent during the POST body —
  // fetch() can't, without HTTP/2 streaming bodies that our plain
  // HTTP/1.1 ESP32 server doesn't accept. Same PNA preflight + CORS
  // semantics apply to XHR as to fetch.
  entry.otaSent = 0;
  entry.otaStatus = { st: "receiving (PNA)", n: 0, total: bytes.length };
  patchOtaSection(entry);

  logFor(entry, `PNA direct OTA → ${url} (${bytes.length} B)`);
  try {
    const status = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      // 180 s — classic ESP32-CAM with 1-of-4 WiFi RX buffers under BLE
      // coexistence sustains ~50-100 KB/s practical RX throughput. 1.6 MB
      // ÷ 50 KB/s ≈ 32 s on a good day, but household WiFi with neighbour
      // contention can drop the chip to 10-20 KB/s and a single retry
      // burns most of the budget. 180 s gives both attempts headroom.
      xhr.timeout = 180000;
      xhr.upload.addEventListener("progress", (e) => {
        if (!e.lengthComputable) return;
        entry.otaSent = e.loaded;
        patchOtaSectionThrottled(entry);
      });
      xhr.onload = () => resolve(xhr.status);
      xhr.onerror = () => reject(new Error("network error"));
      xhr.ontimeout = () => reject(new Error("timeout"));
      xhr.onabort = () => reject(new Error("aborted"));
      xhr.send(bytes);
    });
    if (status !== 200) {
      logFor(entry, `PNA returned ${status}`);
      entry.otaStatus = { st: "idle" };
      patchOtaSection(entry);
      return false;
    }
    entry.otaSent = bytes.length;
    entry.otaStatus = { st: "committing", n: bytes.length, total: bytes.length };
    patchOtaSection(entry);
    logFor(entry, "PNA OTA committed — robot restarting");
    _markExpectingReconnect(entry.id);
    return true;
  } catch (err) {
    logFor(entry, `PNA failed: ${err.message}`);
    entry.otaStatus = { st: "idle" };
    patchOtaSection(entry);
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
    let bytes, bundle;
    try {
      bundle = await buildBundle(entry, bundleUrl);
      bytes = encodeJson(bundle);
      const stamp = bundle.manifest.commit ? ` · commit ${bundle.manifest.commit}` : "";
      logFor(entry, `bundle ready: ${bundle.manifest.files.length} files, ${bytes.length} B${stamp}`);
    } catch (err) {
      logFor(entry, `bundle build failed: ${err.message}`);
      return;
    }
    // Skip if the published bundle matches what's already running — otherwise
    // the robot reboots pointlessly and the user sees "OTA succeeded" while
    // the commit stamp doesn't change. Most commonly happens when CI or GH
    // Pages hasn't caught up to the latest push yet.
    if (bundle.manifest.commit && entry.fwInfo?.version
        && bundle.manifest.commit === entry.fwInfo.version) {
      logFor(entry, `already at commit ${bundle.manifest.commit} — nothing to update (CI may still be building)`);
      return;
    }
    await acquireWakeLock();
    try {
      logFor(entry, `OTA streaming bundle ${bytes.length} B…`);
      // Prefer WebRTC for Pi bundles — minutes (BLE chunked) → seconds
      // (WebRTC P2P) for 1.6 MB. Falls back to BLE-stream on any error
      // (peer not running, network blocked, etc.) so existing OTA path
      // is preserved as the safety net.
      let webrtcOk = false;
      try {
        await streamOtaViaWebRTC(entry, bytes);
        webrtcOk = true;
        logFor(entry, "OTA staged + apply triggered — robot applying bundle");
        _markExpectingReconnect(entry.id);
      } catch (err) {
        logFor(entry, `WebRTC OTA failed: ${err.message} — falling back to BLE`);
      }
      if (!webrtcOk) {
        try {
          await streamOtaBytes(entry, bytes);
          logFor(entry, "OTA commit sent — robot applying bundle");
          _markExpectingReconnect(entry.id);
        } catch (err) {
          logFor(entry, `OTA failed: ${err.message}`);
        }
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
    // 60s — firmware bundle can be a few MB on slow connections.
    const resp = await fetchWithTimeout(freshUrl(fetchUrl), { cache: "no-cache" }, 60000);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    bytes = new Uint8Array(await resp.arrayBuffer());
  } catch (err) {
    logFor(entry, `fetch failed: ${err.message}`);
    return;
  }
  await acquireWakeLock();
  try {
    // Three transports for ESP32 OTA, fastest first:
    //   1. WebRTC P2P (BLE-signaled or wss): seconds, no Mixed-Content
    //      / PNA exposure. ESP32 firmware commits inline and restarts;
    //      we get a "staged" reply, then the BLE link drops as the chip
    //      reboots into the new firmware.
    //   2. PNA HTTP /ota: seconds on a network that allows Private
    //      Network Access. Fails with "PNA failed: network error" on
    //      browsers / configurations that don't.
    //   3. BLE-stream: slow (~30s for 1.6 MB) but works anywhere.
    let webrtcOk = false;
    try {
      await streamOtaViaWebRTC(entry, bytes);
      webrtcOk = true;
      logFor(entry, "OTA committed via WebRTC — robot restarting");
      _markExpectingReconnect(entry.id);
    } catch (err) {
      logFor(entry, `WebRTC OTA failed: ${err.message} — trying PNA`);
    }
    if (!webrtcOk
        && entry.fwInfo?.type === "esp32"
        && entry.wifiStatus?.st === "joined"
        && entry.wifiStatus?.ip) {
      if (await pnaOtaUpload(entry, bytes)) return;
    }
    if (!webrtcOk) {
      logFor(entry, `OTA streaming over BLE (~30s for ~1.6 MB)…`);
      try {
        await streamOtaBytes(entry, bytes);
        logFor(entry, "OTA commit sent — robot restarting");
        _markExpectingReconnect(entry.id);
      } catch (err) {
        logFor(entry, `OTA failed: ${err.message}`);
      }
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
      _markExpectingReconnect(entry.id);
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
      const initial = decodeJson(await entry.otaStatusChar.readValue()) || { st: "idle" };
      entry.otaStatus = initial;
      // Orphaned-state cleanup: if the firmware reports an in-progress upload
      // (receiving / committing) but this dashboard session didn't initiate
      // one, that's a tombstone from a previous session that got interrupted
      // (refresh during OTA, BLE drop mid-stream, etc.). Send the 0x00 reset
      // opcode so the firmware drops its half-buffer and the next intentional
      // OTA starts clean — and the user doesn't see a misleading "receiving
      // 1%" frozen on the card forever.
      if (initial.st === "receiving" || initial.st === "committing") {
        try {
          await entry.otaDataChar.writeValueWithResponse(new Uint8Array([0x00]));
          entry.otaStatus = { st: "idle" };
          logFor(entry, `cleared orphaned OTA state (was ${initial.st} ${initial.n || 0}/${initial.total || 0} B)`);
        } catch { /* if write fails, fall back to displaying the orphaned state — still better than freezing */ }
      }
      await entry.otaStatusChar.startNotifications();
      entry.otaStatusChar.addEventListener("characteristicvaluechanged", (e) => {
        const prevSt = entry.otaStatus?.st || "idle";
        entry.otaStatus = decodeJson(e.target.value) || { st: "idle" };
        const { st, err: errMsg } = entry.otaStatus;
        // Log only terminal transitions (error / done / back-to-idle) — every
        // percent-tick would spam the log pane.
        if (errMsg) logFor(entry, `OTA ${st} — ${errMsg}`);
        else if (st === "done" || st === "idle") logFor(entry, `OTA ${st}`);
        // Section appears/disappears on the idle↔active boundary, so a full
        // re-render is needed there. Progress within the same active window
        // patches the existing DOM so hovered elements don't flicker.
        const wasActive = prevSt !== "idle";
        const nowActive = st !== "idle";
        if (wasActive !== nowActive) renderEntry(entry);
        else if (nowActive) patchOtaSection(entry);
      });
    } catch {
      entry.otaDataChar = null;
    }
  },

  cleanup(entry) {
    entry.otaDataChar = entry.otaStatusChar = null;
    entry.fwInfo = null;
  },

  // OTA controls live in the ⋯ menu; the section only appears while an update
  // is actually in flight so the card shows progress without claiming permanent
  // screen real estate.
  renderSection(entry) {
    const s = entry?.otaStatus;
    if (!s || s.st === "idle") return "";
    const { st, n = 0, total = 0, err } = s;
    const pct = total ? Math.round(100 * n / total) : 0;
    const stateLine = err
      ? `${escapeHtml(st)} — ${escapeHtml(err)}`
      : total ? `${escapeHtml(st)} · ${pct}%`
      : escapeHtml(st);
    // `.ota-section` marker lets the progress handler patch this in place
    // instead of rebuilding the whole card's innerHTML on every OTA notify.
    return `
      <div class="robot-controls ota-section">
        <div class="row">
          <div><div class="label">Firmware</div><div class="meta">${stateLine}</div></div>
        </div>
        ${total ? `<progress class="ota-progress" value="${n}" max="${total}"></progress>` : ""}
      </div>
    `;
  },
  wireActions() {},
};
