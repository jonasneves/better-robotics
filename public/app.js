import { SERVICE_UUID, HEARTBEAT_SVC_UUID, HEARTBEAT_CHAR_UUID,
  FW_INFO_CHAR_UUID, ROBOT_STATUS_CHAR_UUID,
  OPS_RESPONSE_CHAR_UUID, TELEMETRY_CHAR_UUID, SIGNAL_CHAR_UUID,
  decodeJson } from "./ble.js";
import { $, escapeHtml } from "./dom.js";
import { log, logFor } from "./log.js";
import { settings, saveSettings } from "./settings.js";
import {
  state, persist, loadKnown,
  makeEntry, entryFor, attachDevice, setDisconnectHandler,
} from "./state.js";
import { ALL as CAPABILITIES, setCapabilityRenderer } from "./capabilities/index.js";
import { RUNTIMES } from "./capabilities/runtime/index.js";
import { setOpen as capSetOpen } from "./capabilities/runtime/cap-section.js";
import { formatUptime, formatWifi, formatResetReason } from "./format.js";
import { updateFirmware, updateFromFile, setExpectingReconnectHandler } from "./capabilities/ota.js";
import { restartService, rebootRobot, enrollKey, getLog, getConfig } from "./capabilities/runtime/command.js";
import { initGamepad } from "./gamepad.js";
import { initMotorsKeyboard } from "./capabilities/runtime/signed-pair.js";
// prepare.js / pinout.js / recovery.js are lazy-loaded on first use (~750 LOC
// combined, none of it needed for first paint). See the dynamic import()
// calls in the DOMContentLoaded wiring below.
import { initAuthUI, fingerprint as dashFingerprint, pubkeySsh, onKeyChange } from "./auth.js";
import { initPasswordsUI } from "./passwords.js";
import { initAssistant, emitPipEvent } from "./assistant.js";
import { initPhones, broadcastTargetInfo } from "./phones.js";
import { initHelpers, setHelpersRobotRenderer, renderHelpers } from "./helpers.js";
// aruco.js is wired through helpers.js — phone helpers can be designated
// as the overhead camera; detection runs against the helper's existing
// preview tile. No init call here.
import "./aruco.js";
import {
  setupServiceWorker, wireInstallMenuItem, wireCheckUpdatesMenuItem,
  wireHardRefresh, wireDiagnosticsMenuItem, setReportIssueLink, readSwVersion,
} from "./app-menu.js";

setDisconnectHandler((id) => onDisconnected(id));
setCapabilityRenderer((entry) => renderEntry(entry));
setHelpersRobotRenderer((entry) => renderEntry(entry));
setExpectingReconnectHandler((id) => markExpectingReconnect(id));

// A phone helper's camera mounted on this robot (phone-as-eye). The video
// element is discoverable by perception.js's findCameraElement enumerator
// via [data-attached-camera-id]. srcObject is bound by renderEntry after
// innerHTML rebuild.
function attachedCameraHtml(entry) {
  if (!entry.attachedCameraStream) return "";
  return `
    <div class="cap-section attached-camera">
      <div class="cap-header">
        <div class="label">Phone camera (mounted)</div>
      </div>
      <div class="cap-body">
        <div class="attached-camera-frame">
          <video class="robot-camera" data-attached-camera-id="${escapeHtml(entry.id)}" autoplay playsinline muted></video>
        </div>
      </div>
    </div>
  `;
}

// The header meta line ("WiFi … · up …h · reset: …"). Reused by renderEntry
// (full render) and patchSecondaryRow (telemetry-driven updates that would
// otherwise flash the whole card every 10 s). Composes pure formatters
// from format.js (smoke-tested) so the display logic isn't duplicated.
function metaText(entry) {
  const connected = entry.status === "connected" || entry.status === "firmware-down";
  if (!connected) return "";
  const t = entry.telemetry;
  const parts = [
    formatWifi(entry.wifiStatus),
    formatUptime(t),
    formatResetReason(t?.reset_reason),
  ];
  // One canonical status row at the top — free RAM + temp join the
  // WiFi/uptime line so the body doesn't need a separate telemetry row.
  if (typeof t?.mem_free_mb === "number") parts.push(`${t.mem_free_mb} MB free`);
  else if (typeof t?.free_heap === "number") parts.push(`${Math.floor(t.free_heap / 1024)} KB free`);
  if (typeof t?.temp_c === "number") parts.push(`${t.temp_c.toFixed(1)}°C`);
  return parts.filter(Boolean).join(" · ");
}

