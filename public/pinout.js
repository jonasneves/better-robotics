import { $, escapeHtml } from "./dom.js";
import { state } from "./state.js";
import { getConfig } from "./capabilities/runtime/command.js";
import { onOpsResponse } from "./ops-response.js";
import { uploadFile } from "./capabilities/ota.js";

// BCM GPIO numbers are what capability config and firmware use; the physical
// pin number is what the header silkscreen shows. Users wire against physical
// pins, so we lead with those.
// [phys, label, kind] — kind ∈ {"3v3", "5v", "gnd", "gpio", "i2c-id"}
const PINS = [
  [ 1, "3V3",   "3v3"], [ 2, "5V",    "5v"],
  [ 3, "GPIO2", "gpio"],[ 4, "5V",    "5v"],
  [ 5, "GPIO3", "gpio"],[ 6, "GND",   "gnd"],
  [ 7, "GPIO4", "gpio"],[ 8, "GPIO14","gpio"],
  [ 9, "GND",   "gnd"], [10, "GPIO15","gpio"],
  [11, "GPIO17","gpio"],[12, "GPIO18","gpio"],
  [13, "GPIO27","gpio"],[14, "GND",   "gnd"],
  [15, "GPIO22","gpio"],[16, "GPIO23","gpio"],
  [17, "3V3",   "3v3"], [18, "GPIO24","gpio"],
  [19, "GPIO10","gpio"],[20, "GND",   "gnd"],
  [21, "GPIO9", "gpio"],[22, "GPIO25","gpio"],
  [23, "GPIO11","gpio"],[24, "GPIO8", "gpio"],
  [25, "GND",   "gnd"], [26, "GPIO7", "gpio"],
  [27, "ID_SD", "i2c-id"],[28, "ID_SC", "i2c-id"],
  [29, "GPIO5", "gpio"],[30, "GND",   "gnd"],
  [31, "GPIO6", "gpio"],[32, "GPIO12","gpio"],
  [33, "GPIO13","gpio"],[34, "GND",   "gnd"],
  [35, "GPIO19","gpio"],[36, "GPIO16","gpio"],
  [37, "GPIO26","gpio"],[38, "GPIO20","gpio"],
  [39, "GND",   "gnd"], [40, "GPIO21","gpio"],
];

const GPIO_TO_PHYS = new Map(
  PINS.filter(([, lbl]) => lbl.startsWith("GPIO"))
      .map(([phys, lbl]) => [parseInt(lbl.slice(4), 10), phys]),
);

// Supports both flat {role: gpio} and nested {left: {in1: 17, in2: 27}} shapes.
function flattenPins(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const label = prefix ? `${prefix} ${k}` : k;
    if (typeof v === "number") out.push([label, v]);
    else if (v && typeof v === "object") out.push(...flattenPins(v, label));
  }
  return out;
}

function claimsFromEntry(entry) {
  const claims = {};
  for (const cap of entry?.capSchema || []) {
    if (cap.pin != null) {
      const phys = GPIO_TO_PHYS.get(cap.pin);
      if (phys) claims[phys] = { cap: cap.name, role: cap.pin_mode || cap.type };
    }
    for (const [role, gpio] of flattenPins(cap.pins)) {
      const phys = GPIO_TO_PHYS.get(gpio);
      if (phys) claims[phys] = { cap: cap.name, role };
    }
  }
  return claims;
}

function renderBoard(claims) {
  const cells = [];
  for (let i = 0; i < PINS.length; i += 2) {
    const [lp, ll, lk] = PINS[i];
    const [rp, rl, rk] = PINS[i + 1];
    const lc = claims[lp];
    const rc = claims[rp];
    cells.push(`
      <div class="pin-row">
        <div class="pin-cell side-l kind-${lk} ${lc ? "claimed" : ""}">
          ${lc ? `<span class="pin-claim">${escapeHtml(lc.cap)} · ${escapeHtml(lc.role)}</span>` : ""}
          <span class="pin-label">${escapeHtml(ll)}</span>
          <span class="pin-num">${lp}</span>
        </div>
        <div class="pin-cell side-r kind-${rk} ${rc ? "claimed" : ""}">
          <span class="pin-num">${rp}</span>
          <span class="pin-label">${escapeHtml(rl)}</span>
          ${rc ? `<span class="pin-claim">${escapeHtml(rc.cap)} · ${escapeHtml(rc.role)}</span>` : ""}
        </div>
      </div>
    `);
  }
  return `<div class="pinout">${cells.join("")}</div>`;
}

// State for edit mode. Scoped per-open-dialog; cleared on close.
let currentId = null;
let editMode = false;
let editConfig = null;   // parsed pi-robot.conf contents
let awaitingConfig = false;
let awaitingTimer = null;
const CONFIG_RESPONSE_TIMEOUT_MS = 6000;

