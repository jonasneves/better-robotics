const SERVICE_UUID          = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d91";
const LED_CHAR_UUID         = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d92";
const WIFI_SCAN_CHAR_UUID   = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d93";
const WIFI_JOIN_CHAR_UUID   = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d94";
const WIFI_STATUS_CHAR_UUID = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d95";
const OTA_DATA_CHAR_UUID    = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d96";
const OTA_STATUS_CHAR_UUID  = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d97";
const FW_INFO_CHAR_UUID     = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d98";
const MOTOR_CHAR_UUID       = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d99";

const decodeJson = (dv) => {
  try {
    const text = new TextDecoder().decode(dv);
    return text ? JSON.parse(text) : null;
  } catch { return null; }
};
const encodeJson = (obj) => new TextEncoder().encode(JSON.stringify(obj));

const $ = (id) => document.getElementById(id);
// Log is a three-column grid (time · name · msg). Name is suppressed on
// older lines in a burst from the same robot so a stream of events reads
// as one group with a single anchor. Adjacent-duplicate coalescing
// rewrites the newest line with a (xN) counter instead of stacking.
let _lastLogNode = null;
let _lastLogMsgNode = null;
let _lastLogNameNode = null;
let _lastLogKey = null;
let _lastLogName = null;
let _lastLogCount = 0;
const _errRe = /\b(fail(?:ed|ure)?|error|rejected|timeout|cancelled|stalled|stuck|not found)\b/i;
const _okRe  = /\b(paired|joined|installed|done|ready|enabled|ok)\b/i;
const _logClass = (msg) => _errRe.test(msg) ? "err" : _okRe.test(msg) ? "ok" : "";
const log = (msg, name = "") => {
  const el = $("log");
  const now = new Date().toLocaleTimeString();
  const key = `${name}|${msg}`;
  if (key === _lastLogKey && _lastLogMsgNode) {
    _lastLogCount++;
    _lastLogMsgNode.textContent = `${msg} (×${_lastLogCount})`;
    return;
  }
  _lastLogKey = key;
  _lastLogCount = 1;
  const line = document.createElement("div");
  const cls = _logClass(msg);
  if (cls) line.className = cls;
  if (!name) line.classList.add("sys");
  const timeSpan = document.createElement("span");
  timeSpan.className = "log-time";
  timeSpan.textContent = now;
  const nameSpan = document.createElement("span");
  nameSpan.className = "log-name";
  nameSpan.textContent = name;
  const msgSpan = document.createElement("span");
  msgSpan.className = "log-msg";
  msgSpan.textContent = msg;
  line.append(timeSpan, nameSpan, msgSpan);
  el.prepend(line);
  // Suppress the previous line's name when this burst continues from it —
  // anchor name stays on the newest line, older siblings go anonymous.
  if (name && name === _lastLogName && _lastLogNameNode) {
    _lastLogNameNode.classList.add("dup");
  }
  _lastLogNode = line;
  _lastLogMsgNode = msgSpan;
  _lastLogNameNode = nameSpan;
  _lastLogName = name;
};
const logFor = (entry, msg) => {
  log(msg, entry.name);
  if (entry.lastEvent !== msg) {
    entry.lastEvent = msg;
    renderEntry(entry);
  }
};

const STORAGE_KEY = "better-robotics:known";
const SETTINGS_KEY = "better-robotics:settings";

// User-tunable feature flags. Persisted in localStorage so the toggle
// survives reloads. Experimental options gate on both the flag AND the
// presence of the underlying browser API — turning on something Chrome
// can't deliver is a no-op, not a crash.
const settings = Object.assign(
  { passiveScan: false },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"),
);
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

const state = {
  // id -> entry (connection + capability handles). Multiple entries can be
  // connected simultaneously — connection state is tracked per-entry via
  // entry.status; there's no single "active" robot.
  devices: new Map(),
};

function persist() {
  const out = [];
  for (const e of state.devices.values()) out.push({ id: e.id, name: e.name });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
}

function loadKnown() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}

function attachDevice(entry, device) {
  entry.device = device;
  device.addEventListener("gattserverdisconnected", () => onDisconnected(entry.id));
}

function makeEntry(id, name) {
  return {
    id, name,
    device: null,
    status: "idle",
    ledChar: null, ledOn: false,
    wifiScanChar: null, wifiJoinChar: null, wifiStatusChar: null,
    wifiStatus: { st: "idle" }, wifiNetworks: null, wifiScanning: false,
    otaDataChar: null, otaStatusChar: null, otaStatus: { st: "idle" }, fwInfo: null,
    motorChar: null, motorLeft: 0, motorRight: 0,
    motorSending: false, motorPending: null,
    lastEvent: null,
    // DOM node for this card. Owned by render()/renderEntry(); null until
    // first mounted. Holding it per-entry is the foundation for the future
    // LLM-orchestrated interface — one state change mutates one card, and
    // a get_robot_state(id) tool can return just this entry without touching
    // siblings. It's also what lets slider drags on one robot survive state
    // changes on other robots.
    node: null,
  };
}

