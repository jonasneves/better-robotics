import { SERVICE_UUID, HEARTBEAT_SVC_UUID, HEARTBEAT_CHAR_UUID,
  FW_INFO_CHAR_UUID, ROBOT_STATUS_CHAR_UUID,
  OPS_RESPONSE_CHAR_UUID, TELEMETRY_CHAR_UUID, decodeJson } from "./ble.js";
import { $, escapeHtml } from "./dom.js";
import { log, logFor, setLogRenderer } from "./log.js";
import { settings, saveSettings } from "./settings.js";
import {
  state, persist, loadKnown,
  makeEntry, entryFor, attachDevice, setDisconnectHandler,
} from "./state.js";
import { ALL as CAPABILITIES, setCapabilityRenderer } from "./capabilities/index.js";
import { RUNTIMES } from "./capabilities/runtime/index.js";
import { setOpen as capSetOpen } from "./capabilities/runtime/cap-section.js";
import { formatUptime, formatWifi, formatResetReason } from "./format.js";
import { updateFirmware, updateFromFile } from "./capabilities/ota.js";
import { restartService, rebootRobot, enrollKey, getLog, getConfig } from "./capabilities/runtime/command.js";
import { initGamepad } from "./gamepad.js";
import { initMotorsKeyboard } from "./capabilities/runtime/signed-pair.js";
import { initVoice } from "./voice.js";
// prepare.js / pinout.js / recovery.js are lazy-loaded on first use (~750 LOC
// combined, none of it needed for first paint). See the dynamic import()
// calls in the DOMContentLoaded wiring below.
import { initAuthUI, fingerprint as dashFingerprint, pubkeySsh, onKeyChange } from "./auth.js";
import { initPasswordsUI } from "./passwords.js";
import { initAssistant, handleRemoteChat } from "./assistant.js";
import { initPhones, setPhoneChatHandler } from "./phones.js";

setLogRenderer((entry) => renderEntry(entry));
setDisconnectHandler((id) => onDisconnected(id));
setCapabilityRenderer((entry) => renderEntry(entry));

// Compact telemetry line below the robot-state. Only shows when the robot
// actually publishes (Pi from fw_version onward; ESP32 from telemetry char).
function telemetryText(entry) {
  const t = entry.telemetry;
  if (!t) return "";
  const parts = [];
  const up = formatUptime(t);
  if (up) parts.push(up);
  if (typeof t.mem_free_mb === "number") parts.push(`${t.mem_free_mb} MB free`);
  if (typeof t.free_heap === "number") parts.push(`${Math.floor(t.free_heap / 1024)} KB free`);
  if (typeof t.temp_c === "number") parts.push(`${t.temp_c.toFixed(1)}°C`);
  return parts.join(" · ");
}
function telemetryHtml(entry) {
  // Always emit the wrapper (even empty) so patchTelemetryLine can fill it
  // without needing renderEntry. CSS :empty hides it when no data.
  return `<div class="telemetry">${escapeHtml(telemetryText(entry))}</div>`;
}

// The header meta line ("WiFi … · up …h · reset: …"). Reused by renderEntry
// (full render) and patchSecondaryRow (telemetry-driven updates that would
// otherwise flash the whole card every 10 s). Composes pure formatters
// from format.js (smoke-tested) so the display logic isn't duplicated.
function metaText(entry) {
  const connected = entry.status === "connected" || entry.status === "firmware-down";
  if (!connected) return "";
  const parts = [
    formatWifi(entry.wifiStatus),
    formatUptime(entry.telemetry),
    formatResetReason(entry.telemetry?.reset_reason),
  ].filter(Boolean);
  return parts.join(" · ");
}

// Surgical patcher for the secondary row + body telemetry line. Avoids the
// full-card innerHTML rewrite that telemetry's 10 s notify rhythm was
// causing — that rewrite destroyed/recreated the entire card DOM, which
// reads as a card flash. patchOtaSection set the precedent; this generalizes
// to the high-frequency notify channels.
function patchSecondaryRow(entry) {
  const node = entry.node;
  if (!node) return;
  const meta = node.querySelector(".robot-meta");
  if (meta) meta.textContent = metaText(entry);
  const tel = node.querySelector(".telemetry");
  if (tel) tel.textContent = telemetryText(entry);
}

// Same idea for robot-status notify (rebooting / installing / ready). Lower
// frequency than telemetry but same flash-on-full-render cost.
function patchRobotStateLine(entry) {
  const node = entry.node;
  if (!node) return;
  const liveStatus = entry.robotStatus;
  const sticky = !liveStatus ? entry.stickyStatus : null;
  const s = liveStatus || sticky;
  let line = node.querySelector(".robot-state");
  if (!s || s.st === "ready") {
    if (line) line.remove();
    return;
  }
  if (!line) {
    line = document.createElement("div");
    line.className = "robot-state";
    // Insert right after the identity row so order matches renderEntry.
    const identityRow = node.querySelector(":scope > .row");
    if (identityRow) identityRow.after(line);
    else node.appendChild(line);
  }
  line.classList.toggle("sticky", !!sticky);
  const prefix = sticky ? "was " : "";
  line.textContent = s.msg ? `${prefix}${s.st} — ${s.msg}` : `${prefix}${s.st}`;
}

// Ops-response dispatch registry lives in ops-response.js so pip-tools.js
// (a registrar) doesn't need to import app.js (a caller) and create a cycle.
// Imported locally (app.js registers its own handlers) and re-exported for
// back-compat with anything else that imported it from app.
import { onOpsResponse, dispatchOpsResponse } from "./ops-response.js";
export { onOpsResponse };

