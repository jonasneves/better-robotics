import { SERVICE_UUID, HEARTBEAT_SVC_UUID, HEARTBEAT_CHAR_UUID,
  FW_INFO_CHAR_UUID, ROBOT_STATUS_CHAR_UUID,
  OPS_RESPONSE_CHAR_UUID, TELEMETRY_CHAR_UUID, decodeJson } from "./ble.js";
import { $, escapeHtml } from "./dom.js";
import { log, logFor } from "./log.js";
import { settings, saveSettings } from "./settings.js";
import {
  state, persist, loadKnown, loadRobots, robotFor, mergeRobots, splitMember,
  setCapSourcePref,
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
import { initAssistant, handleRemoteChat, emitPipEvent } from "./assistant.js";
import { initPhones, setPhoneChatHandler, broadcastTargetInfo, sendArucoStatus } from "./phones.js";
import { getLoadState as getLocalLoadState, onLoadStateChange as onLocalLoadStateChange, loadModel as loadLocalModel } from "./local-llm.js";
import { initHelpers, setHelpersRobotRenderer, renderHelpers, hasActiveHelpers, onHelpersChange } from "./helpers.js";
import { startTracking as startArucoTracking, stopTracking as stopArucoTracking } from "./aruco.js";
import {
  setupServiceWorker, wireInstallMenuItem, wireCheckUpdatesMenuItem,
  wireHardRefresh, setReportIssueLink, readSwVersion,
} from "./app-menu.js";

setDisconnectHandler((id) => onDisconnected(id));
setCapabilityRenderer((entry) => renderEntry(entry));
setHelpersRobotRenderer((entry) => renderEntry(entry));
setExpectingReconnectHandler((id) => markExpectingReconnect(id));

// A phone helper's camera mounted on this robot (phone-as-eye). The video
// element is discoverable by perception.js's findCameraElement enumerator
// via [data-attached-camera-id]. srcObject is bound by renderEntry after
// innerHTML rebuild. The SVG sibling is the ArUco debug overlay — sized
// to match the video's natural dims via patchArucoOverlay so corner
// coords from aruco.js (image-pixel) don't need re-scaling per render.
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
          <svg class="aruco-overlay" data-aruco-overlay-id="${escapeHtml(entry.id)}"></svg>
        </div>
        <div class="meta aruco-help">
          <a href="https://chev.me/arucogen/" target="_blank" rel="noopener">Print marker</a>
          — "Original ArUco" dictionary, id 0, tape flat on top of the robot.
        </div>
        <div class="meta aruco-status" data-aruco-status-id="${escapeHtml(entry.id)}">Loading detector…</div>
      </div>
    </div>
  `;
}

// Surgical patcher for the ArUco debug overlay. Called from the tracker
// each tick — mutates the SVG in place so a 10 Hz detection rhythm
// doesn't trigger full-card re-renders that would destroy other
// in-flight UI (perception prompt, hover state, etc).
//
// `frameCount` in the status is load-bearing diagnostic — without it,
// "detector still loading", "loop running but nothing found", and
// "loop wedged" all read identically to the operator.
function patchArucoOverlay(entry, { markers, frameCount, error }) {
  const node = entry.node;
  if (!node) return;
  const svg = node.querySelector(`svg[data-aruco-overlay-id="${entry.id}"]`);
  if (!svg) return;
  const status = node.querySelector(`[data-aruco-status-id="${entry.id}"]`);
  if (error) {
    if (svg) svg.innerHTML = "";
    if (status) {
      status.classList.remove("aruco-locked");
      status.textContent = `Detector error: ${error}`;
    }
    return;
  }
  if (markers.length === 0) {
    svg.innerHTML = "";
    if (status) {
      status.classList.remove("aruco-locked");
      status.textContent = `Scanning · ${frameCount} frame${frameCount === 1 ? "" : "s"} · no marker yet`;
    }
    // Push to phone-as-eye holder so they see lock state without checking
    // the dashboard. Only on lock-state transitions to keep the data
    // channel quiet (10 Hz of no-marker pings would be churn for nothing).
    if (entry.attachedFromPhoneId && entry.arucoLastLocked !== false) {
      sendArucoStatus(entry.attachedFromPhoneId, { locked: false, detail: "Scanning for marker…" });
      entry.arucoLastLocked = false;
    }
    return;
  }
  const { frameW, frameH } = markers[0];
  svg.setAttribute("viewBox", `0 0 ${frameW} ${frameH}`);
  // preserveAspectRatio default ("xMidYMid meet") matches how the video
  // is letterboxed in its container — corners line up.
  const pieces = [];
  for (const m of markers) {
    const pts = m.corners.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
    // Heading line from center along the marker's "top edge" direction.
    const len = Math.min(frameW, frameH) * 0.08;
    const hx = m.cx + Math.cos(m.headingRad) * len;
    const hy = m.cy + Math.sin(m.headingRad) * len;
    pieces.push(`<polygon points="${pts}" />`);
    pieces.push(`<line x1="${m.cx.toFixed(1)}" y1="${m.cy.toFixed(1)}" x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}" class="heading" />`);
    pieces.push(`<text x="${m.cx.toFixed(1)}" y="${m.cy.toFixed(1)}" dy="-8">id ${m.id}</text>`);
  }
  svg.innerHTML = pieces.join("");
  if (status) {
    status.classList.add("aruco-locked");
    const ids = markers.map(m => `id ${m.id}`).join(", ");
    status.textContent = `Tracking ${ids} · frame ${frameCount}`;
  }
  // Phone-side lock indicator. Send on transition into locked AND on
  // marker-id change while locked; suppress while still locked on the
  // same id to avoid 10 Hz traffic.
  if (entry.attachedFromPhoneId) {
    const primaryId = markers[0].id;
    if (entry.arucoLastLocked !== true || entry.arucoLastMarkerId !== primaryId) {
      sendArucoStatus(entry.attachedFromPhoneId, { locked: true, markerId: primaryId });
      entry.arucoLastLocked = true;
      entry.arucoLastMarkerId = primaryId;
    }
  }
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
  // Free RAM + temp folded in here so the body's separate telemetry
  // line (which duplicated uptime) can be dropped — one canonical
  // status row at the top instead of two.
  if (typeof t?.mem_free_mb === "number") parts.push(`${t.mem_free_mb} MB free`);
  else if (typeof t?.free_heap === "number") parts.push(`${Math.floor(t.free_heap / 1024)} KB free`);
  if (typeof t?.temp_c === "number") parts.push(`${t.temp_c.toFixed(1)}°C`);
  return parts.filter(Boolean).join(" · ");
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
  for (const { id, name, fwType, autoReconnect, lastConnectedAt } of loadKnown()) {
    if (!state.devices.has(id)) {
      state.devices.set(id, makeEntry(id, name, fwType, { autoReconnect, lastConnectedAt }));
    }
  }
  // Hydrate the robots layer (working.md item F). loadRobots auto-wraps any
  // device that isn't already a member of some robot as a one-member robot,
  // so pre-migration users land with the same one-card-per-device shape.
  loadRobots();
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
  // Passive scan when the browser supports it — no chooser modal, robots
  // appear inline as they advertise. Falls back to requestDevice's chooser
  // when requestLEScan is missing (Chrome flag off, or non-Chromium).
  if (navigator.bluetooth.requestLEScan) {
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
  // BR-* name filter (firmware naming, see pi_robot.py:326). Two Chrome
  // quirks to navigate:
  //   1. event.device.name is persistent state and stays null until pairing;
  //      the per-ad local name is on event.name. Read both — whichever shows
  //      up first wins.
  //   2. Most ESP32/Pi BLE stacks put the local name in SCAN_RESP, not the
  //      31-byte AD payload. With keepRepeatedDevices:false, Chrome can fire
  //      one nameless event for the AD then dedupe the SCAN_RESP follow-up.
  //      Setting it true makes Chrome fire each frame so we eventually see
  //      one with the name.
  const onAdv = (event) => {
    const name = event.name || event.device.name;
    if (!name || !name.startsWith("BR-")) return;
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
      acceptAllAdvertisements: true,
      keepRepeatedDevices: true,
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
    // before its restart, so we know to keep trying. Without this the user
    // had to click Connect manually after every OTA — every reboot read as
    // "user error: just reconnect" when actually the dashboard knew the
    // disconnect was coming and could've retried itself. Backoff at 3 / 6 /
    // 12 / 25 s spreads attempts across the chip's ~10-30 s reboot window.
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
  // Drop this device from its robot. If it was the only member, the robot
  // disappears entirely; otherwise the surviving members keep the robot
  // alive (forgetting one device of an ESP32-eye + Pi-brain robot leaves
  // the other half behind, which is the right shape).
  for (const r of [...state.robots.values()]) {
    const i = r.members.indexOf(id);
    if (i < 0) continue;
    r.members.splice(i, 1);
    if (r.members.length === 0) state.robots.delete(r.id);
    break;
  }
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

// Robot presence — probe each paired robot's :81/health endpoint. mDNS
// resolves <name>.local on the same LAN (firmware-side: ESP32 advertises
// via ESPmDNS, Pi via avahi). Cached live-IP from the BLE wifi-status
// notify covers the same-NAT-but-mDNS-blocked case (iPhone hotspot,
// strict guest WiFi). First OK response wins. No internet rendezvous
// for robot presence — signal.neevs.io still hosts phone-pair, but
// robots no longer publish there. See CLAUDE.md transport-discipline.
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
  // Race mDNS hostname against the live cached IP from BLE wifi-status.
  // Promise.allSettled lets both run; we take the first non-null.
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
    // Pi /health includes pi_robot_service; same active→inactive transition
    // detection the WS-based path used to do, just sourced from the probe.
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

  if (state.robots.size === 0) {
    // Empty state means "no operating surface AT ALL". A user with phone
    // helpers paired or laptop camera streaming has a working surface; the
    // "Set up a robot" prompt is wrong for them.
    empty.hidden = hasActiveHelpers();
    header.hidden = true;
    list.innerHTML = "";
    return;
  }
  empty.hidden = true;
  header.hidden = false;
  updateHeaderActions();

  // Card-per-robot (working.md item F). Each robot has a single DOM node,
  // shared by every member entry — so cap modules' in-place patchers
  // (.cap-state querySelectors etc.) keep working without learning about
  // the composition. The robot id is used as the dataset key; for the
  // single-member case (universal pre-migration) it equals the deviceId.
  const robotIds = new Set(state.robots.keys());
  for (const child of [...list.children]) {
    if (!robotIds.has(child.dataset.robotId)) child.remove();
  }

  let prev = null;
  for (const robot of state.robots.values()) {
    if (!robot.node) {
      robot.node = document.createElement("section");
      robot.node.className = "card robot";
      robot.node.dataset.robotId = robot.id;
    }
    // Point every member's entry.node at the shared robot node, so calls
    // to renderEntry(member) and surgical patchers find the right DOM.
    const members = robot.members.map(id => state.devices.get(id)).filter(Boolean);
    for (const m of members) m.node = robot.node;
    if (members.length) renderEntry(members[0]);
    const target = prev ? prev.nextSibling : list.firstChild;
    if (target !== robot.node) {
      if (prev) prev.after(robot.node); else list.prepend(robot.node);
    }
    prev = robot.node;
  }
}

function renderEntry(entryArg) {
  if (!entryArg.node) { render(); return; }
  // Resolve robot context. After Pass 1 auto-migration, every device is its
  // own one-member robot — so members === [entryArg] and the rest of this
  // function behaves identically. Multi-member robots (created by explicit
  // merge in Pass 3) flow through the same path with multiple member
  // entries contributing caps; the cap loop below fans out across them.
  const robot = robotFor(entryArg.id);
  const members = robot
    ? robot.members.map(mId => state.devices.get(mId)).filter(Boolean)
    : [entryArg];
  if (!members.length) return;
  // Primary member drives top-level concerns (header status, telemetry,
  // fwInfo, otaStatus). Prefer the entry whose notify triggered this render
  // (entryArg) so callbacks reading "their" connection state see the right
  // shape; fall back to any connected member; finally first member.
  const primary = members.find(m => m === entryArg && m.status === "connected")
              || members.find(m => m.status === "connected")
              || members.find(m => m === entryArg)
              || members[0];
  const entry = primary;
  const displayName = robot?.name || entry.name;
  const isComposite = members.length > 1;
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
  const name = displayName;
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
  // First pass: index runtime caps by name so we can detect conflicts
  // (multiple members declaring the same cap). The user picks a winner
  // via robot.capSourcePrefs (set by the cap-section's swap button); the
  // default is first-member-wins. The other members' versions become
  // "alternatives" that surface a swap affordance on the rendered section.
  const capContributors = new Map();  // capName -> [{cap, member}, ...]
  for (const m of members) {
    for (const c of m.runtimeCaps || []) {
      if (!capContributors.has(c.name)) capContributors.set(c.name, []);
      capContributors.get(c.name).push({ cap: c, member: m });
    }
  }
  const prefs = robot?.capSourcePrefs || {};
  // Pick the active contributor for each cap: explicit pref wins; else
  // member order (which equals pair / merge order, user-controllable).
  // Build allCaps: OTA per-member (independent operations), runtime caps
  // deduped to the chosen contributor.
  const allCaps = [];
  for (const m of members) {
    for (const c of CAPABILITIES) allCaps.push({ cap: c, member: m });
  }
  for (const [capName, contributors] of capContributors) {
    const preferred = prefs[capName]
      ? contributors.find(x => x.member.id === prefs[capName])
      : null;
    const chosen = preferred || contributors[0];
    const alternatives = contributors
      .filter(x => x.member.id !== chosen.member.id)
      .map(x => x.member.id);
    // Pass source attribution + alternatives through to the cap's
    // renderSection so capSection can render a source chip + swap button.
    // Single-source caps see alternatives = [] and render with just the
    // chip; conflicts get the swap icon. Single-member robots see
    // sourceMember = null (no chip — type is in the header).
    allCaps.push({
      cap: chosen.cap, member: chosen.member,
      sourceMember: isComposite ? chosen.member : null,
      alternativeMemberIds: alternatives,
    });
  }
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
    .map(({ cap, member, sourceMember, alternativeMemberIds }) => {
      const kids = (childrenOf.get(cap.name) || []).slice().sort(capByOrder);
      const childHtml = kids.map(k => k.cap.renderSection(k.member, {
        sourceMember: k.sourceMember, alternativeMemberIds: k.alternativeMemberIds,
      })).join("");
      return cap.renderSection(member, {
        childHtml, sourceMember, alternativeMemberIds,
      });
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
  // Type badge in the header is for single-member robots only — when the
  // robot is composite, the per-member chips below carry the same info
  // with richer detail (status dot + type + member name), so duplicating
  // it in the title would be noise. Reframe under signal-to-noise:
  // a composite robot doesn't HAVE a type, its members do; the header is
  // the robot's identity, the chips are the contents.
  const typeBadge = (!isComposite && entry.fwType)
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
  // having to expand each capability section. Each cap surfaces its
  // running-state in its own row; this strip aggregates them so a list
  // of robots reads "this one is streaming + this one is OTAing"
  // without per-card eye-walks.
  // Active-ops aggregate across members — if either the ESP32 or the Pi is
  // streaming, the composite robot is streaming. OTA stays anchored to the
  // primary's chip (only one OTA at a time across the robot in practice).
  const activeOps = [];
  const anyConnected = members.some(m => m.status === "connected" || m.status === "firmware-down");
  if (anyConnected) {
    if (members.some(m => m.cameraRunning || m.cameraStream)) {
      activeOps.push({ text: "streaming" });
    }
    const motorMember = members.find(m => (m.motorLeft || 0) !== 0 || (m.motorRight || 0) !== 0);
    if (motorMember) {
      activeOps.push({ text: `motors L:${motorMember.motorLeft || 0} R:${motorMember.motorRight || 0}` });
    }
    const flashMember = members.find(m => (m.flashLevel || 0) > 0);
    if (flashMember) activeOps.push({ text: `flash ${flashMember.flashLevel}%` });
    const otaMember = members.find(m => m.otaStatus?.st && m.otaStatus.st !== "idle");
    if (otaMember) {
      const oSt = otaMember.otaStatus.st;
      const total = otaMember.otaStatus.total || 0;
      const n = otaMember.otaStatus.n || otaMember.otaSent || 0;
      const pct = total ? Math.round(100 * n / total) : 0;
      activeOps.push({
        op: "ota",
        text: total ? `OTA ${oSt} ${pct}%` : `OTA ${oSt}`,
      });
    }
    if (members.some(m => m.snapshotBusy)) activeOps.push({ text: "snapshotting…" });
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
    ${isComposite ? `
      <div class="robot-members" role="list">
        ${members.map(m => {
          const memSt = m.status === "connected" ? "connected"
                      : m.status === "firmware-down" ? "fw-down"
                      : m.status === "connecting" ? "connecting"
                      : m.status === "error" ? "error"
                      : "offline";
          const dot = `<span class="member-dot member-dot-${memSt}"></span>`;
          const badge = m.fwType
            ? `<span class="type-badge type-${escapeHtml(m.fwType)}">${escapeHtml(m.fwType === "esp32" ? "ESP32" : m.fwType.toUpperCase())}</span>`
            : "";
          return `<span class="member-chip" role="listitem" title="${escapeHtml(m.name)}">${dot}${badge}<span class="member-name">${escapeHtml(m.name)}</span></span>`;
        }).join("")}
      </div>
    ` : ""}
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
        ${entry.heartbeat?.ip ? `<div class="meta">SSH: <code>ssh robot@${escapeHtml(entry.heartbeat.ip)}</code></div>` : `<div class="meta">No IP — robot isn't on WiFi. Use the USB-C recovery console.</div>`}
        <div class="row" style="margin-top:8px;">
          <button class="secondary sm" data-action="open-recovery">Open recovery console</button>
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
    // Lazy-start ArUco tracking. The tracker is idempotent (returns if
    // already running) — sourceFn re-resolves the <video> each tick so a
    // re-render that swaps the element doesn't strand the loop.
    startArucoTracking(
      entry.id,
      () => entry.node?.querySelector(`video[data-attached-camera-id="${entry.id}"]`),
      (result) => patchArucoOverlay(entry, result),
    );
  } else {
    stopArucoTracking(entry.id);
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
  // Cap-source swap. Only present on .cap-section when this cap has more
  // than one contributing member. Cycles through alternatives by setting
  // the robot's capSourcePref → next member; the next render picks that
  // member's cap instance instead of first-member-wins.
  entry.node.querySelectorAll("[data-action^='cap-swap-']").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const capName = btn.dataset.action.replace(/^cap-swap-/, "");
      const myRobot = robotFor(entry.id);
      if (!myRobot) return;
      // Build the cycle: every member that declared this cap, in member
      // order. The currently-active one comes from prefs (or first).
      const contributors = [];
      for (const mid of myRobot.members) {
        const m = state.devices.get(mid);
        if (!m) continue;
        if ((m.runtimeCaps || []).some(c => c.name === capName)) contributors.push(mid);
      }
      if (contributors.length < 2) return;
      const currentId = myRobot.capSourcePrefs?.[capName] || contributors[0];
      const nextIdx = (contributors.indexOf(currentId) + 1) % contributors.length;
      const nextId = contributors[nextIdx];
      // First entry of the cycle == default (first-member-wins) — clear
      // the pref instead of pinning, so the model stays "user has only
      // explicitly chosen if there's a pref."
      setCapSourcePref(myRobot.id, capName, nextId === contributors[0] ? null : nextId);
      renderEntry(entry);
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
  // Per-device menu items show when ANY member satisfies the predicate (on
  // composite robots; the click handler then asks which member to target).
  // Single-member robots collapse to today's gating: just check the entry.
  const myRobot = robotFor(entry?.id);
  const allMembers = (myRobot?.members || [])
    .map(id => state.devices.get(id))
    .filter(Boolean);
  const anyMember = (pred) => allMembers.length
    ? allMembers.some(pred)
    : (entry && pred(entry));
  // Ops-dependent items: restart, reboot, view log. ESP32 has no opsChar,
  // so on a Pi+ESP32 composite these still target the Pi (only matching
  // member). On a single-ESP32 robot they're hidden — same as today.
  $("menu-restart").hidden = !anyMember(m => !!m.opsChar);
  $("menu-reboot").hidden  = !anyMember(m => !!m.opsChar);
  $("menu-log").hidden     = !anyMember(m => !!m.opsChar);
  // Pinout dialog handles both platforms; ANY connected member with fw-info
  // makes the item available. The handler picks among matching members.
  $("menu-pinout").hidden  = !anyMember(m => m.status === "connected" && m.fwInfo);
  // Update firmware: any member with otaDataChar (both Pi and ESP32 have it
  // on connect). Composite robots get a per-member picker on click.
  $("menu-update").hidden       = !anyMember(m => !!m.otaDataChar);
  $("menu-update-file").hidden  = !anyMember(m => !!m.otaDataChar);
  // Disconnect is robot-level — applies to ALL connected members. Hide
  // when no member is connected.
  $("menu-disconnect").hidden = !anyMember(m => m.status === "connected");
  // Merge requires at least one OTHER robot to combine with. Split only
  // appears when this robot has multiple members (composition exists to be
  // undone). Both work whether or not the device is currently connected.
  const otherRobotCount = [...state.robots.values()].filter(r => r.id !== myRobot?.id).length;
  $("menu-merge").hidden = otherRobotCount === 0;
  $("menu-split").hidden = !(myRobot && myRobot.members.length > 1);
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

document.addEventListener("DOMContentLoaded", () => {
  // Browsers without Web Bluetooth (iOS Safari is the common case — a phone
  // user who navigated phone → "Open dashboard view") still need the chrome
  // to work: they should be able to open the BetterRobotics menu, install
  // the PWA, check for updates, get a random profile name. The earlier
  // early-return killed every wiring below it, so the menu was inert and
  // the avatar stayed at "?". Now: surface the unsupported banner + disable
  // BLE-only buttons, but let the rest of init run.
  const hasBLE = !!navigator.bluetooth;
  if (!hasBLE) {
    $("unsupported").hidden = false;
    $("scan-btn").disabled = true;
    $("empty-scan-btn").disabled = true;
    $("connect-all-btn").disabled = true;
  } else if (navigator.bluetooth.getAvailability) {
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

  // Composite robots have multiple members — per-device menu actions
  // (Pinout, Update firmware, Restart, Reboot, View log) need to ask
  // WHICH member they target. Single-member robots collapse to "no
  // picker, just the only member." Predicate filters to members the
  // action makes sense for (e.g., Pinout needs fwInfo; restart needs
  // ops channel). Returns the chosen deviceId or null on cancel.
  async function chooseMemberForAction(label, predicate) {
    const robotId = menuTargetId;
    if (!robotId) return null;
    const robot = robotFor(robotId);
    const members = (robot?.members || [])
      .map(id => state.devices.get(id))
      .filter(m => m && predicate(m));
    if (members.length === 0) return null;
    if (members.length === 1) return members[0].id;
    const lines = members.map((m, i) =>
      `${i + 1}. ${m.name}${m.fwType ? ` (${m.fwType.toUpperCase()})` : ""}`
    );
    const pick = prompt(`${label} — pick a device:\n\n${lines.join("\n")}\n\nEnter number, or Cancel:`);
    const idx = parseInt(pick, 10) - 1;
    if (!Number.isFinite(idx) || idx < 0 || idx >= members.length) return null;
    return members[idx].id;
  }

  $("menu-label").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (id) openLabel(id);
  });
  $("menu-update").addEventListener("click", async () => {
    closeMenu();
    const id = await chooseMemberForAction("Update firmware", m => !!m.otaDataChar);
    if (id) updateFirmware(id);
  });
  $("menu-update-file").addEventListener("click", async () => {
    closeMenu();
    const id = await chooseMemberForAction("Update from file", m => !!m.otaDataChar);
    if (id) updateFromFile(id);
  });
  $("menu-restart").addEventListener("click", async () => {
    closeMenu();
    const id = await chooseMemberForAction("Restart service", m => !!m.opsChar);
    if (id) restartService(id);
  });
  $("menu-reboot").addEventListener("click", async () => {
    closeMenu();
    const id = await chooseMemberForAction("Reboot robot", m => !!m.opsChar);
    if (id) rebootRobot(id);
  });
  let logTimeoutId = null;
  $("menu-log").addEventListener("click", async () => {
    closeMenu();
    const id = await chooseMemberForAction("View log", m => !!m.opsChar);
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
    closeMenu();
    const id = await chooseMemberForAction(
      "Edit pins", m => m.status === "connected" && m.fwInfo,
    );
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
  $("app-menu-btn").addEventListener("click", (e) => {
    const menu = $("app-menu");
    if (menu.matches(":popover-open")) { menu.hidePopover(); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.left = `${Math.max(8, rect.left)}px`;
    menu.style.right = "auto";
    if (menu.showPopover) menu.showPopover();
  });
  document.addEventListener("click", (e) => {
    const menu = $("app-menu");
    if (!menu.matches(":popover-open")) return;
    if (e.target.closest("#app-menu")) return;
    if (e.target.closest("#app-menu-btn")) return;
    menu.hidePopover();
  });
  document.addEventListener("keydown", (e) => {
    const menu = $("app-menu");
    if (e.key === "Escape" && menu.matches(":popover-open")) menu.hidePopover();
  });
  $("menu-phone-view").addEventListener("click", () => $("app-menu").hidePopover());
  $("menu-report-issue").addEventListener("click", () => $("app-menu").hidePopover());
  // Version + report-issue link. Read VERSION from sw.js (CI stamps it
  // on every dashboard-asset change). Both the menu display and the
  // report-issue body get the running commit + UA + URL prefilled —
  // arriving reports skip a triage round.
  readSwVersion().then(version => {
    $("app-menu-version").textContent = version;
    setReportIssueLink($("menu-report-issue"), version);
  });
  wireInstallMenuItem({
    btnId: "menu-install",
    iosPopoverId: "install-ios-popover",
    onClick: () => $("app-menu").hidePopover(),
  });
  wireCheckUpdatesMenuItem({ btnId: "menu-check-updates" });
  wireHardRefresh({
    openBtnId: "menu-hard-refresh",
    dialogId: "hard-refresh-dialog",
    closeBtnId: "hard-refresh-close",
    cancelBtnId: "hard-refresh-cancel",
    confirmBtnId: "hard-refresh-confirm",
    onBeforeOpen: () => $("app-menu").hidePopover(),
  });

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
    closeMenu();
    // Robot-level: disconnect every connected member of this robot. The
    // user thinks of "the robot is offline," not "this device's link
    // dropped." Sequential to avoid concurrent BLE disconnect glitches.
    const robot = robotFor(menuTargetId);
    const ids = (robot?.members || [menuTargetId]).filter(Boolean);
    for (const id of ids) {
      const m = state.devices.get(id);
      if (m && (m.status === "connected" || m.status === "firmware-down")) disconnect(id);
    }
  });
  $("menu-merge").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (!id) return;
    const myRobot = robotFor(id);
    if (!myRobot) return;
    const candidates = [...state.robots.values()].filter(r => r.id !== myRobot.id);
    if (!candidates.length) return;
    // Minimal native picker for now — list each other robot with member
    // count, accept a single keystroke. A nicer dialog can replace this
    // once we have a feel for how often merges actually happen.
    const lines = candidates.map((r, i) =>
      `${i + 1}. ${r.name}${r.members.length > 1 ? ` (${r.members.length} members)` : ""}`,
    );
    const pick = prompt(
      `Merge "${myRobot.name}" into which robot?\n\n${lines.join("\n")}\n\nEnter number, or Cancel:`,
    );
    const idx = parseInt(pick, 10) - 1;
    if (!Number.isFinite(idx) || idx < 0 || idx >= candidates.length) return;
    const dest = candidates[idx];
    if (!confirm(`Merge "${myRobot.name}" into "${dest.name}"?\n\nBoth devices will appear as one robot. Reversible from the merged robot's menu.`)) return;
    mergeRobots(myRobot.id, dest.id);
    persist();
    render();
  });
  $("menu-split").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (!id) return;
    splitMember(id);
    persist();
    render();
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

  // Pip backend picker — bridge (default), Anthropic direct, OpenAI direct,
  // local (LFM2.5 in-browser via WebGPU).
  const backendSelect = $("setting-pip-backend");
  const backendHint = $("setting-pip-backend-hint");
  const githubRow       = $("setting-pip-github-row");
  const githubStatusEl  = $("setting-pip-github-status");
  const githubDotEl     = $("setting-pip-github-dot");
  const githubConnectBtn = $("setting-pip-github-connect");
  const anthropicKeyRow = $("setting-pip-anthropic-key-row");
  const openaiKeyRow    = $("setting-pip-openai-key-row");
  const localRow        = $("setting-pip-local-row");
  const anthropicKeyInput = $("setting-pip-key");
  const openaiKeyInput    = $("setting-pip-openai-key");
  const localStatusEl   = $("setting-pip-local-status");
  const localProgressEl = $("setting-pip-local-progress");
  const localInstallBtn = $("setting-pip-local-install");
  const localDotEl      = $("setting-pip-local-dot");
  // One line each — keep the dropdown's hint scannable. Detailed explanation
  // lives in claude.js's module header for the developer audience; the
  // settings page is for the operator picking a backend, not learning the
  // protocol. Don't compare against "the default" by name — defaults change.
  const HINTS = {
    github:    "OAuth with GitHub once; no API key. Free-tier rate-limited.",
    bridge:    "Routes through the AI Bridge Chrome extension; token stays in macOS Keychain.",
    anthropic: "Direct call to api.anthropic.com with your API key. Stored in this browser.",
    openai:    "Direct call to api.openai.com with your API key. Stored in this browser.",
    local:     "Runs in-browser via WebGPU (LFM2.5-1.2B). 1.2 GB one-time download; output capped at 512 tokens.",
  };
  const visionRow   = $("setting-pip-vision-row");
  const visionInput = $("setting-pip-vision");
  // Vision tool wires the Anthropic image-in-tool_result content shape; the
  // OpenAI / GitHub Models / local backends would need a different content-
  // block packing that isn't in place. Gate accordingly.
  const VISION_BACKENDS = new Set(["bridge", "anthropic"]);
  function syncGithubUI() {
    const auth = settings.pipGithubAuth;
    githubDotEl.className = "dot";
    if (auth?.username) {
      githubStatusEl.textContent = `@${auth.username}`;
      githubDotEl.classList.add("connected");
      githubConnectBtn.textContent = "Disconnect";
    } else {
      githubStatusEl.textContent = "Not connected";
      githubConnectBtn.textContent = "Connect GitHub";
    }
  }
  function syncBackendUI() {
    const b = settings.pipBackend || "github";
    backendSelect.value = b;
    backendHint.textContent = HINTS[b] || "";
    githubRow.hidden       = b !== "github";
    anthropicKeyRow.hidden = b !== "anthropic";
    openaiKeyRow.hidden    = b !== "openai";
    localRow.hidden        = b !== "local";
    visionRow.hidden       = !VISION_BACKENDS.has(b);
    anthropicKeyInput.value = settings.pipApiKey || "";
    openaiKeyInput.value    = settings.pipOpenaiKey || "";
    visionInput.checked     = !!settings.pipVisionEnabled;
    if (b === "github") syncGithubUI();
  }
  syncBackendUI();
  // GitHub OAuth — connectGitHub from the shared neevs.io auth helper that
  // robot-studio already uses. Lazy-loaded the first time the button is
  // tapped so a user who never picks GitHub doesn't pay the import cost.
  let _connectGitHubFn = null;
  async function _loadConnectGitHub() {
    if (_connectGitHubFn) return _connectGitHubFn;
    const mod = await import("https://neevs.io/auth/connect.js");
    _connectGitHubFn = mod.connectGitHub;
    return _connectGitHubFn;
  }
  githubConnectBtn.addEventListener("click", async () => {
    if (settings.pipGithubAuth) {
      // Disconnect — clear token + UI. The OAuth grant on GitHub's side
      // remains until the user revokes it; we just stop holding the token.
      settings.pipGithubAuth = null;
      saveSettings();
      syncGithubUI();
      return;
    }
    githubConnectBtn.disabled = true;
    githubConnectBtn.textContent = "Connecting…";
    try {
      const connect = await _loadConnectGitHub();
      const auth = await connect("read:user", "better-robotics");
      settings.pipGithubAuth = { username: auth.username, token: auth.token };
      saveSettings();
      syncGithubUI();
    } catch (err) {
      githubStatusEl.textContent = `Connect failed: ${err.message || err}`;
      githubDotEl.className = "dot error";
      githubConnectBtn.textContent = "Try again";
    } finally {
      githubConnectBtn.disabled = false;
    }
  });
  backendSelect.addEventListener("change", () => {
    settings.pipBackend = backendSelect.value;
    saveSettings();
    syncBackendUI();
  });
  visionInput.addEventListener("change", () => {
    settings.pipVisionEnabled = visionInput.checked;
    saveSettings();
  });
  // Save keys on blur, not per-keystroke — avoids persisting partial pastes
  // and keeps the storage write off the typing critical path.
  anthropicKeyInput.addEventListener("blur", () => {
    settings.pipApiKey = anthropicKeyInput.value.trim();
    saveSettings();
  });
  openaiKeyInput.addEventListener("blur", () => {
    settings.pipOpenaiKey = openaiKeyInput.value.trim();
    saveSettings();
  });

  // Local-LLM install + load status. Wired even when the row is hidden so the
  // status reflects loads kicked off from a previous session opening.
  function refreshLocalUI(s) {
    // Reset dot + button variant; set per-state below.
    localDotEl.className = "dot";
    localInstallBtn.className = "";
    if (s.status === "loading") {
      const file = s.file ? ` ${s.file}` : "";
      localStatusEl.textContent = `Loading${file} (${s.progress || 0}%)`;
      localDotEl.classList.add("connecting");
      localProgressEl.hidden = false;
      localProgressEl.value = s.progress || 0;
      localInstallBtn.disabled = true;
      localInstallBtn.textContent = "Loading…";
    } else if (s.status === "ready") {
      localStatusEl.textContent = "Ready";
      localDotEl.classList.add("connected");
      localProgressEl.hidden = true;
      localInstallBtn.disabled = false;
      localInstallBtn.className = "secondary";
      localInstallBtn.textContent = "Reload";
    } else if (s.status === "error") {
      localStatusEl.textContent = `Error: ${s.error || "unknown"}`;
      localDotEl.classList.add("error");
      localProgressEl.hidden = true;
      localInstallBtn.disabled = false;
      localInstallBtn.textContent = "Retry";
    } else {
      localStatusEl.textContent = "Not installed";
      localProgressEl.hidden = true;
      localInstallBtn.disabled = false;
      localInstallBtn.textContent = "Install (1.2 GB)";
    }
  }
  onLocalLoadStateChange(refreshLocalUI);
  refreshLocalUI(getLocalLoadState());
  localInstallBtn.addEventListener("click", () => {
    loadLocalModel().catch((err) => {
      console.warn("[local-llm] install failed", err);
    });
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
  initAuthUI();
  initPasswordsUI();
  initAssistant();
  initPhones();
  setPhoneChatHandler(text => handleRemoteChat(text, { source: "phone" }));
  initHelpers();
  // Empty-state visibility depends on whether helpers are active, not just
  // whether robots are. Re-run render() whenever helpers change so a phone
  // pairing or laptop start/stop can suppress the "Set up a robot" prompt.
  onHelpersChange(() => { if (state.robots.size === 0) render(); });
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