function entryFor(device) {
  const existing = state.devices.get(device.id);
  if (existing) {
    if (!existing.device) attachDevice(existing, device);
    return existing;
  }
  const entry = makeEntry(device.id, device.name || device.id);
  attachDevice(entry, device);
  state.devices.set(device.id, entry);
  persist();
  return entry;
}

async function loadPaired() {
  // Restore remembered robots first — works even when getDevices() is missing.
  for (const { id, name } of loadKnown()) {
    if (!state.devices.has(id)) state.devices.set(id, makeEntry(id, name));
  }
  // Reattach live BluetoothDevice objects if the browser exposes them.
  if (navigator.bluetooth.getDevices) {
    try {
      const paired = await navigator.bluetooth.getDevices();
      paired.forEach(entryFor);
    } catch (err) {
      log(`Could not list paired devices: ${err.message}`);
    }
  }
  render();
}

async function scanForNew() {
  if (settings.passiveScan && navigator.bluetooth.requestLEScan) {
    return scanForNewPassive();
  }
  try {
    // If ?robot=X hint is in the URL and that robot isn't already paired,
    // pre-filter the chooser by name — saves the user from picking out of
    // a crowd. (Classroom: scan QR label → chooser shows one entry.)
    const hintedName = new URLSearchParams(location.search).get("robot");
    const useHint = hintedName
      && ![...state.devices.values()].some(e => e.name === hintedName);
    const filter = useHint
      ? { name: hintedName, services: [SERVICE_UUID] }
      : { services: [SERVICE_UUID] };
    const device = await navigator.bluetooth.requestDevice({ filters: [filter] });
    const name = device.name || device.id;
    entryFor(device);
    log("paired", name);
    render();
    connect(device.id);
  } catch (err) {
    if (err.name !== "NotFoundError") log(`Scan error: ${err.message}`);
  }
}

// Passive BLE scan (experimental). Uses navigator.bluetooth.requestLEScan,
// which requires the --enable-experimental-web-platform-features Chrome flag.
// Unlike requestDevice (which always shows the chooser), passive scan emits
// advertisement events for every matching device — the user sees robots
// appear in real time. Pairing still needs requestDevice; we call it with a
// name filter once the user picks from the discovered list, so the chooser
// is pre-filtered to the single intended target.
let _discoverState = { scanning: false, found: new Map(), scanHandle: null };

async function scanForNewPassive() {
  if (_discoverState.scanning) return;
  _discoverState.scanning = true;
  _discoverState.found = new Map();
  renderDiscovered();
  const onAdv = (event) => {
    const name = event.device.name;
    if (!name) return;
    const prev = _discoverState.found.get(name);
    _discoverState.found.set(name, {
      name,
      id: event.device.id,
      rssi: event.rssi || prev?.rssi || 0,
    });
    renderDiscovered();
  };
  navigator.bluetooth.addEventListener("advertisementreceived", onAdv);
  try {
    _discoverState.scanHandle = await navigator.bluetooth.requestLEScan({
      filters: [{ services: [SERVICE_UUID] }],
      keepRepeatedDevices: false,
    });
    log("Passive scan started — watching for 15 s");
    await new Promise(r => setTimeout(r, 15000));
  } catch (err) {
    log(`Passive scan error: ${err.message}`);
  } finally {
    navigator.bluetooth.removeEventListener("advertisementreceived", onAdv);
    try { _discoverState.scanHandle?.stop(); } catch {}
    _discoverState.scanning = false;
    renderDiscovered();
  }
}

async function pairDiscovered(name) {
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ name, services: [SERVICE_UUID] }],
    });
    entryFor(device);
    log("paired", name);
    _discoverState.found.delete(name);
    render();
    renderDiscovered();
    connect(device.id);
  } catch (err) {
    if (err.name !== "NotFoundError") log(`Pair error: ${err.message}`);
  }
}

function renderDiscovered() {
  const box = $("discovered");
  const already = new Set([...state.devices.values()].map(e => e.name));
  const list = [..._discoverState.found.values()]
    .filter(d => !already.has(d.name))
    .sort((a, b) => b.rssi - a.rssi);
  const show = _discoverState.scanning || list.length > 0;
  box.hidden = !show;
  if (!show) { box.innerHTML = ""; return; }
  box.innerHTML = `
    <div class="label" style="margin-bottom: 8px;">
      Discovered ${_discoverState.scanning ? "(scanning…)" : ""}
    </div>
    ${list.length === 0 ? `<div class="meta">No new robots heard yet.</div>` : ""}
    <div class="wifi-list">
      ${list.map(d => `
        <div class="wifi-row">
          <div>
            <div>${escapeHtml(d.name)}</div>
            <div class="meta">RSSI ${d.rssi}</div>
          </div>
          <button class="secondary sm" data-pair-name="${escapeHtml(d.name)}">Pair</button>
        </div>
      `).join("")}
    </div>
  `;
  box.querySelectorAll("[data-pair-name]").forEach(btn => {
    btn.addEventListener("click", () => pairDiscovered(btn.dataset.pairName));
  });
}