// Per-robot expand/collapse preference. Persisted so a user's choice sticks
// across sessions. Absence of a key = fall back to smart default (see
// computeExpanded). Live-busy state (installing, rebooting) always forces
// expanded so progress is visible regardless of preference.
const EXPANSION_KEY = "robot-expansion-v1";
function loadExpansionPrefs() {
  try { return JSON.parse(localStorage.getItem(EXPANSION_KEY) || "{}"); }
  catch { return {}; }
}
function setExpansionPref(id, expanded) {
  const prefs = loadExpansionPrefs();
  prefs[id] = expanded;
  try { localStorage.setItem(EXPANSION_KEY, JSON.stringify(prefs)); } catch {}
}
function computeExpanded(entry) {
  const live = entry.robotStatus;
  if (live && live.st && live.st !== "ready") return true;  // mid-flight work wins
  const prefs = loadExpansionPrefs();
  if (entry.id in prefs) return prefs[entry.id];
  return state.devices.size === 1;  // solo robot → expand; crowd → let user pick
}

// Dashboard's own fingerprint. Cached sync so renderEntry can compare
// against fw-info.authorized without awaiting. Refreshed whenever the
// keypair changes (generate / import / regenerate).
let myFingerprint = null;
async function refreshMyFingerprint() {
  myFingerprint = await dashFingerprint();
  for (const e of state.devices.values()) {
    if (e.status === "connected") renderEntry(e);
  }
}
onKeyChange(refreshMyFingerprint);

// Skip auto-reconnect for robots untouched past this window — stale entries
// shouldn't blast the BT stack with timeout attempts on every page load.
const AUTO_RECONNECT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// gatt.connect() has no browser-exposed timeout; a wedged robot can leave the
// amber "Connecting…" pulse on indefinitely. Hard cap so a failed attempt
// resolves to an error state the user can see.
const GATT_CONNECT_TIMEOUT_MS = 20000;
function gattConnectWithTimeout(device) {
  return Promise.race([
    device.gatt.connect(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`connect timeout after ${GATT_CONNECT_TIMEOUT_MS / 1000}s`)),
                 GATT_CONNECT_TIMEOUT_MS)),
  ]);
}

async function loadPaired() {
  // Restore remembered robots first — works even when getDevices() is missing.
  for (const { id, name, fwType, autoReconnect, lastConnectedAt } of loadKnown()) {
    if (!state.devices.has(id)) {
      state.devices.set(id, makeEntry(id, name, fwType, { autoReconnect, lastConnectedAt }));
    }
  }
  if (navigator.bluetooth.getDevices) {
    try {
      const paired = await navigator.bluetooth.getDevices();
      paired.forEach(entryFor);
    } catch (err) {
      log(`Could not list paired devices: ${err.message}`);
    }
  }
  render();
  autoReconnectKnown();
}

// Fire off reconnect attempts for robots whose last intent was to be connected.
// Guard: only attempt if a paired BluetoothDevice is already attached (from
// getDevices) — otherwise connect() would prompt with a chooser, which is
// hostile on page load.
// After this many consecutive failures in one session, stop retrying on load —
// a dead/out-of-range robot shouldn't keep hammering the BT stack. Counter
// lives in-memory (not persisted) so a fresh page load gets one clean attempt.
const AUTO_RECONNECT_MAX_FAILURES = 2;
function autoReconnectKnown() {
  const cutoff = Date.now() - AUTO_RECONNECT_MAX_AGE_MS;
  for (const entry of state.devices.values()) {
    if (!entry.device) continue;
    if (!entry.autoReconnect) continue;
    if ((entry.lastConnectedAt || 0) < cutoff) continue;
    if ((entry.consecutiveFailures || 0) >= AUTO_RECONNECT_MAX_FAILURES) continue;
    connect(entry.id).catch(() => { /* timeouts are expected; status-row shows it */ });
  }
}

async function scanForNew() {
  if (settings.passiveScan && navigator.bluetooth.requestLEScan) {
    return scanForNewPassive();
  }
  try {
    // If ?robot=X hint is present and that robot isn't already paired,
    // pre-filter the chooser by name so the user picks from one entry.
    const hintedName = new URLSearchParams(location.search).get("robot");
    const useHint = hintedName
      && ![...state.devices.values()].some(e => e.name === hintedName);
    // Match devices advertising EITHER the main service OR the heartbeat —
    // a robot whose pi-robot.service is dead still appears via heartbeat.
    const filters = useHint
      ? [{ name: hintedName, services: [SERVICE_UUID] },
         { name: hintedName, services: [HEARTBEAT_SVC_UUID] }]
      : [{ services: [SERVICE_UUID] }, { services: [HEARTBEAT_SVC_UUID] }];
    const device = await navigator.bluetooth.requestDevice({
      filters, optionalServices: [SERVICE_UUID, HEARTBEAT_SVC_UUID],
    });
    const name = device.name || device.id;
    entryFor(device);
    log("paired", name);
    render();
    connect(device.id);
  } catch (err) {
    if (err.name !== "NotFoundError") log(`Scan error: ${err.message}`);
  }
}

// Passive BLE scan uses requestLEScan behind Chrome's
// --enable-experimental-web-platform-features flag. Pairing still needs
// requestDevice, but with a name filter it's a one-entry chooser.
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
      filters: [{ services: [SERVICE_UUID] }, { services: [HEARTBEAT_SVC_UUID] }],
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
      filters: [{ name, services: [SERVICE_UUID] },
                { name, services: [HEARTBEAT_SVC_UUID] }],
      optionalServices: [SERVICE_UUID, HEARTBEAT_SVC_UUID],
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
  // Required on browsers without getDevices(): chooser filtered to the saved name.
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ name: entry.name, services: [SERVICE_UUID] },
              { name: entry.name, services: [HEARTBEAT_SVC_UUID] }],
    optionalServices: [SERVICE_UUID, HEARTBEAT_SVC_UUID],
  });
  attachDevice(entry, device);
}