// Surgical patcher for the secondary row + body telemetry line. Avoids a
// full-card innerHTML rewrite on every 10 s telemetry notify — the
// rewrite destroys/recreates the entire card DOM and reads as a flash.
// Same shape as patchOtaSection, generalized to high-frequency channels.
function patchSecondaryRow(entry) {
  const node = entry.node;
  if (!node) return;
  const meta = node.querySelector(".robot-meta");
  if (meta) {
    const t = metaText(entry);
    meta.textContent = t;
    meta.title = t;
  }
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
  // Force-expand when a phone helper just got mounted, otherwise the new
  // camera section (and any Pip-readable view of it) lives in a collapsed
  // body the user can't see. Same posture as live-busy: visibility wins.
  if (entry.attachedCameraStream) return true;
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
  for (const { id, name, fwType, autoReconnect, lastConnectedAt, arucoMarkerId } of loadKnown()) {
    if (!state.devices.has(id)) {
      state.devices.set(id, makeEntry(id, name, fwType, { autoReconnect, lastConnectedAt, arucoMarkerId }));
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
    // requestDevice requires user activation. If we got here from
    // setTimeout (auto-reconnect after OTA) there's no gesture to spend
    // — bail without firing requestDevice, otherwise we'd silently
    // SecurityError four times in a row eating the retry window for a
    // call that can never succeed without a click.
    if (!navigator.userActivation?.isActive) return;
    // Visual feedback BEFORE the chooser opens — without this, if Chrome
    // doesn't pop the picker (no matching device advertising yet) the
    // button stays on "Re-pair" with no signal that the click registered.
    // Setting connecting now flips the label to "Connecting…" and the
    // catch path below restores it on cancel.
    entry.status = "connecting";
    renderEntry(entry);
    try {
      log("re-pairing…", entry.name);
      await restoreDevice(entry);
    } catch (err) {
      // NotFoundError = user cancelled an empty/wrong picker. Either way
      // we drop back to whatever status the entry had before this click,
      // and re-render so the button stops saying "Connecting…".
      if (err.name !== "NotFoundError") logFor(entry, `re-pair cancelled: ${err.message}`);
      entry.status = entry.lastConnectError ? "error" : "idle";
      renderEntry(entry);
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
    renderHelpers();  // phone "Mount camera" picker now has a new destination.

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
          const msg = decodeJson(merged);
          if (!msg) return;
          dispatchOpsResponse(entry, msg);
        }
      });
    } catch { /* ops-response char absent on older firmware — optional */ }

    // signal char — chunked SDP exchange for WebRTC over BLE. When
    // present, webrtc-robot.js uses BLE for signaling instead of
    // wss://signal.neevs.io — fully P2P over LAN, no internet rendezvous.
    // Older firmware silently skips and falls back to the wss path.
    try {
      entry.signalChar = await service.getCharacteristic(SIGNAL_CHAR_UUID);
      await entry.signalChar.startNotifications();
      // The signaling state machine in webrtc-robot.js installs its own
      // characteristicvaluechanged listener when it initiates a session.
    } catch {
      entry.signalChar = null;
    }

    entry.runtimeCaps = [];
    for (const cap of CAPABILITIES) {
      try { await cap.probe(entry, service); } catch { /* optional */ }
    }
    await probeRuntimeCaps(entry, service);
    // Tell paired phones that motors / target are now available. Without
    // this, a phone that paired before the robot connected stays wedged
    // with target=null forever (joypad + panic-stop hidden).
    try { broadcastTargetInfo(); } catch {}
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
  // Picker on phone helper cards drops this robot now.
  renderHelpers();
  // Phones see target=null and tuck the joypad / panic-stop away.
  try { broadcastTargetInfo(); } catch {}
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
  // autoReconnect===false means user explicitly clicked disconnect — they
  // know what happened; no Pip nudge. Unexpected drops (BLE range / robot
  // power / service crash while still BLE-connected) are the useful signal.
  if (entry.autoReconnect !== false) {
    emitPipEvent("robot.disconnected", { id, name: entry.name });
    // OTA-induced disconnect: the firmware sets entry.expectingReconnectUntil
    // before its restart, so we keep retrying. Backoff 3 / 6 / 12 / 25 s
    // spreads attempts across the chip's ~10-30 s reboot window.
    if (entry.expectingReconnectUntil && Date.now() < entry.expectingReconnectUntil) {
      schedulePostOtaReconnect(id);
    }
  }
}

const POST_OTA_RECONNECT_DELAYS = [3000, 6000, 12000, 25000];
function schedulePostOtaReconnect(id, attempt = 0) {
  if (attempt >= POST_OTA_RECONNECT_DELAYS.length) return;
  setTimeout(async () => {
    const entry = state.devices.get(id);
    if (!entry) return;
    if (entry.status === "connected" || entry.status === "connecting") return;
    if (Date.now() > (entry.expectingReconnectUntil || 0)) return;
    logFor(entry, `auto-reconnect after restart (attempt ${attempt + 1}/${POST_OTA_RECONNECT_DELAYS.length})`);
    try { await connect(id); } catch {}
    const after = state.devices.get(id);
    if (after && after.status !== "connected") {
      schedulePostOtaReconnect(id, attempt + 1);
    } else if (after) {
      after.expectingReconnectUntil = 0;  // we're back; clear the marker.
    }
  }, POST_OTA_RECONNECT_DELAYS[attempt]);
}