async function restoreDevice(entry) {
  // Ask the user to pick this robot again — chooser shows, filtered to the saved name.
  // Necessary on browsers that don't expose navigator.bluetooth.getDevices().
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ name: entry.name, services: [SERVICE_UUID] }],
  });
  attachDevice(entry, device);
}

async function connect(id) {
  const entry = state.devices.get(id);
  if (!entry) return;

  if (!entry.device) {
    try {
      log("reconnecting…", entry.name);
      await restoreDevice(entry);
    } catch (err) {
      if (err.name !== "NotFoundError") logFor(entry, `reconnect cancelled: ${err.message}`);
      return;
    }
  }

  entry.status = "connecting";
  renderEntry(entry);

  try {
    const server = await entry.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const ch = await service.getCharacteristic(LED_CHAR_UUID);
    entry.ledChar = ch;

    const value = await ch.readValue();
    entry.ledOn = value.getUint8(0) !== 0;

    await ch.startNotifications();
    ch.addEventListener("characteristicvaluechanged", (e) => {
      entry.ledOn = e.target.value.getUint8(0) !== 0;
      renderEntry(entry);
      logFor(entry, `LED → ${entry.ledOn ? "on" : "off"}`);
    });

    entry.status = "connected";

    // WiFi characteristics are optional — older firmwares may not expose them.
    try {
      entry.wifiScanChar   = await service.getCharacteristic(WIFI_SCAN_CHAR_UUID);
      entry.wifiJoinChar   = await service.getCharacteristic(WIFI_JOIN_CHAR_UUID);
      entry.wifiStatusChar = await service.getCharacteristic(WIFI_STATUS_CHAR_UUID);
      entry.wifiStatus = decodeJson(await entry.wifiStatusChar.readValue()) || { st: "idle" };
      await entry.wifiStatusChar.startNotifications();
      entry.wifiStatusChar.addEventListener("characteristicvaluechanged", (e) => {
        entry.wifiStatus = decodeJson(e.target.value) || { st: "idle" };
        const { st, ssid, err: errMsg } = entry.wifiStatus;
        logFor(entry, `WiFi ${st}${ssid ? ` [${ssid}]` : ""}${errMsg ? ` — ${errMsg}` : ""}`);
        renderEntry(entry);
      });
      await entry.wifiScanChar.startNotifications();
      entry.wifiScanChar.addEventListener("characteristicvaluechanged", (e) => {
        entry.wifiNetworks = decodeJson(e.target.value) || [];
        entry.wifiScanning = false;
        renderEntry(entry);
      });
    } catch {
      entry.wifiScanChar = null;  // robot has no WiFi onboarding — that's fine.
    }

    // OTA: also optional on older firmwares.
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

    // Motors: optional on older firmwares.
    try {
      entry.motorChar = await service.getCharacteristic(MOTOR_CHAR_UUID);
      const cur = await entry.motorChar.readValue();
      entry.motorLeft = cur.getInt8(0);
      entry.motorRight = cur.getInt8(1);
      await entry.motorChar.startNotifications();
      entry.motorChar.addEventListener("characteristicvaluechanged", (e) => {
        const l = e.target.value.getInt8(0);
        const r = e.target.value.getInt8(1);
        // Notify fires on changes only — most interesting when the watchdog
        // cuts motors to zero after silence.
        if (l !== entry.motorLeft || r !== entry.motorRight) {
          if (l === 0 && r === 0 && (entry.motorLeft || entry.motorRight)) {
            log("motors stopped (watchdog)", entry.name);
          }
          entry.motorLeft = l;
          entry.motorRight = r;
          renderEntry(entry);
        }
      });
    } catch {
      entry.motorChar = null;
    }
  } catch (err) {
    entry.status = "error";
    logFor(entry, `connect failed: ${err.message}`);
  }
  renderEntry(entry);
}

async function disconnect(id) {
  const entry = state.devices.get(id);
  if (entry && entry.device && entry.device.gatt.connected) entry.device.gatt.disconnect();
  onDisconnected(id);
}

function onDisconnected(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  entry.status = "idle";
  entry.ledChar = null;
  entry.wifiScanChar = entry.wifiJoinChar = entry.wifiStatusChar = null;
  entry.wifiNetworks = null;
  entry.wifiScanning = false;
  entry.otaDataChar = entry.otaStatusChar = null;
  entry.fwInfo = null;
  entry.motorChar = null;
  entry.motorLeft = entry.motorRight = 0;
  renderEntry(entry);
}