function claimsFromConfig(cfg) {
  // Build a claims map identical to claimsFromEntry but from the live conf
  // being edited, so preview reflects uncommitted edits before save.
  const claims = {};
  if (cfg?.led_enabled && cfg.led_pin != null) {
    const phys = GPIO_TO_PHYS.get(cfg.led_pin);
    if (phys) claims[phys] = { cap: "led", role: "out" };
  }
  if (cfg?.motors_enabled && cfg.motors_pins) {
    for (const [role, gpio] of flattenPins(cfg.motors_pins)) {
      const phys = GPIO_TO_PHYS.get(gpio);
      if (phys) claims[phys] = { cap: "motors", role };
    }
  }
  return claims;
}

function pinInput(label, value, onchange) {
  // Bare input; caller wires oninput to keep editConfig in sync.
  return `
    <label class="pinout-edit-row">
      <span class="pinout-edit-label">${escapeHtml(label)}</span>
      <input type="number" min="0" max="27" class="pinout-edit-input"
             data-role="${escapeHtml(onchange)}" value="${value ?? ""}">
    </label>
  `;
}

function renderView(entry) {
  const claims = claimsFromEntry(entry);
  const legend = Object.entries(claims).length
    ? `<div class="meta">Colored rows are declared in <code>pi-robot.conf</code>.</div>`
    : `<div class="meta">No GPIO capabilities declared for this robot.</div>`;
  const connected = entry?.status === "connected" && entry?.opsChar && entry?.otaDataChar;
  const editBtn = connected
    ? `<button class="secondary sm" id="pinout-edit-btn">Edit pins</button>`
    : "";
  $("pinout-body").innerHTML = `
    ${renderBoard(claims)}
    <div class="row" style="margin-top: 12px;">${legend}${editBtn}</div>
  `;
  $("pinout-edit-btn")?.addEventListener("click", () => beginEdit(entry.id));
}

function renderEdit(entry) {
  const c = editConfig || {};
  const claims = claimsFromConfig(c);
  const ledChecked = c.led_enabled ? "checked" : "";
  const motorsChecked = c.motors_enabled ? "checked" : "";
  const cameraChecked = c.camera_enabled !== false ? "checked" : "";
  const motors = c.motors_pins || {};
  const ml = motors.left || {};
  const mr = motors.right || {};
  // Detect duplicate GPIO usage across enabled caps — warn the user before save.
  const usage = {};
  if (c.led_enabled && c.led_pin != null) (usage[c.led_pin] ||= []).push("led");
  if (c.motors_enabled) {
    for (const [role, g] of flattenPins(motors)) (usage[g] ||= []).push(`motors.${role}`);
  }
  const conflicts = Object.entries(usage).filter(([, v]) => v.length > 1);
  const warn = conflicts.length
    ? `<div class="pinout-warn">Conflict: ${conflicts.map(([g, list]) =>
        `GPIO ${g} claimed by ${list.join(" + ")}`).join("; ")}</div>`
    : "";
  $("pinout-body").innerHTML = `
    ${renderBoard(claims)}
    <div class="pinout-edit">
      <div class="pinout-edit-section">
        <label class="pinout-edit-row">
          <input type="checkbox" data-toggle="led_enabled" ${ledChecked}>
          <span>LED</span>
        </label>
        <label class="pinout-edit-row" style="padding-left: 24px;">
          <span class="pinout-edit-label">GPIO</span>
          <input type="number" min="0" max="27" class="pinout-edit-input"
                 data-path="led_pin" value="${c.led_pin ?? 17}">
        </label>
      </div>
      <div class="pinout-edit-section">
        <label class="pinout-edit-row">
          <input type="checkbox" data-toggle="motors_enabled" ${motorsChecked}>
          <span>Motors (H-bridge)</span>
        </label>
        <div style="padding-left: 24px;">
          <label class="pinout-edit-row">
            <span class="pinout-edit-label">Left IN1</span>
            <input type="number" min="0" max="27" class="pinout-edit-input"
                   data-path="motors_pins.left.in1" value="${ml.in1 ?? 17}">
          </label>
          <label class="pinout-edit-row">
            <span class="pinout-edit-label">Left IN2</span>
            <input type="number" min="0" max="27" class="pinout-edit-input"
                   data-path="motors_pins.left.in2" value="${ml.in2 ?? 27}">
          </label>
          <label class="pinout-edit-row">
            <span class="pinout-edit-label">Right IN1</span>
            <input type="number" min="0" max="27" class="pinout-edit-input"
                   data-path="motors_pins.right.in1" value="${mr.in1 ?? 23}">
          </label>
          <label class="pinout-edit-row">
            <span class="pinout-edit-label">Right IN2</span>
            <input type="number" min="0" max="27" class="pinout-edit-input"
                   data-path="motors_pins.right.in2" value="${mr.in2 ?? 24}">
          </label>
        </div>
      </div>
      <div class="pinout-edit-section">
        <label class="pinout-edit-row">
          <input type="checkbox" data-toggle="camera_auto" ${cameraChecked}>
          <span>Camera (auto-detect)</span>
        </label>
      </div>
      <div class="meta" style="margin-top: 12px;">Numbers are BCM GPIO IDs (the GPIO# label on the board), not physical pin positions.</div>
      ${warn}
      <div class="modal-footer">
        <button class="secondary sm" id="pinout-cancel-btn">Cancel</button>
        <button class="sm" id="pinout-save-btn" ${conflicts.length ? "disabled" : ""}>Save &amp; restart</button>
      </div>
    </div>
  `;
  // Wire inputs — keep editConfig in sync + re-render so conflict banner
  // updates live.
  $("pinout-body").querySelectorAll("input[data-toggle]").forEach(el => {
    el.addEventListener("change", () => {
      const key = el.dataset.toggle;
      if (key === "camera_auto") editConfig.camera_enabled = el.checked ? "auto" : false;
      else editConfig[key] = el.checked;
      renderEdit(entry);
    });
  });
  $("pinout-body").querySelectorAll("input[data-path]").forEach(el => {
    el.addEventListener("input", () => {
      const path = el.dataset.path.split(".");
      const v = parseInt(el.value, 10);
      if (Number.isNaN(v)) return;
      let obj = editConfig;
      for (let i = 0; i < path.length - 1; i++) {
        obj[path[i]] ||= {};
        obj = obj[path[i]];
      }
      obj[path[path.length - 1]] = v;
      renderEdit(entry);
    });
  });
  $("pinout-cancel-btn")?.addEventListener("click", () => {
    editMode = false;
    editConfig = null;
    renderView(entry);
  });
  $("pinout-save-btn")?.addEventListener("click", () => saveEdit(entry));
}

