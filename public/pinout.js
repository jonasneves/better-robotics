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

// SVG representation of the Pi 40-pin header. Looks like a physical header
// (green PCB, black plastic strip, gold pin dots) so users mentally match it
// to the board in front of them. Later phases attach click-to-pulse and
// live pin-state here — the SVG substrate makes animations cheap and
// keyboard/screen-reader semantics honest.
function renderBoard(claims) {
  // Coordinate grid is fixed; CSS scales the <svg> to container width.
  // Columns (left-to-right):
  //   0–120  left claim badge (right-aligned at 118)
  //   120–180 left GPIO label (right-aligned at 178)
  //   180–210 left pin dot (cx 195)
  //   210–240 physical pin number (cx 225)
  //   240–270 right pin dot (cx 255)
  //   270–330 right GPIO label (left-aligned at 272)
  //   330–450 right claim badge (left-aligned at 332)
  const W = 450;
  const ROW_H = 24;
  const PAD_Y = 14;
  const H = PAD_Y * 2 + ROW_H * 20;
  const rows = [];
  for (let i = 0; i < PINS.length; i += 2) {
    const [lp, ll, lk] = PINS[i];
    const [rp, rl, rk] = PINS[i + 1];
    const lc = claims[lp];
    const rc = claims[rp];
    const y = PAD_Y + (i / 2) * ROW_H + ROW_H / 2;
    rows.push(`
      <g class="pin-row">
        ${lc ? `<text class="pin-claim" x="118" y="${y}" text-anchor="end">${escapeHtml(lc.cap)} · ${escapeHtml(lc.role)}</text>` : ""}
        <text class="pin-label" x="178" y="${y}" text-anchor="end">${escapeHtml(ll)}</text>
        <circle class="pin-dot kind-${lk} ${lc ? "claimed" : ""}" cx="195" cy="${y}" r="7" data-phys="${lp}"><title>${escapeHtml(ll)} (physical ${lp})${lc ? " — " + escapeHtml(lc.cap) + " " + escapeHtml(lc.role) : ""}</title></circle>
        <text class="pin-num" x="225" y="${y}" text-anchor="middle">${lp}·${rp}</text>
        <circle class="pin-dot kind-${rk} ${rc ? "claimed" : ""}" cx="255" cy="${y}" r="7" data-phys="${rp}"><title>${escapeHtml(rl)} (physical ${rp})${rc ? " — " + escapeHtml(rc.cap) + " " + escapeHtml(rc.role) : ""}</title></circle>
        <text class="pin-label" x="272" y="${y}" text-anchor="start">${escapeHtml(rl)}</text>
        ${rc ? `<text class="pin-claim" x="332" y="${y}" text-anchor="start">${escapeHtml(rc.cap)} · ${escapeHtml(rc.role)}</text>` : ""}
      </g>
    `);
  }
  return `
    <div class="pinout-svg-wrap">
      <svg class="pinout-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Raspberry Pi 40-pin header with current pin assignments">
        <rect class="pinout-strip" x="180" y="${PAD_Y - 4}" width="90" height="${H - 2 * PAD_Y + 8}" rx="3"/>
        ${rows.join("")}
      </svg>
    </div>
  `;
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
  // Preserve focus across the innerHTML rebuild so typing into a pin input
  // doesn't blur after every keystroke. Pin inputs are type="text" with
  // inputmode="numeric" so selection API works — we snap the cursor back to
  // end-of-value after refocusing below, or the next keystroke gets prepended.
  const active = document.activeElement;
  const savedPath = active?.dataset?.path || null;
  const savedToggle = active?.dataset?.toggle || null;
  const c = editConfig || {};
  const claims = claimsFromConfig(c);
  const ledChecked = c.led_enabled ? "checked" : "";
  const motorsChecked = c.motors_enabled ? "checked" : "";
  const cameraChecked = c.camera_enabled !== false ? "checked" : "";
  const motors = c.motors_pins || {};
  const ml = motors.left || {};
  const mr = motors.right || {};
  // Duplicate GPIO usage detection, in two tiers:
  //   hard — every claimant is enabled; robot will misbehave on next boot.
  //   soft — at least one claimant is disabled; fine right now but a latent
  //          trap (re-enable and it breaks). Users hit this when the LED
  //          default (17) matches a motor IN they later claimed.
  // Hard blocks Save; soft just warns.
  const usage = {};  // gpio → [{role, enabled}, ...]
  if (c.led_pin != null) (usage[c.led_pin] ||= []).push({ role: "led", enabled: !!c.led_enabled });
  for (const [role, g] of flattenPins(motors)) {
    (usage[g] ||= []).push({ role: `motors.${role}`, enabled: !!c.motors_enabled });
  }
  const dup = Object.entries(usage).filter(([, v]) => v.length > 1);
  const hard = dup.filter(([, v]) => v.every(x => x.enabled));
  const soft = dup.filter(([, v]) => !v.every(x => x.enabled));
  const fmt = (list) => list.map(x => x.enabled ? x.role : `${x.role} (off)`).join(" + ");
  // Reserved-function pins: the kernel interface grabs these exclusively when
  // enabled in raspi-config (usually SPI and I2C are on by default). gpiozero
  // then can't claim them and Motor() fails silently — motors won't respond
  // to slider commands even though the config looks clean.
  const RESERVED = {
    2:  "I2C1 SDA",  3:  "I2C1 SCL",
    7:  "SPI0 CE1",  8:  "SPI0 CE0",  9:  "SPI0 MISO",  10: "SPI0 MOSI",  11: "SPI0 SCLK",
    14: "UART TXD", 15: "UART RXD",
  };
  const reservedHits = [];
  const checkReserved = (pin, role, enabled) => {
    if (enabled && RESERVED[pin]) reservedHits.push({ pin, role, fn: RESERVED[pin] });
  };
  if (c.led_pin != null) checkReserved(c.led_pin, "LED", !!c.led_enabled);
  for (const [role, g] of flattenPins(motors)) checkReserved(g, `motors.${role}`, !!c.motors_enabled);
  const warn = [
    hard.length
      ? `<div class="pinout-warn">Conflict: ${hard.map(([g, v]) => `GPIO ${g} claimed by ${fmt(v)}`).join("; ")}</div>`
      : "",
    soft.length
      ? `<div class="pinout-warn soft">Latent conflict: ${soft.map(([g, v]) => `GPIO ${g} claimed by ${fmt(v)}`).join("; ")} — fine while one side is off, will break if re-enabled.</div>`
      : "",
    reservedHits.length
      ? `<div class="pinout-warn soft">Reserved hardware pin${reservedHits.length > 1 ? "s" : ""}: ${reservedHits.map(h => `GPIO ${h.pin} is ${h.fn} (used here for ${h.role})`).join("; ")}. Works only if the matching kernel interface is disabled in raspi-config — otherwise gpiozero can't claim it and motors silently fail.</div>`
      : "",
  ].join("");
  const conflicts = hard;  // only hard blocks Save
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
          <!-- Default 16: 17 is the classic Left-IN1 pick, 26 collides with
               the Safe-defaults preset's right.in2 — 16 dodges both. -->
          <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input"
                 data-path="led_pin" value="${c.led_pin ?? 16}">
        </label>
      </div>
      <div class="pinout-edit-section">
        <label class="pinout-edit-row">
          <input type="checkbox" data-toggle="motors_enabled" ${motorsChecked}>
          <span>Motors (H-bridge)</span>
        </label>
        <div style="padding-left: 24px;">
          <!-- Labels match the silkscreen on L298N / DRV8833 / TB6612 boards:
               IN1+IN2 drive motor A (left), IN3+IN4 drive motor B (right).
               Config keys stay motors_pins.{left,right}.{in1,in2} — that's
               the firmware contract; only the display labels changed. -->
          <label class="pinout-edit-row">
            <span class="pinout-edit-label">IN1 · left motor</span>
            <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input"
                   data-path="motors_pins.left.in1" value="${ml.in1 ?? 17}">
          </label>
          <label class="pinout-edit-row">
            <span class="pinout-edit-label">IN2 · left motor</span>
            <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input"
                   data-path="motors_pins.left.in2" value="${ml.in2 ?? 27}">
          </label>
          <label class="pinout-edit-row">
            <span class="pinout-edit-label">IN3 · right motor</span>
            <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input"
                   data-path="motors_pins.right.in1" value="${mr.in1 ?? 23}">
          </label>
          <label class="pinout-edit-row">
            <span class="pinout-edit-label">IN4 · right motor</span>
            <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input"
                   data-path="motors_pins.right.in2" value="${mr.in2 ?? 24}">
          </label>
          <div class="meta" style="margin-top: 6px;">Wire each Pi GPIO to the driver board's IN pin of the same number (IN1 ↔ IN1, etc.). Works with L298N, DRV8833, TB6612, and most H-bridge clones.</div>
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
        <!-- One-click preset for beginners: all pins set to safe, non-reserved,
             conflict-free values that work on any Pi 4 with stock raspi-config. -->
        <button class="secondary sm" id="pinout-safe-defaults-btn" title="Set LED + motor pins to a known-good preset (no hardware-reserved pins, no conflicts)">Use safe defaults</button>
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
  // Safe-defaults preset: non-reserved pins, no overlap between LED and motors,
  // matches a typical L298N/DRV8833/TB6612 two-motor wiring tutorial.
  $("pinout-safe-defaults-btn")?.addEventListener("click", () => {
    editConfig.led_pin = 16;
    editConfig.motors_pins = { left: { in1: 5, in2: 6 }, right: { in1: 13, in2: 26 } };
    renderEdit(entry);
  });

  // Restore focus to whatever input was active before the re-render so the
  // user can keep typing without re-clicking after every keystroke. Put the
  // cursor at end-of-value (otherwise Chrome lands it at position 0 on text
  // inputs and the user's next keystroke is prepended).
  if (savedPath) {
    const el = $("pinout-body").querySelector(`input[data-path="${savedPath}"]`);
    if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n); } catch {} }
  } else if (savedToggle) {
    $("pinout-body").querySelector(`input[data-toggle="${savedToggle}"]`)?.focus();
  }
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
  // Reject out-of-range pin values before shipping the config. Text inputs
  // don't carry HTML5 numeric bounds, so set a custom validity message on the
  // offender and let the browser's native popover point at the bad field.
  let badInput = null;
  for (const el of $("pinout-body").querySelectorAll("input[data-path]")) {
    const v = parseInt(el.value, 10);
    const bad = el.value.trim() === "" || Number.isNaN(v) || v < 0 || v > 27;
    el.setCustomValidity(bad ? "Enter a GPIO number between 0 and 27." : "");
    if (bad && !badInput) badInput = el;
  }
  if (badInput) { badInput.reportValidity(); badInput.focus(); return; }
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

// Lazy-loaded from app.js on first pinout-menu click. One-time setup guarded
// by flag; the get-config subscription only needs to be live when a request
// is in flight, which only happens after the dialog is opened — so attaching
// it on first open is safe.
let _initialized = false;
function initOnce() {
  if (_initialized) return;
  _initialized = true;
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

export function openPinoutDialog(id) {
  initOnce();
  const entry = state.devices.get(id);
  if (!entry) return;
  currentId = id;
  editMode = false;
  editConfig = null;
  $("pinout-title").textContent = `Pinout — ${entry.name}`;
  renderView(entry);
  $("pinout-modal").showModal();
}