async function forgetDevice(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  // Resolve a BluetoothDevice handle if we don't already have one. Without
  // this, our Forget only clears localStorage and Chrome keeps the device
  // in its per-origin paired list — you'd see it come back as "Paired" in
  // the next requestDevice chooser.
  let device = entry.device;
  if (!device && navigator.bluetooth.getDevices) {
    try {
      const all = await navigator.bluetooth.getDevices();
      device = all.find(d => d.id === id);
    } catch {}
  }
  if (device) {
    if (device.gatt?.connected) device.gatt.disconnect();
    if (device.forget) {
      try { await device.forget(); } catch {}  // Chrome 114+, ignore if unsupported
    }
  }
  const name = entry.name;
  state.devices.delete(id);
  persist();
  log("forgotten", name);
  render();
}

async function scanWifi(id) {
  const entry = state.devices.get(id);
  if (!entry || !entry.wifiScanChar) return;
  entry.wifiScanning = true;
  renderEntry(entry);
  try {
    // Triggers a rescan on the device; we also get the cached value right now.
    const v = await entry.wifiScanChar.readValue();
    const cached = decodeJson(v);
    if (cached && cached.length) {
      entry.wifiNetworks = cached;
      renderEntry(entry);
    }
    // Fresh results arrive via the scan notification handler.
  } catch (err) {
    entry.wifiScanning = false;
    logFor(entry, `WiFi scan failed: ${err.message}`);
    renderEntry(entry);
  }
}

async function joinWifi(id, ssid, secured) {
  const entry = state.devices.get(id);
  if (!entry || !entry.wifiJoinChar) return;
  let password = "";
  if (secured) {
    password = prompt(`Password for ${ssid}:`);
    if (password === null) return;
  }
  try {
    await entry.wifiJoinChar.writeValueWithResponse(encodeJson({ s: ssid, p: password }));
  } catch (err) {
    logFor(entry, `WiFi join failed: ${err.message}`);
  }
}

// Keep the screen (and therefore the BLE radio's task scheduling) awake
// while a potentially-long OTA runs. macOS putting the display to sleep
// has been observed to throttle the BLE write loop enough to stall a
// 10-minute stream. Auto-released on tab hide; we don't re-acquire since
// user has probably bailed on the transfer by then.
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
  // Clear any lingering OTA session before we start a fresh one (opcode 0x00).
  try { await ch.writeValueWithResponse(new Uint8Array([0x00])); } catch {}
  const begin = new Uint8Array(5);
  begin[0] = 0x01;
  new DataView(begin.buffer).setUint32(1, bytes.length, false);
  await ch.writeValueWithResponse(begin);
  const CHUNK = 180;  // safe under the negotiated ATT MTU on macOS/Chrome.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    const frame = new Uint8Array(slice.length + 1);
    frame[0] = 0x02;
    frame.set(slice, 1);
    await ch.writeValueWithResponse(frame);
  }
  await ch.writeValueWithResponse(new Uint8Array([0x03]));
}

async function updateFirmware(id) {
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
    // Route to the right data plane: if the robot has WiFi joined and
    // advertises a URL-trigger-capable firmware, send a small BLE command and
    // let the robot pull the binary itself over WiFi. 10 min → 10 sec on the
    // ESP32's 1.6 MB bin.
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
        // Give the ESP32 ~8 seconds to start fetching. It should transition
        // through "fetching" → "receiving" quickly; if status is "failed"
        // in that window the URL-trigger path didn't work (TLS handshake,
        // DNS, connection refused, etc) and we fall back to BLE stream.
        await new Promise(r => setTimeout(r, 8000));
        if (entry.otaStatus?.st !== "failed") return;
        logFor(entry, `URL-trigger failed (${entry.otaStatus.err || "?"}) — falling back to BLE stream`);
      }
      // fall through to BLE stream
    }

    // Fallback: stream the whole binary over BLE (Pi always, or ESP32 offline).
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