// Called from ota.js after a commit succeeds — opens the auto-reconnect
// window so onDisconnected (which fires when the firmware reboots) knows
// to retry instead of leaving the entry idle.
export function markExpectingReconnect(id, windowMs = 60000) {
  const entry = state.devices.get(id);
  if (!entry) return;
  entry.expectingReconnectUntil = Date.now() + windowMs;
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

// Robot presence — probe each paired robot's :81/health endpoint to show
// "BR-XXXX on wifi" when the dashboard isn't BLE-connected to it. Pi-only;
// ESP32 firmware doesn't run an HTTP server (everything flows over BLE +
// WebRTC). ESP32 still appears via BLE wifi-status notify when paired.
// Pi exposes pi_robot_health.py on :81 for service-crash detection
// (pi_robot_service field).
const HEALTH_PORT = 81;
const PROBE_TIMEOUT_MS = 4000;
const PROBE_INTERVAL_MS = 30000;
let _wifiRobots = [];
const _lastRobotServiceState = new Map();

async function _probeUrl(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { mode: "cors", signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function _probeRobot(known) {
  // ESP32 firmware doesn't expose /health — presence shows up via the
  // BLE wifi-status notify when paired, not via passive probing.
  if (known.fwType === "esp32") return null;
  const candidates = [];
  if (known.name) {
    candidates.push(`http://${known.name.toLowerCase()}.local:${HEALTH_PORT}/health`);
  }
  const liveIp = state.devices.get(known.id)?.wifiStatus?.ip;
  if (liveIp) candidates.push(`http://${liveIp}:${HEALTH_PORT}/health`);
  if (!candidates.length) return null;
  const results = await Promise.allSettled(candidates.map(_probeUrl));
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) return r.value;
  }
  return null;
}

let _probeTimer = null;
async function _probeTick() {
  const known = loadKnown();
  const found = [];
  await Promise.all(known.map(async (r) => {
    const health = await _probeRobot(r);
    if (!health) return;
    const id = r.id;
    // active→inactive transition surfaces as a service-crash event so
    // Pip can nudge the user toward recovery.
    const now = health.pi_robot_service;
    const was = _lastRobotServiceState.get(id);
    if (was === "active" && now && now !== "active") {
      emitPipEvent("robot.service_crashed", { name: r.name || id });
    }
    if (now !== undefined) _lastRobotServiceState.set(id, now);
    found.push({ id, name: r.name, ...health });
  }));
  _wifiRobots = found;
  renderRobotPresence();
}

function initRobotPresence() {
  if (_probeTimer) return;
  _probeTick();
  _probeTimer = setInterval(_probeTick, PROBE_INTERVAL_MS);
}

function renderRobotPresence() {
  const badge = $("robot-presence");
  if (!badge) return;
  if (_wifiRobots.length === 0) { badge.hidden = true; return; }
  badge.hidden = false;
  badge.textContent = _wifiRobots.length === 1
    ? `${_wifiRobots[0].name || "Robot"} on wifi`
    : `${_wifiRobots.length} robots on wifi`;
}

function render() {
  const list = $("robot-list");
  const empty = $("empty-state");
  const header = $("robots-heading");

  updateQrHint();

  if (state.devices.size === 0) {
    // Robots are the platform; their pair affordances stay visible whether
    // or not the operator has phone helpers. A "Set up a robot" prompt is
    // never wrong — phones are an addition, not a substitute.
    empty.hidden = false;
    header.hidden = true;
    list.innerHTML = "";
    return;
  }
  empty.hidden = true;
  header.hidden = false;

  const ids = new Set(state.devices.keys());
  for (const child of [...list.children]) {
    if (!ids.has(child.dataset.robotId)) child.remove();
  }

  let prev = null;
  for (const entry of state.devices.values()) {
    if (!entry.node) {
      entry.node = document.createElement("section");
      entry.node.className = "card robot";
      entry.node.dataset.robotId = entry.id;
    }
    renderEntry(entry);
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
  const { id, status } = entry;
  const name = entry.name;
  const firmwareDown = status === "firmware-down";
  // GATT IS connected when firmwareDown — only the main service is missing.
  // Treat as connected for button purposes so the user gets Disconnect.
  const connected = status === "connected" || firmwareDown;
  const connecting = status === "connecting";
  const statusText = status === "error"
    ? (/no longer in range|not found/i.test(entry.lastConnectError || "") ? "Out of range" : "Error")
    : firmwareDown ? "Firmware down"
    : "";
  // Card-style status hint via a colored left edge stripe (see
  // .robot.connected etc. in styles.css).
  entry.node.classList.toggle("status-connected",     status === "connected");
  entry.node.classList.toggle("status-connecting",    connecting);
  entry.node.classList.toggle("status-error",         status === "error");
  entry.node.classList.toggle("status-firmware-down", firmwareDown);

  // Canonical capability order across robot types so the eye lands on the same
  // control in the same place on both Pi and ESP32 cards. Unknown names fall
  // to the end in schema order.
  // OTA renders at the top of the body when active — it's a transient
  // operation that demands attention, not a parked control. Other caps
  // keep their canonical order so the eye lands on each in the same
  // place across robots. OTA only emits markup when in flight, so this
  // ordering is a no-op in steady state.
  const CAP_ORDER = { ota: 0, led: 1, motors: 2, wifi: 3, camera: 4, ops: 5 };
  const byOrder = (a, b) => (CAP_ORDER[a.name] ?? 99) - (CAP_ORDER[b.name] ?? 99);
  // Schema is flat (each cap is its own BLE characteristic) but the operator's
  // mental model isn't — Flash and Snapshot are sub-controls of the Camera.
  // Render-tree groups them under their parent so the card mirrors the model
  // instead of the wire shape. Mapping is dashboard-side, no firmware change.
  const PARENT_MAP = { flash: "camera", snapshot: "camera" };
  const allCaps = [];
  for (const c of CAPABILITIES) allCaps.push({ cap: c });
  for (const c of entry.runtimeCaps || []) allCaps.push({ cap: c });
  const childrenOf = new Map();
  const topCaps = [];
  for (const item of allCaps) {
    const parent = PARENT_MAP[item.cap.name];
    if (parent) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(item);
    } else {
      topCaps.push(item);
    }
  }
  const capByOrder = (a, b) => byOrder(a.cap, b.cap);
  const sections = topCaps
    .slice()
    .sort(capByOrder)
    .map(({ cap }) => {
      const kids = (childrenOf.get(cap.name) || []).slice().sort(capByOrder);
      const childHtml = kids.map(k => k.cap.renderSection(entry)).join("");
      return cap.renderSection(entry, { childHtml });
    })
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
    ? `<span class="type-badge type-${escapeHtml(entry.fwType)}">${
        escapeHtml(entry.fwType === "esp32" ? "ESP32" : entry.fwType.toUpperCase())
      }</span>`
    : "";
  // metaText() composes the WiFi/uptime/reset/RAM/temp row from format.js
  // helpers; reused by patchSecondaryRow on the high-frequency telemetry
  // notify path, so the display logic stays in one place. Always emit the
  // wrapper (even empty) so the patcher can fill it without a full
  // re-render. CSS :empty hides it. title carries the full text so a
  // truncated row stays hover-discoverable.
  const metaJoined = metaText(entry);
  const metaRow = `<div class="robot-meta" title="${escapeHtml(metaJoined)}">${escapeHtml(metaJoined)}</div>`;

  // Active-ops chips: at-a-glance "what's happening right now" without
  // having to expand each capability section.
  const activeOps = [];
  if (status === "connected" || firmwareDown) {
    if (entry.cameraRunning || entry.cameraStream) {
      activeOps.push({ text: "streaming" });
    }
    if ((entry.motorLeft || 0) !== 0 || (entry.motorRight || 0) !== 0) {
      activeOps.push({ text: `motors L:${entry.motorLeft || 0} R:${entry.motorRight || 0}` });
    }
    if ((entry.flashLevel || 0) > 0) activeOps.push({ text: `flash ${entry.flashLevel}%` });
    if (entry.otaStatus?.st && entry.otaStatus.st !== "idle") {
      const oSt = entry.otaStatus.st;
      const total = entry.otaStatus.total || 0;
      const n = entry.otaStatus.n || entry.otaSent || 0;
      const pct = total ? Math.round(100 * n / total) : 0;
      activeOps.push({
        op: "ota",
        text: total ? `OTA ${oSt} ${pct}%` : `OTA ${oSt}`,
      });
    }
    if (entry.snapshotBusy) activeOps.push({ text: "snapshotting…" });
  }
  const opsRow = activeOps.length
    ? `<div class="robot-ops">${activeOps.map(o =>
        `<span class="op-chip"${o.op ? ` data-op="${o.op}"` : ""}>${escapeHtml(o.text)}</span>`,
      ).join("")}</div>`
    : "";
  // Split on the last hyphen so the common "BetterRobot-" prefix dims and the
  // distinguishing suffix ("E9D4") carries the visual weight. Names without a
  // hyphen render plainly.
  const dash = name.lastIndexOf("-");
  const hasSplit = dash > 0 && dash < name.length - 1;
  const nameInner = hasSplit
    ? `<span class="name-prefix">${escapeHtml(name.slice(0, dash + 1))}</span><span class="name-suffix">${escapeHtml(name.slice(dash + 1))}</span>`
    : escapeHtml(name);
  // Wrap so the name span can truncate independently of chevron + badge —
  // otherwise a long name + ESP32 pill overflows into the Disconnect button.
  const nameHtml = `<span class="robot-name" title="${escapeHtml(name)}">${nameInner}</span>`;
  const expanded = computeExpanded(entry);
  entry.node.classList.toggle("expanded", expanded);
  // Capture the live MJPEG <img> before innerHTML wipes it. Tearing it
  // down aborts the multipart/x-mixed-replace HTTP response and forces
  // the ESP32 streamTask to detect a client disconnect + accept a fresh
  // connection — costly. If the new render still expects the same src,
  // we transplant the live element back so the stream keeps flowing.
  const liveCameraImg = entry.node.querySelector("img.robot-camera[data-cam-id]");
  const liveCameraReady = liveCameraImg?.complete && liveCameraImg.naturalWidth > 0;
  entry.node.innerHTML = `
    <div class="row">
      <div class="robot-identity">
        <button class="label-btn" data-action="toggle-expand" aria-expanded="${expanded}">
          <svg class="icon-svg disclosure-chevron" aria-hidden="true"><use href="icons.svg#icon-chevron-down"/></svg>
          ${typeBadge}${nameHtml}
        </button>
        ${statusText ? `<div class="status">${statusText}</div>` : ""}
      </div>
      <div class="robot-actions">
        ${connected
          ? ""
          : `<button class="sm" data-action="connect" ${connecting ? "disabled" : ""}>${
              connecting ? "Connecting…"
              : entry.staleHandle ? "Re-pair"
              : entry.device && (entry.consecutiveFailures || 0) >= AUTO_RECONNECT_MAX_FAILURES ? "Retry"
              : entry.device ? "Connect"
              : "Pair"
            }</button>`}
        <button class="icon" data-action="menu" aria-label="More actions"><svg class="icon-svg"><use href="icons.svg#icon-more"/></svg></button>
      </div>
    </div>
    <div class="robot-secondary">
      ${metaRow}
      ${opsRow}
    </div>
    ${entry.staleHandle && !connected && !connecting ? `
      <div class="meta robot-stale-hint">
        Pick ${escapeHtml(entry.name)} again to reconnect. The robot's pairing isn't affected.
      </div>
    ` : ""}
    ${stateHtml}
    ${firmwareDown ? `
      <div class="firmware-down-banner">
        <div class="label">pi-robot.service: ${escapeHtml(entry.heartbeat?.pi_robot || "down")}</div>
        <div class="meta">Only the heartbeat plane is responding — capabilities (LED, motors, WiFi, OTA) are unavailable until the firmware comes back.</div>
        ${entry.heartbeat?.ip ? `<div class="meta">SSH: <code>ssh robot@${escapeHtml(entry.heartbeat.ip)}</code></div>` : `<div class="meta">No IP — robot isn't on WiFi. Use the USB-C serial console.</div>`}
        <div class="row" style="margin-top:8px;">
          <button class="secondary sm" data-action="open-recovery">Open serial console</button>
        </div>
      </div>
    ` : ""}
    ${expanded && !firmwareDown ? `
      <div class="robot-body">
        ${enrollHtml}
        ${sections}
        ${attachedCameraHtml(entry)}
      </div>
    ` : ""}
  `;
  // Transplant the preserved live MJPEG img if the new render expects the
  // same src — keeps the multipart HTTP response uninterrupted across
  // re-renders. The fresh placeholder src is identical (same robot IP +
  // port), so the user sees no flash and the ESP32 doesn't see a reconnect.
  if (liveCameraReady) {
    const placeholder = entry.node.querySelector(
      `img.robot-camera[data-cam-id="${entry.id}"]`,
    );
    if (placeholder && placeholder.src === liveCameraImg.src) {
      placeholder.parentNode.replaceChild(liveCameraImg, placeholder);
    }
  }
  // Bind the attached-camera MediaStream after innerHTML rebuild — srcObject
  // can't survive an innerHTML reset, and querying for the new <video> needs
  // the DOM to exist.
  if (entry.attachedCameraStream) {
    const v = entry.node.querySelector(`video[data-attached-camera-id="${entry.id}"]`);
    if (v) v.srcObject = entry.attachedCameraStream;
  }
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
  if (recoveryBtn) recoveryBtn.addEventListener("click", () => openConsole("pi"));
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
  $("menu-restart").hidden = !entry?.opsChar;
  $("menu-reboot").hidden  = !entry?.opsChar;
  $("menu-log").hidden     = !entry?.opsChar;
  // Shell is Pi-only (no shell on ESP32). pi-robot-rtc.service must be
  // installed; if it's not, the connect button surfaces a clear error.
  $("menu-shell").hidden   = !(entry?.fwType === "pi" && entry?.status === "connected");
  $("menu-pinout").hidden  = !(entry?.status === "connected" && entry?.fwInfo);
  $("menu-update").hidden       = !entry?.otaDataChar;
  $("menu-disconnect").hidden = !(entry?.status === "connected" || entry?.status === "firmware-down");
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
  // NOTE: don't clear menuTargetId — handlers read it after closeMenu()
  // returns. openMenu sets it on next open.
}

function robotUrl(name) {
  return `${location.origin}${location.pathname}?robot=${encodeURIComponent(name)}`;
}

function openLabel(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  const url = robotUrl(entry.name);
  $("label-title").textContent = entry.name;
  const labelUrl = $("label-url");
  labelUrl.textContent = url;
  labelUrl.dataset.url = url;
  labelUrl.classList.remove("copied");
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

// Service worker + update banner. SW lifecycle is intentional: we never
// auto-skip-waiting on background detection — show a banner so the user
// triggers the swap. Explicit "Check for updates" clicks (wired below
// via app-menu.js) auto-apply.
function showSwUpdateBanner(worker) {
  if (document.getElementById("sw-update-banner")) return;  // already shown
  const bar = document.createElement("div");
  bar.id = "sw-update-banner";
  bar.innerHTML = `
    <span>New dashboard version available.</span>
    <button class="sm" id="sw-update-reload">Reload</button>
    <button class="icon" id="sw-update-dismiss" aria-label="Dismiss"><svg class="icon-svg"><use href="icons.svg#icon-x"/></svg></button>
  `;
  document.body.appendChild(bar);
  document.getElementById("sw-update-reload").addEventListener("click", () => {
    worker.postMessage("skip-waiting");
  });
  document.getElementById("sw-update-dismiss").addEventListener("click", () => bar.remove());
}
setupServiceWorker({ onUnsolicitedUpdate: showSwUpdateBanner });

// Console (Pi USB-C + ESP32 USB serial) — unified entry point. Mode is
// remembered across sessions via localStorage; explicit mode argument
// wins (e.g. firmware-down banner opens Pi mode regardless).
async function openConsole(mode) {
  const m = mode || localStorage.getItem("console-mode") || "pi";
  await _setConsoleMode(m);
  if (!$("console-modal").open) $("console-modal").showModal();
}
async function _setConsoleMode(mode) {
  $("console-pi-section").hidden = mode !== "pi";
  $("console-esp-section").hidden = mode !== "esp";
  $("console-mode-pi")?.setAttribute("aria-pressed", String(mode === "pi"));
  $("console-mode-esp")?.setAttribute("aria-pressed", String(mode === "esp"));
  if (mode === "pi") {
    const mod = await import("./recovery.js");
    mod.init();
  } else {
    const mod = await import("./esp-serial.js");
    mod.init();
  }
}

// Recovery menu (BetterRobotics dropdown) — wired FIRST in DOMContentLoaded
// inside try/catch so a failure later in init can never strand the user
// without Hard Refresh. Uses optional chaining on every $() lookup so a
// single missing element doesn't abort the rest of the wiring. Same panda
// principle the firmware applies: the recovery layer enforced *below* the
// failure-prone intelligent layer.
function wireRecoveryMenu() {
  const appMenuBtn = $("app-menu-btn");
  const appMenu = $("app-menu");
  if (!appMenuBtn || !appMenu) return;
  appMenuBtn.addEventListener("click", (e) => {
    if (appMenu.matches(":popover-open")) { appMenu.hidePopover(); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    appMenu.style.top = `${rect.bottom + 6}px`;
    appMenu.style.left = `${Math.max(8, rect.left)}px`;
    appMenu.style.right = "auto";
    if (appMenu.showPopover) appMenu.showPopover();
  });
  document.addEventListener("click", (e) => {
    if (!appMenu.matches(":popover-open")) return;
    if (e.target.closest("#app-menu")) return;
    if (e.target.closest("#app-menu-btn")) return;
    appMenu.hidePopover();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && appMenu.matches(":popover-open")) appMenu.hidePopover();
  });
  $("menu-phone-view")?.addEventListener("click", () => appMenu.hidePopover());
  $("menu-report-issue")?.addEventListener("click", () => appMenu.hidePopover());
  // Version + report-issue link. Read VERSION from sw.js (CI stamps it
  // on every dashboard-asset change). Both the menu display and the
  // report-issue body get the running commit + UA + URL prefilled.
  readSwVersion().then(version => {
    const v = $("app-menu-version"); if (v) v.textContent = version;
    const r = $("menu-report-issue"); if (r) setReportIssueLink(r, version);
  }).catch(() => {});
  wireInstallMenuItem({
    btnId: "menu-install",
    iosPopoverId: "install-ios-popover",
    onClick: () => appMenu.hidePopover(),
  });
  wireCheckUpdatesMenuItem({ btnId: "menu-check-updates" });
  wireDiagnosticsMenuItem({
    getTelemetrySources: () => Array.from(state.devices.values()),
    onBeforeOpen: () => appMenu.hidePopover(),
  });
  wireHardRefresh({ onBeforeOpen: () => appMenu.hidePopover() });
}

document.addEventListener("DOMContentLoaded", () => {
  // Wire the recovery menu FIRST and in isolation. Anything throwing in
  // the rest of init can no longer strand the user without Hard Refresh.
  try { wireRecoveryMenu(); } catch (err) { console.error("[recovery-menu]", err); }
  // Browsers without Web Bluetooth (iOS Safari is the common case — a
  // phone user who navigated phone → "Open dashboard view") still need
  // the chrome to work: BetterRobotics menu, PWA install, update check,
  // random profile name. Surface the unsupported banner + disable BLE-only
  // buttons, then let the rest of init run.
  const hasBLE = !!navigator.bluetooth;
  if (!hasBLE) {
    $("unsupported").hidden = false;
    $("scan-btn").disabled = true;
    $("empty-scan-btn").disabled = true;
  } else if (navigator.bluetooth.getAvailability) {
    navigator.bluetooth.getAvailability().then(setBluetoothAvailable);
    navigator.bluetooth.addEventListener("availabilitychanged", (e) => {
      setBluetoothAvailable(e.value);
    });
  }

  $("scan-btn").addEventListener("click", scanForNew);
  $("empty-scan-btn").addEventListener("click", scanForNew);
  $("qr-hint-pair").addEventListener("click", scanForNew);


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
    const entry = state.devices.get(id);
    if (entry?.otaDataChar) openUpdateDialog(id);
  });
  function openUpdateDialog(id) {
    const entry = state.devices.get(id);
    if (!entry) return;
    const dialog = $("update-fw-dialog");
    const sourceEl = $("update-fw-source");
    const latestBtn = $("update-fw-latest");
    // Mirror the source-resolution logic in updateFirmware: Pi falls back to
    // the default manifest path when fwInfo is partial; ESP32 uses fwInfo.url.
    const bundleUrl = entry.fwInfo?.bundle_url
      || (entry.otaDataChar && !entry.fwInfo?.url ? "firmware/pi_robot/ota-manifest.json" : null);
    const url = bundleUrl || entry.fwInfo?.url;
    if (url) {
      sourceEl.textContent = url;
      sourceEl.hidden = false;
      latestBtn.disabled = false;
    } else {
      sourceEl.textContent = "(no published source — pick a local file instead)";
      sourceEl.hidden = false;
      latestBtn.disabled = true;
    }
    latestBtn.onclick = () => { dialog.close(); updateFirmware(id); };
    $("update-fw-file").onclick = () => { dialog.close(); updateFromFile(id); };
    dialog.showModal();
  }
  $("update-fw-close").addEventListener("click", () => $("update-fw-dialog").close());
  $("update-fw-cancel").addEventListener("click", () => $("update-fw-dialog").close());
  $("menu-restart").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (state.devices.get(id)?.opsChar) restartService(id);
  });
  $("menu-reboot").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (state.devices.get(id)?.opsChar) rebootRobot(id);
  });
  let logTimeoutId = null;
  let logTailRobotId = null;   // robot whose log dialog is currently open
  let logTailChannel = null;   // open WebRTC logs channel, if tailing
  function stopLogTail() {
    if (logTailChannel) {
      try { logTailChannel.send(JSON.stringify({ type: "stop" })); } catch {}
      try { logTailChannel.close(); } catch {}
      logTailChannel = null;
    }
    if (logTailRobotId) {
      // Lazy-import to keep webrtc-robot.js out of the eager bundle.
      import("./webrtc-robot.js").then((m) => m.closePeer(logTailRobotId)).catch(() => {});
    }
    $("log-dialog-status").hidden = true;
    $("log-dialog-tail").textContent = "Tail live";
  }
  $("menu-log").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    const entry = state.devices.get(id);
    if (!entry?.opsChar) return;
    logTailRobotId = id;
    $("log-dialog-title").textContent = `Log · ${entry?.name || "robot"}`;
    $("log-dialog-body").textContent = "Loading…";
    // Tail-live is Pi-only (journalctl) and needs a name to find the WebRTC
    // peer's room. Hide the button on robots that don't qualify.
    $("log-dialog-tail").hidden = !(entry?.fwType === "pi" && entry?.name);
    $("log-dialog-tail").textContent = "Tail live";
    $("log-dialog-status").hidden = true;
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
  $("log-dialog-tail").addEventListener("click", async () => {
    if (logTailChannel) { stopLogTail(); return; }
    const id = logTailRobotId;
    if (!id) return;
    const entry = state.devices.get(id);
    if (!entry) return;
    $("log-dialog-status").hidden = false;
    $("log-dialog-tail").textContent = "Stop";
    const body = $("log-dialog-body");
    body.textContent = "Connecting to live log…\n";
    try {
      const { openChannel } = await import("./webrtc-robot.js");
      logTailChannel = await openChannel(id, entry.name, "logs", {
        onStatus: (s) => { body.textContent = `${s}\n`; },
        robotType: entry.fwType,
        signalChar: entry.signalChar,
      });
    } catch (err) {
      body.textContent = `Couldn't reach pi-robot-rtc: ${err.message || err}\n`;
      stopLogTail();
      return;
    }
    body.textContent = "";  // clear connection-status so the journal owns it
    logTailChannel.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      // Pi may send {"type":"error",...} alongside log lines; treat as line
      // either way (errors are useful in the body).
      body.textContent += e.data;
      // Auto-scroll to bottom — `<pre>` doesn't follow new content by default.
      body.scrollTop = body.scrollHeight;
    });
    logTailChannel.addEventListener("close", () => stopLogTail());
    logTailChannel.send(JSON.stringify({ type: "follow", unit: "pi-robot.service" }));
  });
  $("log-dialog-close").addEventListener("click", () => {
    if (logTimeoutId) { clearTimeout(logTimeoutId); logTimeoutId = null; }
    stopLogTail();
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
    const entry = state.devices.get(id);
    if (!entry || entry.status !== "connected" || !entry.fwInfo) return;
    const mod = await import("./pinout.js");
    mod.openPinoutDialog(id);
  });
  // Shell — lazy-import so xterm.js + WebRTC plumbing only load when the
  // user actually opens a terminal session. Pi-only.
  $("menu-shell").addEventListener("click", async () => {
    const id = menuTargetId;
    closeMenu();
    const entry = state.devices.get(id);
    if (!entry || entry.fwType !== "pi" || entry.status !== "connected") return;
    const mod = await import("./shell.js");
    mod.openShellDialog(id);
  });
  // Recovery lives in the avatar menu, not the per-robot menu: gating the
  // "BLE is dead" escape hatch behind a paired robot is the exact catch-22
  // it exists to break. The avatar menu has zero BLE dependency.
  $("menu-gpio-ref").addEventListener("click", async () => {
    $("avatar-menu").hidePopover();
    const mod = await import("./pinout.js");
    mod.openPinoutReference();
  });
  $("menu-console").addEventListener("click", () => {
    $("avatar-menu").hidePopover();
    openConsole();
  });
  for (const id of ["console-mode-pi", "console-mode-esp"]) {
    $(id)?.addEventListener("click", async (e) => {
      const mode = e.currentTarget.dataset.mode;
      localStorage.setItem("console-mode", mode);
      await _setConsoleMode(mode);
    });
  }
  $("menu-scripts").addEventListener("click", async () => {
    $("avatar-menu").hidePopover();
    const mod = await import("./scripts.js");
    mod.init();
    mod.openScriptsDialog();
  });
  // (BetterRobotics dropdown wiring moved to wireRecoveryMenu(), called
  // first in this DOMContentLoaded inside try/catch — see top of file.)

  $("label-close").addEventListener("click", () => $("label-modal").close());
  const labelUrlEl = $("label-url");
  let _labelCopyTimer = null;
  async function copyLabelUrl() {
    const original = labelUrlEl.dataset.url || labelUrlEl.textContent;
    try {
      await navigator.clipboard.writeText(original);
      labelUrlEl.textContent = "Copied";
      labelUrlEl.classList.add("copied");
      clearTimeout(_labelCopyTimer);
      _labelCopyTimer = setTimeout(() => {
        labelUrlEl.textContent = original;
        labelUrlEl.classList.remove("copied");
      }, 1500);
    } catch {}
  }
  labelUrlEl.addEventListener("click", copyLabelUrl);
  labelUrlEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copyLabelUrl(); }
  });
  $("label-print").addEventListener("click", () => window.print());
  $("menu-disconnect").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    const m = state.devices.get(id);
    if (m && (m.status === "connected" || m.status === "firmware-down")) disconnect(id);
  });
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

  // Pip backend, API keys, GitHub auth, vision, and local-LLM install all
  // moved to slash commands (/model, /vision, /install) — managed in
  // assistant.js. /model is contextual: picking a backend that needs
  // auth or a key prompts inline. Settings keeps only identity + advanced
  // one-time setup.

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
  const nameHint = $("setting-name-hint");
  function saveProfile() { localStorage.setItem("br-profile", JSON.stringify(profile)); }
  // Identity flows from settings.githubAuth — one OAuth grant powers both
  // the username display AND the GitHub Models Pip backend. /model github
  // (in assistant.js) triggers the OAuth dance when not yet signed in.
  function displayName() {
    return settings.githubAuth?.username || profile.name;
  }
  function syncIdentityUI() {
    const signedIn = !!settings.githubAuth?.username;
    nameInput.value = displayName();
    nameInput.disabled = signedIn;
    nameHint.textContent = signedIn
      ? "Signed in with GitHub — name is from your account."
      : "Stored in this browser only. Run /model github to sign in.";
    renderAvatar(displayName());
  }
  // Exposed so the /model handler can refresh the UI after sign-in lands.
  window.__syncIdentityUI = syncIdentityUI;
  syncIdentityUI();
  nameInput.addEventListener("input", () => {
    if (settings.githubAuth) return;  // disabled, but defensive
    profile.name = nameInput.value.trim();
    saveProfile();
    renderAvatar(displayName());
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

  // Pre-flash cleanup. esp-web-install-button has no hook to run code
  // before it calls port.open(), and any port we (or a prior install
  // session) left open makes its open() throw "port is already open".
  // Capture-phase listener fires before ewt's bubble handler, kicks off
  // an async release that completes well before the user finishes the
  // port picker, leaving the port unlocked when ewt finally opens it.
  document.querySelector("esp-web-install-button")?.addEventListener("click", () => {
    Promise.all([
      import("./recovery.js").then(m => m.releasePort?.()).catch(() => {}),
      import("./esp-serial.js").then(m => m.releasePort?.()).catch(() => {}),
    ]).then(async () => {
      if (!("serial" in navigator)) return;
      try {
        const ports = await navigator.serial.getPorts();
        await Promise.all(ports.map(p => p.close().catch(() => {})));
      } catch {}
    });
  }, true);

  initGamepad();
  initMotorsKeyboard();
  initAuthUI();
  initPasswordsUI();
  // Pip is additive; if it can't init (CDN failure, regression in pip-core,
  // bad cached SW), the rest of the dashboard must keep working. Fence the
  // call so a Pip throw doesn't take down BLE / phones / robot presence.
  // assistant.js exports already early-return when _pip is undefined.
  try { initAssistant(); } catch (err) { console.error("[pip] init failed:", err); }
  initPhones();
  initHelpers();
  initRobotPresence();

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
  loadPaired().then(() => {
    highlightKnownRobotFromUrl();
  });
});