async function connect(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  // If the last attempt's cached handle was stale, force the chooser path —
  // requestDevice gives us a fresh BluetoothDevice; the cached one will keep
  // failing the same way until Chrome's pairing-list garbage-collects it.
  if (entry.staleHandle) entry.device = null;
  if (!entry.device) {
    try {
      log("re-pairing…", entry.name);
      await restoreDevice(entry);
    } catch (err) {
      if (err.name !== "NotFoundError") logFor(entry, `re-pair cancelled: ${err.message}`);
      return;
    }
  }
  entry.status = "connecting";
  renderEntry(entry);
  let server;
  try {
    server = await gattConnectWithTimeout(entry.device);
  } catch (err) {
    // Cached gatt.connect failed before we got anywhere. Almost always means
    // the BluetoothDevice handle is stale (robot rebooted, bonding rotated).
    // Flip the button to "Re-pair" so the next click goes through the chooser
    // — chaining requestDevice into the same click is blocked by Chrome's
    // 5s transient-activation window vs. our 20s gatt.connect timeout.
    entry.status = "error";
    entry.staleHandle = true;
    entry.lastConnectError = err.message || String(err);
    entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
    logFor(entry, `connect failed: ${entry.lastConnectError} — click Re-pair to retry with a fresh handle`);
    renderEntry(entry);
    return;
  }
  try {
    let service;
    try {
      service = await server.getPrimaryService(SERVICE_UUID);
    } catch (svcErr) {
      // pi-robot.service is dead but the robot's heartbeat plane is still up.
      // Surface the recovery info instead of bouncing the user back to "Error".
      if (await tryConnectHeartbeatOnly(entry, server)) {
        renderEntry(entry);
        return;
      }
      throw svcErr;
    }
    // A robot advertising only the service (no chars) is still "connected".
    // Every capability is optional.
    entry.status = "connected";
    entry.staleHandle = false;
    // Record the intent signal: this session's last explicit wish is "connected".
    // Unexpected GATT drops won't flip it — only an explicit Disconnect click will.
    entry.autoReconnect = true;
    entry.lastConnectedAt = Date.now();
    // Reset the per-session failure state so a future drop starts from zero.
    entry.consecutiveFailures = 0;
    entry.lastConnectError = null;
    persist();

    // Read fw-info before cap probes — it carries the capability schema.
    // Also subscribe to notifications: ESP32 re-publishes fw-info after
    // deferred camera init (post WiFi-join), so the camera cap only appears
    // mid-session. Old firmware without NOTIFY silently skips the subscribe.
    try {
      const info = await service.getCharacteristic(FW_INFO_CHAR_UUID);
      const raw = await info.readValue();
      const rawText = new TextDecoder().decode(raw);
      logFor(entry, `fw-info: ${rawText.slice(0, 200)}`);
      entry.fwInfo = decodeJson(raw);
      entry.capSchema = entry.fwInfo?.caps || null;
      if (entry.fwInfo?.type && entry.fwType !== entry.fwInfo.type) {
        entry.fwType = entry.fwInfo.type;
        persist();  // survive disconnect/reload so the badge stays visible
      }
      try {
        await info.startNotifications();
        info.addEventListener("characteristicvaluechanged", (e) => {
          const updated = decodeJson(e.target.value);
          if (!updated) return;
          entry.fwInfo = updated;
          entry.capSchema = updated.caps || null;
          logFor(entry, `fw-info updated: caps=${(updated.caps||[]).map(c=>c.name).join(",")}`);
          // Rebuild runtime caps so newly-advertised ones (camera) probe + render.
          probeRuntimeCaps(entry, service).then(() => renderEntry(entry));
        });
      } catch { /* firmware without NOTIFY — one-shot read is fine */ }
    } catch (err) {
      logFor(entry, `fw-info read failed: ${err.message}`);
      entry.fwInfo = null;
      entry.capSchema = null;
    }

    // robot-status: a top-level "what am I doing" notify channel. Optional —
    // older firmware / ESP32 don't expose it, and the card still works fine
    // without it.
    try {
      const statusChar = await service.getCharacteristic(ROBOT_STATUS_CHAR_UUID);
      entry.robotStatus = decodeJson(await statusChar.readValue()) || null;
      await statusChar.startNotifications();
      statusChar.addEventListener("characteristicvaluechanged", (e) => {
        entry.robotStatus = decodeJson(e.target.value) || null;
        patchRobotStateLine(entry);  // surgical, no full-card flash
      });
    } catch {
      entry.robotStatus = null;
    }
    // Fresh connection clears any sticky disconnect status.
    if (entry.stickyStatusTimer) { clearTimeout(entry.stickyStatusTimer); entry.stickyStatusTimer = null; }
    entry.stickyStatus = null;

    // Telemetry (read + notify) — optional; ESP32 / older Pi don't expose it.
    try {
      const telChar = await service.getCharacteristic(TELEMETRY_CHAR_UUID);
      entry.telemetry = decodeJson(await telChar.readValue()) || null;
      await telChar.startNotifications();
      telChar.addEventListener("characteristicvaluechanged", (e) => {
        entry.telemetry = decodeJson(e.target.value) || null;
        patchSecondaryRow(entry);  // surgical patch, no full-card re-render
      });
    } catch {
      entry.telemetry = null;
    }

    // ops-response (notify, chunked) — dispatches request/response ops like
    // get-log / get-config to the right handler. Same opcode protocol as OTA
    // and camera: 0x01 begin+u32 len, 0x02 chunk, 0x03 commit.
    try {
      const respChar = await service.getCharacteristic(OPS_RESPONSE_CHAR_UUID);
      entry.opsRespBuf = null;
      await respChar.startNotifications();
      respChar.addEventListener("characteristicvaluechanged", (e) => {
        const data = new Uint8Array(e.target.value.buffer);
        if (data.length === 0) return;
        const op = data[0];
        if (op === 0x01) entry.opsRespBuf = [];
        else if (op === 0x02 && entry.opsRespBuf) entry.opsRespBuf.push(data.subarray(1));
        else if (op === 0x03 && entry.opsRespBuf) {
          const total = entry.opsRespBuf.reduce((n, c) => n + c.length, 0);
          const merged = new Uint8Array(total);
          let o = 0;
          for (const c of entry.opsRespBuf) { merged.set(c, o); o += c.length; }
          entry.opsRespBuf = null;
          let msg;
          try { msg = JSON.parse(new TextDecoder().decode(merged)); }
          catch { return; }
          dispatchOpsResponse(entry, msg);
        }
      });
    } catch { /* ops-response char absent on older firmware — optional */ }

    entry.runtimeCaps = [];
    for (const cap of CAPABILITIES) {
      try { await cap.probe(entry, service); } catch { /* optional */ }
    }
    await probeRuntimeCaps(entry, service);
  } catch (err) {
    entry.status = "error";
    entry.lastConnectError = err.message || String(err);
    entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
    logFor(entry, `connect failed: ${entry.lastConnectError}`);
  }
  renderEntry(entry);
}