function beginEdit(id) {
  currentId = id;
  editMode = true;
  awaitingConfig = true;
  $("pinout-body").innerHTML = `<div class="meta">Loading current config…</div>`;
  getConfig(id);
  // Don't leave the dialog stuck on "Loading…" forever if the response
  // doesn't arrive (BLE glitch, firmware without the verb, etc.). Surface
  // a clear error and a way out.
  clearTimeout(awaitingTimer);
  awaitingTimer = setTimeout(() => {
    if (!awaitingConfig || currentId !== id) return;
    awaitingConfig = false;
    $("pinout-body").innerHTML = `
      <div class="meta" style="color: var(--danger);">
        No response from robot (timed out). Connection may have glitched —
        close this dialog and reopen once the card shows "connected".
      </div>
      <div class="row" style="margin-top: 12px; justify-content: flex-end;">
        <button class="secondary sm" id="pinout-retry-btn">Retry</button>
      </div>
    `;
    $("pinout-retry-btn")?.addEventListener("click", () => beginEdit(id));
  }, CONFIG_RESPONSE_TIMEOUT_MS);
}

async function saveEdit(entry) {
  const json = JSON.stringify(editConfig, null, 2) + "\n";
  $("pinout-body").innerHTML = `<div class="meta">Uploading config + restarting service…</div>`;
  const ok = await uploadFile(
    entry.id, "pi-robot.conf", "/boot/firmware/pi-robot.conf",
    new TextEncoder().encode(json),
    { restart: "pi-robot" },
  );
  editMode = false;
  editConfig = null;
  if (ok) {
    // Service restart drops BLE briefly; the board will reconnect. Close the
    // dialog so the user sees the disconnect+reconnect on the card.
    $("pinout-modal").close();
  } else {
    renderView(entry);
  }
}

export function openPinoutDialog(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  currentId = id;
  editMode = false;
  editConfig = null;
  $("pinout-title").textContent = `Pinout — ${entry.name}`;
  renderView(entry);
  $("pinout-modal").showModal();
}

export function initPinout() {
  $("pinout-close").addEventListener("click", () => $("pinout-modal").close());
  $("pinout-modal").addEventListener("close", () => {
    editMode = false;
    editConfig = null;
    awaitingConfig = false;
    clearTimeout(awaitingTimer);
    awaitingTimer = null;
    currentId = null;
  });
  // ops-response from the Pi lands here when a get-config was requested.
  onOpsResponse("get-config", (entry, msg) => {
    if (!awaitingConfig || entry.id !== currentId) return;
    awaitingConfig = false;
    clearTimeout(awaitingTimer);
    awaitingTimer = null;
    try {
      editConfig = msg.text ? JSON.parse(msg.text) : {};
    } catch {
      editConfig = {};
    }
    renderEdit(entry);
  });
}