async function updateFromFile(id) {
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
    // Local file — always BLE-stream. URL-trigger needs a URL the robot
    // can reach, and a data:/blob: URL isn't useful to the ESP32.
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

async function sendMotors(id, left, right) {
  const entry = state.devices.get(id);
  if (!entry || !entry.motorChar) return;
  const clamp = (v) => Math.max(-100, Math.min(100, Math.round(Number(v) || 0)));
  // Drop-intermediate-values: slider input events fire faster than BLE
  // writes can complete ("GATT operation already in progress" otherwise).
  // We always queue the latest wanted value; while a write is in flight,
  // newer calls just update the pending intent. Latest intent wins.
  entry.motorPending = [clamp(left), clamp(right)];
  if (entry.motorSending) return;
  entry.motorSending = true;
  try {
    while (entry.motorPending) {
      const [l, r] = entry.motorPending;
      entry.motorPending = null;
      try {
        // Int8 wire encoding: negatives become 0x80..0xFF via two's complement.
        await entry.motorChar.writeValueWithResponse(
          Uint8Array.of(l & 0xff, r & 0xff));
      } catch (err) {
        logFor(entry, `motors write failed: ${err.message}`);
        break;
      }
    }
  } finally {
    entry.motorSending = false;
  }
}

async function toggleLed(id) {
  const entry = state.devices.get(id);
  if (!entry || !entry.ledChar) return;
  const next = !entry.ledOn;
  try {
    await entry.ledChar.writeValueWithResponse(Uint8Array.of(next ? 1 : 0));
    entry.ledOn = next;
    renderEntry(entry);
  } catch (err) {
    logFor(entry, `LED write failed: ${err.message}`);
  }
}

// "Connect all" is only shown when ≥2 idle entries already have a device
// handle. Chrome allows one chooser per user gesture, so batch-connect can't
// restore entries that need a new pairing prompt — for those, per-card
// Connect remains the right path.
function updateHeaderActions() {
  const idleReady = [...state.devices.values()]
    .filter(e => e.status === "idle" && e.device).length;
  $("connect-all-btn").hidden = idleReady < 2;
}

function connectAll() {
  const targets = [...state.devices.values()]
    .filter(e => e.status === "idle" && e.device);
  targets.forEach(e => connect(e.id));
}

// Two-level render. render() reconciles the list (add / remove / order)
// against state.devices; renderEntry() rebuilds one card's innards. Most
// state changes go through renderEntry so a notification for robot A never
// touches robot B's DOM — a slider being dragged on one card isn't
// interrupted by a sibling's OTA progress notify.
function render() {
  const list = $("robot-list");
  const empty = $("empty-state");
  const header = $("robots-heading");

  if (state.devices.size === 0) {
    empty.hidden = false;
    header.hidden = true;
    list.innerHTML = "";
    return;
  }
  empty.hidden = true;
  header.hidden = false;
  updateHeaderActions();

  // Drop nodes for entries that are no longer in state (e.g., forgetDevice).
  const ids = new Set(state.devices.keys());
  for (const child of [...list.children]) {
    if (!ids.has(child.dataset.entryId)) child.remove();
  }

  // Mount or re-order in state-map order. Nodes are owned by entry.node.
  let prev = null;
  for (const entry of state.devices.values()) {
    if (!entry.node) {
      entry.node = document.createElement("section");
      entry.node.className = "card robot";
      entry.node.dataset.entryId = entry.id;
      renderEntry(entry);
    }
    const target = prev ? prev.nextSibling : list.firstChild;
    if (target !== entry.node) {
      if (prev) prev.after(entry.node); else list.prepend(entry.node);
    }
    prev = entry.node;
  }
}

function renderEntry(entry) {
  if (!entry.node) { render(); return; }  // first mount goes through list render
  const { id, name, status, ledOn } = entry;
  const connected = status === "connected";
  const connecting = status === "connecting";
  const statusText = connecting ? "Connecting…" : status === "error" ? "Error" : "";
  const dotClass = connected ? " connected" : status === "error" ? " error" : "";

  entry.node.innerHTML = `
    <div class="row">
      <div>
        <div class="label"><span class="dot${dotClass}"></span>${escapeHtml(name)}</div>
        ${statusText ? `<div class="status">${statusText}</div>` : ""}
      </div>
      <div style="display: flex; gap: 4px;">
        ${connected
          ? `<button class="secondary sm" data-action="disconnect">Disconnect</button>`
          : `<button class="sm" data-action="connect" ${connecting ? "disabled" : ""}>${connecting ? "…" : "Connect"}</button>`}
        <button class="icon" data-action="menu" aria-label="More actions">⋯</button>
      </div>
    </div>
    ${connected ? `
      <div class="robot-controls row">
        <div>
          <div class="label">LED</div>
          <div class="meta">${ledOn ? "on" : "off"}</div>
        </div>
        <button class="secondary sm" data-action="toggle-led">${ledOn ? "Turn off" : "Turn on"}</button>
      </div>
    ` : ""}
    ${connected && entry.motorChar ? `
      <div class="robot-controls row">
        <div>
          <div class="label">Motors</div>
          <div class="meta">L: ${entry.motorLeft} · R: ${entry.motorRight}</div>
        </div>
        <button class="secondary sm" data-action="motors-stop">Stop</button>
      </div>
      <div class="motor-sliders">
        <label>L <input type="range" min="-100" max="100" value="${entry.motorLeft}" data-action="motor-left"></label>
        <label>R <input type="range" min="-100" max="100" value="${entry.motorRight}" data-action="motor-right"></label>
      </div>
    ` : ""}
    ${connected && entry.wifiScanChar ? `
      <div class="robot-controls row">
        <div>
          <div class="label">WiFi</div>
          <div class="meta">${escapeHtml(wifiSummary(entry))}</div>
        </div>
        <button class="secondary sm" data-action="scan-wifi" ${entry.wifiScanning ? "disabled" : ""}>
          ${entry.wifiScanning ? "Scanning…" : "Scan"}
        </button>
      </div>
      ${entry.wifiNetworks && entry.wifiNetworks.length ? `
        <div class="wifi-list">
          ${entry.wifiNetworks.map(n => `
            <div class="wifi-row">
              <div>
                <div>${escapeHtml(n.s)}</div>
                <div class="meta">${n.r} · ${n.p ? "secured" : "open"}</div>
              </div>
              <button class="secondary sm" data-action="join-wifi" data-ssid="${escapeHtml(n.s)}" data-secured="${n.p ? 1 : 0}">Join</button>
            </div>
          `).join("")}
        </div>
      ` : ""}
    ` : ""}
    ${entry.lastEvent ? `
      <div class="last-event">${escapeHtml(entry.lastEvent)}</div>
    ` : ""}
  `;
  entry.node.querySelectorAll("[data-action]").forEach(btn => {
    const action = btn.dataset.action;
    if (action === "motor-left" || action === "motor-right") {
      btn.addEventListener("input", () => {
        const l = entry.node.querySelector('[data-action="motor-left"]').value;
        const r = entry.node.querySelector('[data-action="motor-right"]').value;
        sendMotors(id, l, r);
      });
      return;
    }
    btn.addEventListener("click", () => {
      if (action === "connect") connect(id);
      else if (action === "disconnect") disconnect(id);
      else if (action === "menu") openMenu(btn, id);
      else if (action === "toggle-led") toggleLed(id);
      else if (action === "scan-wifi") scanWifi(id);
      else if (action === "join-wifi") joinWifi(id, btn.dataset.ssid, btn.dataset.secured === "1");
      else if (action === "motors-stop") {
        entry.node.querySelector('[data-action="motor-left"]').value = 0;
        entry.node.querySelector('[data-action="motor-right"]').value = 0;
        sendMotors(id, 0, 0);
      }
    });
  });
  updateHeaderActions();
}

let menuTargetId = null;

function openMenu(triggerBtn, id) {
  menuTargetId = id;
  const menu = $("robot-menu");
  const rect = triggerBtn.getBoundingClientRect();
  // Position below-right of trigger, nudging left if it would overflow viewport.
  const menuWidth = 220;
  const left = Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8);
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${Math.max(8, left)}px`;
  if (menu.showPopover) menu.showPopover();
}

function closeMenu() {
  const menu = $("robot-menu");
  if (menu.hidePopover) menu.hidePopover();
  menuTargetId = null;
}

function robotUrl(name) {
  return `${location.origin}${location.pathname}?robot=${encodeURIComponent(name)}`;
}

function openLabel(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  const url = robotUrl(entry.name);
  $("label-title").textContent = entry.name;
  $("label-url").textContent = url;
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  $("qr-box").innerHTML = qr.createSvgTag({ scalable: true, margin: 0 });
  $("label-modal").showModal();
}

function highlightKnownRobotFromUrl() {
  const hinted = new URLSearchParams(location.search).get("robot");
  if (!hinted) return;
  const entry = [...state.devices.values()].find(e => e.name === hinted);
  if (!entry || !entry.node) return;
  requestAnimationFrame(() => {
    entry.node.classList.add("highlight");
    entry.node.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => entry.node.classList.remove("highlight"), 1500);
  });
}

function wifiSummary(entry) {
  const { st, ssid, err } = entry.wifiStatus || {};
  if (st === "joined")  return `Connected to ${ssid || "network"}`;
  if (st === "joining") return `Joining${ssid ? ` ${ssid}` : ""}…`;
  if (st === "failed")  return `Failed${err ? ` — ${err}` : ""}`;
  return "Not configured";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setBluetoothAvailable(available) {
  $("bluetooth-off").hidden = !!available;
  const btn = $("scan-btn");
  if (btn) btn.disabled = !available;
  const emptyBtn = $("empty-scan-btn");
  if (emptyBtn) emptyBtn.disabled = !available;
}

document.addEventListener("DOMContentLoaded", () => {
  if (!navigator.bluetooth) {
    $("unsupported").hidden = false;
    $("scan-btn").disabled = true;
    return;
  }
  // Adapter-level availability — surfaces "Bluetooth is off" as a distinct
  // state so Scan failures aren't opaque.
  if (navigator.bluetooth.getAvailability) {
    navigator.bluetooth.getAvailability().then(setBluetoothAvailable);
    navigator.bluetooth.addEventListener("availabilitychanged", (e) => {
      setBluetoothAvailable(e.value);
    });
  }
  $("scan-btn").addEventListener("click", scanForNew);
  $("empty-scan-btn").addEventListener("click", scanForNew);
  $("connect-all-btn").addEventListener("click", connectAll);

  // Settings modal — passive-scan toggle gates on both the flag and the
  // underlying API; if Chrome lacks requestLEScan, the status line explains
  // that the --enable-experimental-web-platform-features flag is required.
  const passiveCheckbox = $("setting-passive-scan");
  const passiveStatus = $("setting-passive-scan-status");
  const passiveAvailable = !!navigator.bluetooth?.requestLEScan;
  passiveCheckbox.checked = settings.passiveScan;
  passiveStatus.textContent = passiveAvailable
    ? "Scan for robots in the background without a chooser."
    : "Unavailable — enable chrome://flags#enable-experimental-web-platform-features.";
  if (!passiveAvailable) passiveCheckbox.disabled = true;
  passiveCheckbox.addEventListener("change", () => {
    settings.passiveScan = passiveCheckbox.checked;
    saveSettings();
  });
  $("settings-btn").addEventListener("click", () => $("settings-modal").showModal());
  $("settings-close").addEventListener("click", () => $("settings-modal").close());

  $("menu-label").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (id) openLabel(id);
  });
  $("menu-update").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (id) updateFirmware(id);
  });
  $("menu-update-file").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (id) updateFromFile(id);
  });
  $("label-close").addEventListener("click", () => $("label-modal").close());
  $("label-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("label-url").textContent);
      $("label-copy").textContent = "Copied";
      setTimeout(() => $("label-copy").textContent = "Copy URL", 1500);
    } catch {}
  });
  $("label-print").addEventListener("click", () => window.print());

  $("menu-forget").addEventListener("click", () => {
    const id = menuTargetId;
    if (!id) return;
    const entry = state.devices.get(id);
    if (!entry) return;
    // entry.device may be null for robots restored from localStorage that we
    // haven't reconnected to in this session. entry.name is always set.
    const name = entry.name;
    closeMenu();
    if (confirm(`Forget ${name}?\n\nYou'll need to pair it again to use it.`)) {
      forgetDevice(id);
    }
  });

  loadPaired().then(() => {
    // Fold setup once robots exist — setup is onboarding-phase, pairing is
    // the everyday use. User can re-expand at any time; state isn't forced.
    $("setup-section").open = state.devices.size === 0;
    highlightKnownRobotFromUrl();
  });
});