// Recovery-plane connect. The robot's main GATT service is gone, but
// heartbeat.py is still advertising. Read its status char so the card can
// show the IP + a recovery-console shortcut instead of an opaque error.
async function tryConnectHeartbeatOnly(entry, server) {
  try {
    const svc = await server.getPrimaryService(HEARTBEAT_SVC_UUID);
    const ch  = await svc.getCharacteristic(HEARTBEAT_CHAR_UUID);
    entry.heartbeat = decodeJson(await ch.readValue()) || {};
    try {
      await ch.startNotifications();
      ch.addEventListener("characteristicvaluechanged", (e) => {
        entry.heartbeat = decodeJson(e.target.value) || entry.heartbeat;
        renderEntry(entry);
      });
    } catch { /* notify optional */ }
    entry.status = "firmware-down";
    entry.staleHandle = false;
    entry.autoReconnect = true;
    entry.lastConnectedAt = Date.now();
    entry.consecutiveFailures = 0;
    entry.lastConnectError = null;
    persist();
    logFor(entry, `firmware down — heartbeat ip=${entry.heartbeat.ip || "?"} pi_robot=${entry.heartbeat.pi_robot || "?"}`);
    return true;
  } catch {
    return false;
  }
}

// Build + probe only runtime caps that aren't already live. Used both at
// connect time and when fw-info notifies a schema change mid-session (ESP32
// adds camera post-WiFi-join). Keyed by name so an existing cap's state
// (wifi scan cache, etc.) survives a re-notify.
async function probeRuntimeCaps(entry, service) {
  entry.runtimeCaps = entry.runtimeCaps || [];
  const have = new Set(entry.runtimeCaps.map(c => c.name));
  for (const capSchema of entry.capSchema || []) {
    if (have.has(capSchema.name)) continue;
    const make = RUNTIMES[capSchema.type];
    if (!make) continue;
    const cap = make(capSchema);
    Object.assign(entry, cap.initEntry());
    try { await cap.probe(entry, service); } catch { /* optional */ }
    entry.runtimeCaps.push(cap);
  }
}

async function disconnect(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  // Explicit user intent: "I'm done with this robot." Won't auto-reconnect on
  // next load. Unexpected drops go through onDisconnected without touching this.
  entry.autoReconnect = false;
  persist();
  if (entry.device && entry.device.gatt.connected) entry.device.gatt.disconnect();
  onDisconnected(id);
}

function onDisconnected(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  entry.status = "idle";
  // Remember the last-known status for 30s so 'rebooting' → disconnect reads
  // as "was rebooting" on the card instead of an unexplained drop.
  if (entry.robotStatus) {
    entry.stickyStatus = entry.robotStatus;
    if (entry.stickyStatusTimer) clearTimeout(entry.stickyStatusTimer);
    entry.stickyStatusTimer = setTimeout(() => {
      entry.stickyStatus = null;
      entry.stickyStatusTimer = null;
      renderEntry(entry);
    }, 30000);
  }
  entry.robotStatus = null;
  entry.heartbeat = null;
  for (const cap of CAPABILITIES) cap.cleanup(entry);
  for (const cap of entry.runtimeCaps || []) cap.cleanup(entry);
  entry.runtimeCaps = [];
  renderEntry(entry);
}

