import { SERVICE_UUID, FW_INFO_CHAR_UUID, decodeJson } from "./ble.js";
import { $, escapeHtml, wireDialogOutsideClick } from "./dom.js";
import { log, logFor, setLogRenderer } from "./log.js";
import { settings, saveSettings } from "./settings.js";
import {
  state, persist, loadKnown,
  makeEntry, entryFor, attachDevice, setDisconnectHandler,
} from "./state.js";
import { ALL as CAPABILITIES, setCapabilityRenderer } from "./capabilities/index.js";
import { RUNTIMES } from "./capabilities/runtime/index.js";
import { updateFirmware, updateFromFile } from "./capabilities/ota.js";
import { restartService, rebootRobot } from "./capabilities/runtime/command.js";
import { initRecovery, openRecoveryDialog } from "./recovery.js";
import { initPinout, openPinoutDialog } from "./pinout.js";
import { initGamepad } from "./gamepad.js";
import { initVoice } from "./voice.js";
import { initPrepare } from "./prepare.js";

setLogRenderer((entry) => renderEntry(entry));
setDisconnectHandler((id) => onDisconnected(id));
setCapabilityRenderer((entry) => renderEntry(entry));

async function loadPaired() {
  // Restore remembered robots first — works even when getDevices() is missing.
  for (const { id, name } of loadKnown()) {
    if (!state.devices.has(id)) state.devices.set(id, makeEntry(id, name));
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
  // Required on browsers without getDevices(): chooser filtered to the saved name.
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
    // A robot advertising only the service (no chars) is still "connected".
    // Every capability is optional.
    entry.status = "connected";

    // Read fw-info before cap probes — it carries the capability schema.
    try {
      const info = await service.getCharacteristic(FW_INFO_CHAR_UUID);
      entry.fwInfo = decodeJson(await info.readValue());
      entry.capSchema = entry.fwInfo?.caps || null;
    } catch {
      entry.fwInfo = null;
      entry.capSchema = null;
    }

    entry.runtimeCaps = [];
    const schemaLog = (entry.capSchema || []).map(c =>
      RUNTIMES[c.type] ? c.name : `${c.name}(no runtime for ${c.type})`
    ).join(", ");
    logFor(entry, `caps: ${schemaLog || "none declared"}`);
    for (const capSchema of entry.capSchema || []) {
      const make = RUNTIMES[capSchema.type];
      if (!make) continue;
      const cap = make(capSchema);
      Object.assign(entry, cap.initEntry());
      entry.runtimeCaps.push(cap);
    }

    for (const cap of CAPABILITIES) {
      try { await cap.probe(entry, service); } catch { /* optional */ }
    }
    for (const cap of entry.runtimeCaps) {
      try { await cap.probe(entry, service); } catch { /* optional */ }
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
  const { id, name, status } = entry;
  const connected = status === "connected";
  const connecting = status === "connecting";
  const statusText = connecting ? "Connecting…" : status === "error" ? "Error" : "";
  const dotClass = connected ? " connected" : status === "error" ? " error" : "";

  const sections = [
    ...CAPABILITIES.map(c => c.renderSection(entry)),
    ...(entry.runtimeCaps || []).map(c => c.renderSection(entry)),
  ].join("");
  entry.node.innerHTML = `
    <div class="row">
      <div>
        <div class="label"><span class="dot${dotClass}"></span>${escapeHtml(name)}</div>
        ${statusText ? `<div class="status">${statusText}</div>` : ""}
      </div>
      <div style="display: flex; gap: 4px;">
        ${connected
          ? `<button class="secondary sm" data-action="disconnect">Disconnect</button>`
          : `<button class="sm" data-action="connect" ${connecting ? "disabled" : ""}>${
              connecting ? "…" : (entry.device ? "Connect" : "Pair")
            }</button>`}
        <button class="icon" data-action="menu" aria-label="More actions">⋯</button>
      </div>
    </div>
    ${sections}
    ${entry.lastEvent ? `<div class="last-event">${escapeHtml(entry.lastEvent)}</div>` : ""}
  `;
  for (const cap of CAPABILITIES) cap.wireActions(entry, entry.node);
  for (const cap of entry.runtimeCaps || []) cap.wireActions(entry, entry.node);
  for (const cap of CAPABILITIES) cap.postRender?.(entry);
  for (const cap of entry.runtimeCaps || []) cap.postRender?.(entry);

  const connectBtn = entry.node.querySelector('[data-action="connect"]');
  if (connectBtn) connectBtn.addEventListener("click", () => connect(id));
  const disconnectBtn = entry.node.querySelector('[data-action="disconnect"]');
  if (disconnectBtn) disconnectBtn.addEventListener("click", () => disconnect(id));
  const menuBtn = entry.node.querySelector('[data-action="menu"]');
  if (menuBtn) menuBtn.addEventListener("click", () => openMenu(menuBtn, id));

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
  $("connect-all-btn").addEventListener("click", connectAll);

  wireDialogOutsideClick($("settings-modal"));
  wireDialogOutsideClick($("label-modal"));

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
  $("menu-pinout").addEventListener("click", () => {
    const id = menuTargetId;
    closeMenu();
    if (id) openPinoutDialog(id);
  });
  // Recovery lives at page-header level, not the per-robot menu: gating the
  // "BLE is dead" escape hatch behind a paired robot is the exact catch-22
  // it exists to break.
  $("recovery-btn").addEventListener("click", openRecoveryDialog);
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
  $("settings-btn").addEventListener("click", () => $("settings-modal").showModal());
  $("settings-close").addEventListener("click", () => $("settings-modal").close());

  initGamepad();
  initVoice({ connectAll });
  initPrepare();
  initRecovery();
  initPinout();

  loadPaired().then(() => {
    // Fold setup once robots exist — setup is onboarding-phase.
    $("setup-section").open = state.devices.size === 0;
    highlightKnownRobotFromUrl();
  });
});