// ============================================================
// Prepare SD card dialog. Scoped via IIFE so its state (dirHandle,
// handlers) doesn't bleed into the dashboard's globals; $ and helpers
// are shared via closure.
// ============================================================
(() => {
  const FIRMWARE_URL    = "firmware/pi_robot";
  const FIRMWARE_FILES  = ["pi_robot.py", "requirements.txt", "pi-robot.service"];
  const SSH_KEY_STORE   = "better-robotics:ssh-pub";
  const CMDLINE_USB     = " modules-load=dwc2,g_ether";
  const CONFIG_USB_MARKER = "# Better Robotics: USB gadget mode";
  const CONFIG_USB_LINES  = `\n${CONFIG_USB_MARKER}\n[all]\ndtoverlay=dwc2\n`;
  const SYSTEMD_RUN =
    " systemd.run=/boot/firmware/firstrun.sh" +
    " systemd.run_success_action=reboot" +
    " systemd.unit=kernel-command-line.target";

  let dirHandle = null;

  function prepLog(msg, cls) {
    const el = document.createElement("div");
    if (cls) el.className = cls;
    el.textContent = msg;
    $("prep-progress").prepend(el);
  }

  const shSingleQuote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  const ensureDir = (parent, name) => parent.getDirectoryHandle(name, { create: true });

  async function writeFile(dir, name, contents) {
    const h = await dir.getFileHandle(name, { create: true });
    const w = await h.createWritable();
    await w.write(contents);
    await w.close();
  }
  async function readTextFile(dir, name) {
    try {
      const h = await dir.getFileHandle(name);
      const f = await h.getFile();
      return await f.text();
    } catch { return null; }
  }
  async function fetchBlob(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return r.blob();
  }

  function patchCmdline(text) {
    let line = text.replace(/\n+$/, "").trim();
    line = line.replace(/\s+systemd\.run=\S+/g, "");
    line = line.replace(/\s+systemd\.run_success_action=\S+/g, "");
    line = line.replace(/\s+systemd\.unit=\S+/g, "");
    line = line.replace(/\s+modules-load=\S+/g, "");
    return line + CMDLINE_USB + SYSTEMD_RUN + "\n";
  }
  function patchConfig(text) {
    if (text.includes(CONFIG_USB_MARKER)) return text;
    return text.replace(/\n*$/, "") + CONFIG_USB_LINES;
  }
  function renderFirstrun(template, values) {
    let out = template;
    for (const [k, v] of Object.entries(values)) {
      out = out.replaceAll(`__REPLACE_${k}__`, shSingleQuote(v));
    }
    return out;
  }

  async function runPrepare() {
    $("prep-go-btn").disabled = true;
    $("prep-progress").hidden = false;
    $("prep-progress").innerHTML = "";

    const hostname = $("prep-hostname").value.trim() || "betterpi";
    const username = $("prep-username").value.trim() || "pi";
    const password = $("prep-password").value;
    const sshKey   = $("prep-sshkey").value.trim();

    if (!password || !sshKey) {
      prepLog("Need both sudo password and SSH key.", "err");
      $("prep-go-btn").disabled = false;
      return;
    }

    try {
      prepLog("Validating SD card…");
      const cfg = await readTextFile(dirHandle, "config.txt");
      if (cfg === null || (!cfg.includes("[cm4]") && !cfg.includes("arm_64bit"))) {
        prepLog("Warning: picked directory doesn't look like a Pi boot partition.", "err");
      }

      prepLog("Fetching firstrun template…");
      const template = await (await fetch(`${FIRMWARE_URL}/firstrun.template.sh`)).text();

      prepLog("Fetching firmware files…");
      const betterpi = await ensureDir(dirHandle, "betterpi");
      for (const f of FIRMWARE_FILES) {
        await writeFile(betterpi, f, await fetchBlob(`${FIRMWARE_URL}/${f}`));
        prepLog(`  ✓ ${f}`, "ok");
      }

      prepLog("Fetching wheels manifest…");
      const manifest = await (await fetch(`${FIRMWARE_URL}/wheels/manifest.json`)).json();
      const wheels = await ensureDir(dirHandle, "wheels");
      for await (const entry of wheels.values()) {
        if (entry.kind === "file") await wheels.removeEntry(entry.name).catch(() => {});
      }
      for (const filename of manifest.wheels) {
        await writeFile(wheels, filename, await fetchBlob(`${FIRMWARE_URL}/wheels/${filename}`));
        prepLog(`  ✓ ${filename}`, "ok");
      }

      prepLog("Rendering firstrun.sh…");
      const firstrun = renderFirstrun(template, {
        HOSTNAME:  hostname,
        USER_NAME: username,
        USER_PASS: password,
        SSH_KEY:   sshKey,
      });
      await writeFile(dirHandle, "firstrun.sh", firstrun);

      prepLog("Patching cmdline.txt…");
      const oldCmd = await readTextFile(dirHandle, "cmdline.txt");
      if (oldCmd === null) throw new Error("cmdline.txt not found on card");
      await writeFile(dirHandle, "cmdline.txt", patchCmdline(oldCmd));

      prepLog("Enabling USB gadget mode…");
      const oldCfg = await readTextFile(dirHandle, "config.txt");
      if (oldCfg === null) throw new Error("config.txt not found on card");
      await writeFile(dirHandle, "config.txt", patchConfig(oldCfg));

      try { localStorage.setItem(SSH_KEY_STORE, sshKey); } catch {}
      prepLog("Done. Eject the card and boot the Pi.", "ok");
    } catch (err) {
      prepLog(`Error: ${err.message}`, "err");
    } finally {
      $("prep-go-btn").disabled = false;
    }
  }

  function openDialog() {
    $("prepare-dialog").showModal();
  }
  function closeDialog() {
    $("prepare-dialog").close();
  }

  function init() {
    const supported = !!window.showDirectoryPicker;
    if (!supported) {
      $("prep-unsupported").hidden = false;
      $("prep-pick-btn").disabled = true;
    }

    // Restore SSH key (public, safe to persist across sessions). Pre-fill
    // is its own "remembered" indicator — no separate meta line needed.
    try {
      const saved = localStorage.getItem(SSH_KEY_STORE);
      if (saved) $("prep-sshkey").value = saved;
    } catch {}

    $("prepare-open-btn").addEventListener("click", openDialog);
    $("prepare-close").addEventListener("click", closeDialog);
    $("prep-cancel-btn").addEventListener("click", closeDialog);

    $("prep-sshkey-load").addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".pub,text/*";
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        $("prep-sshkey").value = (await file.text()).trim();
      });
      input.click();
    });

    $("prep-pick-btn").addEventListener("click", async () => {
      try {
        dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
        $("prep-pick-meta").textContent = dirHandle.name;
        $("prep-go-btn").disabled = false;
      } catch { /* user cancelled */ }
    });

    $("prep-go-btn").addEventListener("click", runPrepare);

    // Bookmark / QR-code support: ?prepare in the URL auto-opens the dialog.
    if (new URLSearchParams(location.search).get("prepare") !== null) {
      openDialog();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