async function forgetDevice(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  // Without a BluetoothDevice handle, forget() can't run and Chrome keeps the
  // per-origin paired list — next requestDevice would show it as already paired.
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

// Connect-all shows when ≥1 idle robot has a BluetoothDevice handle already
// attached (silent reconnect possible). Robots needing pairing have their own
// per-card "Pair" button.
function updateHeaderActions() {
  const readyIdle = [...state.devices.values()]
    .filter(e => e.status === "idle" && e.device).length;
  $("connect-all-btn").hidden = readyIdle < 1;
}

function connectAll() {
  const all = [...state.devices.values()].filter(e => e.status === "idle");
  const ready = all.filter(e => e.device);
  const needsPair = all.filter(e => !e.device);
  ready.forEach(e => connect(e.id));
  if (needsPair.length > 0) {
    log(`${needsPair.length} robot(s) need pairing — click Pair on each card`);
  }
}

// Per-entry node ownership: a notify for robot A never touches robot B's DOM,
// so slider drags on one card survive sibling state changes.
// QR hint: ?robot=X on the URL means a scan landed us here. Surface a
// one-click Pair CTA when that robot isn't paired yet. Chrome gates
// requestDevice on user activation, so the button click is the activation.
function updateQrHint() {
  const hinted = new URLSearchParams(location.search).get("robot");
  const hint = $("qr-hint");
  if (!hint) return;
  const known = hinted && [...state.devices.values()].some(e => e.name === hinted);
  const show = !!hinted && !known && !!navigator.bluetooth;
  hint.hidden = !show;
  if (show) $("qr-hint-name").textContent = hinted;
}

function render() {
  const list = $("robot-list");
  const empty = $("empty-state");
  const header = $("robots-heading");

  updateQrHint();

  if (state.devices.size === 0) {
    empty.hidden = false;
    header.hidden = true;
    list.innerHTML = "";
    return;
  }
  empty.hidden = true;
  header.hidden = false;
  updateHeaderActions();

  const ids = new Set(state.devices.keys());
  for (const child of [...list.children]) {
    if (!ids.has(child.dataset.entryId)) child.remove();
  }

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
  if (!entry.node) { render(); return; }
  // Preserve focus + value across the innerHTML rebuild for any data-action
  // input/textarea inside this card. Telemetry/ops/motor notifies fire
  // renderEntry frequently; without this, typing in an inline editor (e.g.
  // the perception prompt field) is interrupted on every tick.
  const active = document.activeElement;
  const savedAction = active && entry.node.contains(active) ? active.dataset?.action : null;
  const savedValue = savedAction && "value" in active ? active.value : null;
  const savedStart = savedAction && active.selectionStart != null ? active.selectionStart : null;
  const savedEnd   = savedAction && active.selectionEnd != null ? active.selectionEnd : null;
  const { id, name, status } = entry;
  const firmwareDown = status === "firmware-down";
  // GATT IS connected when firmwareDown — only the main service is missing.
  // Treat as connected for button purposes so the user gets Disconnect.
  const connected = status === "connected" || firmwareDown;
  const connecting = status === "connecting";
  const statusText = status === "error"
    ? (/no longer in range|not found/i.test(entry.lastConnectError || "") ? "Out of range" : "Error")
    : firmwareDown ? "Firmware down"
    : "";
  // Card-style status hint via a colored left edge stripe (see .robot.connected
  // etc. in styles.css). Replaces the previous in-row dot — the stripe carries
  // status with more visual presence and the dot was redundant next to it.
  entry.node.classList.toggle("status-connected",     status === "connected");
  entry.node.classList.toggle("status-connecting",    connecting);
  entry.node.classList.toggle("status-error",         status === "error");
  entry.node.classList.toggle("status-firmware-down", firmwareDown);

  // Canonical capability order across robot types so the eye lands on the same
  // control in the same place on both Pi and ESP32 cards. Unknown names fall
  // to the end in schema order.
  const CAP_ORDER = { led: 1, motors: 2, wifi: 3, camera: 4, ops: 5, ota: 6 };
  const byOrder = (a, b) => (CAP_ORDER[a.name] ?? 99) - (CAP_ORDER[b.name] ?? 99);
  const sections = [...CAPABILITIES, ...(entry.runtimeCaps || [])]
    .slice()
    .sort(byOrder)
    .map(c => c.renderSection(entry))
    .join("");
  const liveStatus = entry.robotStatus;
  const sticky = !liveStatus ? entry.stickyStatus : null;
  const stateHtml = (() => {
    const s = liveStatus || sticky;
    if (!s || s.st === "ready") return "";
    const prefix = sticky ? "was " : "";
    const text = s.msg ? `${prefix}${s.st} — ${s.msg}` : `${prefix}${s.st}`;
    return `<div class="robot-state${sticky ? " sticky" : ""}">${escapeHtml(text)}</div>`;
  })();
  // Enroll prompt flattened to match the capability row rhythm (label + state
  // + action) so it doesn't visually break the card's structure.
  const enrollHtml = (() => {
    if (!connected || !entry.opsChar) return "";
    const auth = entry.fwInfo?.authorized;
    if (!Array.isArray(auth) || !myFingerprint || auth.includes(myFingerprint)) return "";
    if (auth.length === 0) {
      return `
        <div class="robot-controls">
          <div class="row">
            <div><div class="label">Enrollment</div><div class="meta">Dashboard not enrolled on this robot.</div></div>
            <button class="secondary sm" data-action="enroll">Enroll</button>
          </div>
        </div>`;
    }
    return `
      <div class="robot-controls">
        <div class="row">
          <div><div class="label">Enrollment</div><div class="meta">Enrolled to another dashboard.</div></div>
        </div>
      </div>`;
  })();
  const typeBadge = entry.fwType
    ? `<span class="type-badge type-${escapeHtml(entry.fwType)}">${escapeHtml(entry.fwType === "esp32" ? "ESP32" : entry.fwType.toUpperCase())}</span>`
    : "";
  // Secondary metadata row — surfaces WiFi state, uptime, abnormal reset
  // reasons. Only when connected (otherwise we don't have the data and the
  // row would say nothing useful). Card layout earns its height; this is
  // what fills it.
  const metaParts = [];
  if (connected) {
    const w = entry.wifiStatus;
    if (w?.st === "joined") metaParts.push(`WiFi ${w.ip || w.ssid || "joined"}`);
    else if (w?.st === "joining") metaParts.push("WiFi joining…");
    else if (w?.st === "scanning") metaParts.push("WiFi scanning");
    else if (w?.st === "failed")   metaParts.push("WiFi failed");
    const tel = entry.telemetry;
    const upS = tel?.uptime_s ?? (tel?.uptime_ms != null ? Math.floor(tel.uptime_ms / 1000) : null);
    if (upS != null) {
      metaParts.push(
        upS < 60   ? `up ${upS}s`
      : upS < 3600 ? `up ${Math.floor(upS / 60)}m`
      : upS < 86400 ? `up ${Math.floor(upS / 3600)}h ${Math.floor((upS % 3600) / 60)}m`
      :              `up ${Math.floor(upS / 86400)}d`
      );
    }
    // Surface reset reason only when it's something the user should know
    // about — power-on / software resets are normal, watchdog/panic/brownout
    // mean the device is unhealthy.
    const rr = tel?.reset_reason;
    if (rr && rr !== "poweron" && rr !== "sw" && rr !== "ext") {
      metaParts.push(`reset: ${rr}`);
    }
  }
  // Always emit the wrapper (even empty) so patchSecondaryRow can fill it on
  // telemetry/wifi notify without a full re-render. CSS :empty hides it.
  const metaRow = `<div class="robot-meta">${escapeHtml(metaParts.join(" · "))}</div>`;
  // Split on the last hyphen so the common "BetterRobot-" prefix dims and the
  // distinguishing suffix ("E9D4") carries the visual weight. Names without a
  // hyphen render plainly.
  const dash = name.lastIndexOf("-");
  const hasSplit = dash > 0 && dash < name.length - 1;
  const nameHtml = hasSplit
    ? `<span class="name-prefix">${escapeHtml(name.slice(0, dash + 1))}</span><span class="name-suffix">${escapeHtml(name.slice(dash + 1))}</span>`
    : escapeHtml(name);
  const expanded = computeExpanded(entry);
  entry.node.classList.toggle("expanded", expanded);
  entry.node.innerHTML = `
    <div class="row">
      <div class="robot-identity">
        <button class="label-btn" data-action="toggle-expand" aria-expanded="${expanded}">
          <svg class="icon-svg disclosure-chevron" aria-hidden="true"><use href="icons.svg#icon-chevron-down"/></svg>
          ${nameHtml}${typeBadge}
        </button>
        ${statusText ? `<div class="status">${statusText}</div>` : ""}
      </div>
      <div class="robot-actions">
        <button class="icon" data-action="menu" aria-label="More actions"><svg class="icon-svg"><use href="icons.svg#icon-more"/></svg></button>
      </div>
    </div>
    <div class="robot-secondary">
      ${metaRow}
      <div class="robot-cta">
        ${connected
          ? `<button class="secondary sm" data-action="disconnect">Disconnect</button>`
          : `<button class="sm" data-action="connect" ${connecting ? "disabled" : ""}>${
              connecting ? "Connecting…"
              : entry.staleHandle ? "Re-pair"
              : entry.device ? "Connect"
              : "Pair"
            }</button>`}
      </div>
    </div>
    ${stateHtml}
    ${firmwareDown ? `
      <div class="firmware-down-banner">
        <div class="label">pi-robot.service: ${escapeHtml(entry.heartbeat?.pi_robot || "down")}</div>
        <div class="meta">Only the heartbeat plane is responding — capabilities (LED, motors, WiFi, OTA) are unavailable until the firmware comes back.</div>
        ${entry.heartbeat?.ip ? `<div class="meta">SSH: <code>ssh robot@${escapeHtml(entry.heartbeat.ip)}</code></div>` : `<div class="meta">No IP — robot isn't on WiFi. Use the USB-C recovery console.</div>`}
        <div class="row" style="margin-top:8px;">
          <button class="secondary sm" data-action="open-recovery">Open recovery console</button>
        </div>
      </div>
    ` : ""}
    ${expanded && !firmwareDown ? `
      <div class="robot-body">
        ${telemetryHtml(entry)}
        ${enrollHtml}
        ${sections}
      </div>
    ` : ""}
  `;
  // Per-cap try/catch: one cap's wireActions throwing shouldn't silently
  // break wiring for every cap that comes after it. Surface the error so
  // future regressions are visible instead of mysteriously-not-working.
  const safeCall = (fn, label, cap) => {
    try { fn(); }
    catch (err) { console.warn(`[${label}] ${cap?.name || "?"}: ${err?.message || err}`); }
  };
  for (const cap of CAPABILITIES) safeCall(() => cap.wireActions(entry, entry.node), "wireActions", cap);
  for (const cap of entry.runtimeCaps || []) safeCall(() => cap.wireActions(entry, entry.node), "wireActions", cap);
  for (const cap of CAPABILITIES) safeCall(() => cap.postRender?.(entry), "postRender", cap);
  for (const cap of entry.runtimeCaps || []) safeCall(() => cap.postRender?.(entry), "postRender", cap);
  // Per-capability disclosure toggles (cap-section.js renders the buttons).
  // Click hides/shows the body without a re-render and persists the choice
  // to localStorage so the user's collapse preferences stick across sessions.
  entry.node.querySelectorAll("[data-cap-toggle]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const capName = btn.dataset.capToggle;
      const sec = btn.closest(".cap-section");
      const body = sec?.querySelector(".cap-body");
      if (!body) return;
      const willOpen = body.hasAttribute("hidden");
      body.toggleAttribute("hidden", !willOpen);
      btn.setAttribute("aria-expanded", String(willOpen));
      capSetOpen(capName, willOpen);
    });
  });

  const connectBtn = entry.node.querySelector('[data-action="connect"]');
  if (connectBtn) connectBtn.addEventListener("click", () => connect(id));
  const disconnectBtn = entry.node.querySelector('[data-action="disconnect"]');
  if (disconnectBtn) disconnectBtn.addEventListener("click", () => disconnect(id));
  const recoveryBtn = entry.node.querySelector('[data-action="open-recovery"]');
  if (recoveryBtn) recoveryBtn.addEventListener("click", async () => {
    const mod = await import("./recovery.js");
    mod.openRecoveryDialog();
  });
  const menuBtn = entry.node.querySelector('[data-action="menu"]');
  if (menuBtn) menuBtn.addEventListener("click", () => openMenu(menuBtn, id));
  const toggleExpand = () => {
    setExpansionPref(id, !entry.node.classList.contains("expanded"));
    renderEntry(entry);
  };
  // Explicit label-button handles keyboard + screen readers (aria-expanded).
  const expandBtn = entry.node.querySelector('[data-action="toggle-expand"]');
  if (expandBtn) expandBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleExpand(); });
  // Whole row is a generous click target for the same action — except clicks
  // that landed on another button (Pair/Disconnect, overflow menu).
  const row = entry.node.querySelector(".row");
  if (row) row.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    toggleExpand();
  });
  const enrollBtn = entry.node.querySelector('[data-action="enroll"]');
  if (enrollBtn) enrollBtn.addEventListener("click", async () => {
    const pub = await pubkeySsh();
    if (await enrollKey(id, pub) && myFingerprint) {
      // Optimistic: assume the Pi accepted. fw-info is re-published by the
      // firmware after enroll, but we also update locally so the prompt
      // disappears immediately.
      if (!entry.fwInfo) entry.fwInfo = {};
      entry.fwInfo.authorized = [...(entry.fwInfo.authorized || []), myFingerprint];
      renderEntry(entry);
    }
  });

  updateHeaderActions();

  // Restore focus + selection to the data-action element that had focus
  // before the rebuild, if any. Preserves the user's typing in inline
  // editors (perception prompt textarea, etc.) across telemetry ticks.
  if (savedAction) {
    const restored = entry.node.querySelector(`[data-action="${savedAction}"]`);
    if (restored) {
      try {
        if (savedValue != null && "value" in restored) restored.value = savedValue;
        restored.focus();
        if (savedStart != null && typeof restored.setSelectionRange === "function") {
          restored.setSelectionRange(savedStart, savedEnd ?? savedStart);
        }
      } catch {}
    }
  }
}

let menuTargetId = null;

function openMenu(triggerBtn, id) {
  const menu = $("robot-menu");
  const isOpen = menu.matches(":popover-open");
  // Toggle off if clicking the same robot's trigger; otherwise switch targets.
  if (isOpen && menuTargetId === id) {
    closeMenu();
    return;
  }
  if (isOpen) menu.hidePopover();  // switching robots — reopen at new position
  menuTargetId = id;
  // Diagnostic metadata (firmware commit SHA) lives here rather than on the
  // card face — only relevant when you're about to act on the robot.
  const entry = state.devices.get(id);
  const header = $("robot-menu-header");
  const version = entry?.fwInfo?.version;
  if (version) {
    header.textContent = `Firmware ${version}`;
    header.hidden = false;
  } else {
    header.hidden = true;
  }
  // Gate ops-dependent items on the presence of the ops channel. ESP32 has
  // no opsChar, so restart/reboot/log/pinout would be no-ops and the log
  // dialog would sit forever on "Loading…" waiting for a response that
  // can't come. Hide them instead of letting the user click into a dead end.
  const hasOps = !!entry?.opsChar;
  $("menu-restart").hidden = !hasOps;
  $("menu-reboot").hidden  = !hasOps;
  $("menu-log").hidden     = !hasOps;
  $("menu-pinout").hidden  = !hasOps;
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
  if (navigator.bluetooth.getAvailability) {
    navigator.bluetooth.getAvailability().then(setBluetoothAvailable);
    navigator.bluetooth.addEventListener("availabilitychanged", (e) => {
      setBluetoothAvailable(e.value);
    });
  }

  $("scan-btn").addEventListener("click", scanForNew);
  $("empty-scan-btn").addEventListener("click", scanForNew);
  $("qr-hint-pair").addEventListener("click", scanForNew);
  $("connect-all-btn").addEventListener("click", connectAll);


  // robot-menu is popover="manual" so neither Escape nor outside-click are
  // native — both need explicit listeners at document level.
  document.addEventListener("click", (e) => {
    const menu = $("robot-menu");
    if (!menu.matches(":popover-open")) return;
    if (e.target.closest("#robot-menu")) return;           // click inside the menu
    if (e.target.closest("[data-action='menu']")) return;  // trigger handles its own toggle
    closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("robot-menu").matches(":popover-open")) closeMenu();
  });

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
  $("menu-restart").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (id) restartService(id);
  });
  $("menu-reboot").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (id) rebootRobot(id);
  });
  let logTimeoutId = null;
  $("menu-log").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (!id) return;
    const entry = state.devices.get(id);
    $("log-dialog-title").textContent = `Log · ${entry?.name || "robot"}`;
    $("log-dialog-body").textContent = "Loading…";
    $("log-dialog").showModal();
    if (logTimeoutId) clearTimeout(logTimeoutId);
    // Reply arrives as a single get-log notify; if none lands within 10 s the
    // robot likely silently dropped the request (no ops-response handler,
    // stalled service, link congestion). Surface it instead of hanging.
    logTimeoutId = setTimeout(() => {
      logTimeoutId = null;
      if ($("log-dialog").open && $("log-dialog-body").textContent === "Loading…") {
        $("log-dialog-body").textContent = "(timed out — no response from robot)";
      }
    }, 10000);
    getLog(id);
  });
  $("log-dialog-close").addEventListener("click", () => {
    if (logTimeoutId) { clearTimeout(logTimeoutId); logTimeoutId = null; }
    $("log-dialog").close();
  });
  onOpsResponse("get-log", (entry, msg) => {
    if (!$("log-dialog").open) return;
    if (logTimeoutId) { clearTimeout(logTimeoutId); logTimeoutId = null; }
    $("log-dialog-body").textContent = msg.text || "(empty)";
  });
  $("menu-pinout").addEventListener("click", async () => {
    const id = menuTargetId;
    closeMenu();
    if (!id) return;
    const mod = await import("./pinout.js");
    mod.openPinoutDialog(id);
  });
  // Recovery lives in the avatar menu, not the per-robot menu: gating the
  // "BLE is dead" escape hatch behind a paired robot is the exact catch-22
  // it exists to break. The avatar menu has zero BLE dependency.
  $("menu-gpio-ref").addEventListener("click", async () => {
    $("avatar-menu").hidePopover();
    const mod = await import("./pinout.js");
    mod.openPinoutReference();
  });
  $("menu-recovery").addEventListener("click", async () => {
    $("avatar-menu").hidePopover();
    const mod = await import("./recovery.js");
    mod.openRecoveryDialog();
  });
  $("menu-esp-serial").addEventListener("click", async () => {
    $("avatar-menu").hidePopover();
    const mod = await import("./esp-serial.js");
    mod.init();
    mod.openESPSerialDialog();
  });
  $("menu-scripts").addEventListener("click", async () => {
    $("avatar-menu").hidePopover();
    const mod = await import("./scripts.js");
    mod.init();
    mod.openScriptsDialog();
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
    const name = entry.name;
    closeMenu();
    if (confirm(`Forget ${name}?\n\nYou'll need to pair it again to use it.`)) {
      forgetDevice(id);
    }
  });

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

  // Profile — classroom-local identity (no auth, browser-only). Seeded hue from name hash.
  const seedColor = (str) => {
    if (!str) return null;
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffff;
    return `hsl(${h % 360}, 55%, 50%)`;
  };
  const profileInitials = (name) => {
    if (!name) return "?";
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    if (words.length === 1) return words[0][0].toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  };
  const renderAvatar = (name) => {
    const initials = profileInitials(name);
    const color = seedColor(name);
    for (const el of [$("avatar-btn"), $("avatar-preview")]) {
      el.textContent = initials;
      el.style.background = color || "";
    }
    $("avatar-menu-name").textContent = name || "Not set — open Settings to add your name";
  };
  // Fun random default so first-time users get an identity without a prompt.
  // Adjective + robot/space noun → 576 combos. User can edit/clear anytime.
  const NAME_ADJ = ["Curious","Clever","Bold","Brave","Bright","Kind","Quick",
    "Cheerful","Gentle","Nimble","Mighty","Witty","Playful","Keen","Eager",
    "Daring","Friendly","Snappy","Plucky","Swift","Sunny","Lively","Cozy","Happy"];
  const NAME_NOUN = ["Rover","Pilot","Beacon","Pixel","Bolt","Circuit","Gear",
    "Sprocket","Widget","Cog","Comet","Orbit","Nova","Spark","Relay","Echo",
    "Satellite","Buffer","Byte","Atom","Chip","Node","Bot","Gadget"];
  const randomName = () => `${NAME_ADJ[Math.floor(Math.random() * NAME_ADJ.length)]} ${NAME_NOUN[Math.floor(Math.random() * NAME_NOUN.length)]}`;

  const profile = JSON.parse(localStorage.getItem("br-profile") || "{}");
  if (!profile.name) {
    profile.name = randomName();
    localStorage.setItem("br-profile", JSON.stringify(profile));
  }
  const nameInput = $("setting-name");
  nameInput.value = profile.name;
  renderAvatar(profile.name);
  nameInput.addEventListener("input", () => {
    profile.name = nameInput.value.trim();
    localStorage.setItem("br-profile", JSON.stringify(profile));
    renderAvatar(profile.name);
  });

  // Avatar menu — popover="manual" matches robot-menu's pattern (no native outside-click/Escape).
  // Right-anchored: menu's right edge pins to avatar's right edge, grows leftward.
  // Keeps it inside the viewport regardless of content width.
  $("avatar-btn").addEventListener("click", (e) => {
    const menu = $("avatar-menu");
    if (menu.matches(":popover-open")) {
      menu.hidePopover();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    menu.style.left = "auto";
    if (menu.showPopover) menu.showPopover();
  });
  $("menu-settings").addEventListener("click", () => {
    $("avatar-menu").hidePopover();
    $("settings-modal").showModal();
  });
  document.addEventListener("click", (e) => {
    const menu = $("avatar-menu");
    if (!menu.matches(":popover-open")) return;
    if (e.target.closest("#avatar-menu")) return;
    if (e.target.closest("#avatar-btn")) return;
    menu.hidePopover();
  });
  document.addEventListener("keydown", (e) => {
    const menu = $("avatar-menu");
    if (e.key === "Escape" && menu.matches(":popover-open")) menu.hidePopover();
  });

  $("settings-close").addEventListener("click", () => $("settings-modal").close());

  const openSetup = () => $("setup-dialog").showModal();
  $("add-robot-btn").addEventListener("click", openSetup);
  $("empty-add-robot-btn").addEventListener("click", openSetup);
  $("setup-close").addEventListener("click", () => $("setup-dialog").close());

  initGamepad();
  initMotorsKeyboard();
  initVoice({ connectAll });
  initAuthUI();
  initPasswordsUI();
  initAssistant();
  initPhones();
  setPhoneChatHandler(text => handleRemoteChat(text, { source: "phone" }));

  // Lazy-load prepare.js on first click — it's ~230 LOC and touches the File
  // System Access API; no reason to pull it into first-paint. prepare.js's
  // openDialog() runs its own initOnce() internally so one-time setup still
  // happens. ?prepare URL param keeps working via the same path.
  $("prepare-open-btn").addEventListener("click", async () => {
    const mod = await import("./prepare.js");
    await mod.openDialog();
  });
  if (new URLSearchParams(location.search).get("prepare") !== null) {
    import("./prepare.js").then(m => m.openDialog());
  }
  // Empty-state duplicate trigger so fresh dashboards without robots can still
  // pair a phone. Same handler as the one in robots-heading.
  const emptyPairBtn = $("empty-pair-phone-btn");
  if (emptyPairBtn) emptyPairBtn.addEventListener("click", () => $("pair-phone-btn")?.click());

  loadPaired().then(() => {
    highlightKnownRobotFromUrl();
  });
});
