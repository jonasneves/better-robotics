// Pi 40-pin header pinout — visual wiring reference. Reads claimed pins
// from the active robot's capability schema (entry.capSchema) and
// highlights them on a labeled layout. Power/ground pins are fixed and
// always shown for reference.
import { $, escapeHtml, wireDialogOutsideClick } from "./dom.js";
import { state } from "./state.js";

// Standard Raspberry Pi 40-pin header. Row pairs map physical pin → role.
// BCM GPIO numbers are what capability config and firmware use; the physical
// pin number is what the header silkscreen shows. Users wire against physical
// pins, so we lead with those.
const PINS = [
  // [phys, label, kind] — kind ∈ {"3v3", "5v", "gnd", "gpio", "i2c-id"}
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

// Map a BCM GPIO number (as stored in capability schema) → physical pin.
const GPIO_TO_PHYS = new Map(
  PINS.filter(([, lbl]) => lbl.startsWith("GPIO"))
      .map(([phys, lbl]) => [parseInt(lbl.slice(4), 10), phys]),
);

// Flatten a pins-dict of any depth to [["a b c", gpio], …]. Supports both
// flat {role: gpio} and nested {left: {in1: 17, in2: 27}, …} shapes so the
// map renders regardless of how a capability organizes its pin vocabulary.
function flattenPins(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const label = prefix ? `${prefix} ${k}` : k;
    if (typeof v === "number") out.push([label, v]);
    else if (v && typeof v === "object") out.push(...flattenPins(v, label));
  }
  return out;
}

// Walk entry.capSchema and return { phys: {cap, role} } for claimed pins.
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

function renderPinout(entry) {
  const claims = claimsFromEntry(entry);
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
  const legend = Object.entries(claims).length
    ? `<div class="meta">Colored rows are declared in <code>pi-robot.conf</code>. Re-prep the card to change assignments.</div>`
    : `<div class="meta">No GPIO capabilities declared for this robot.</div>`;
  $("pinout-body").innerHTML = `
    <div class="pinout">${cells.join("")}</div>
    ${legend}
  `;
}

export function openPinoutDialog(id) {
  const entry = state.devices.get(id);
  if (!entry) return;
  $("pinout-title").textContent = `Pinout — ${entry.name}`;
  renderPinout(entry);
  $("pinout-modal").showModal();
}

export function initPinout() {
  $("pinout-close").addEventListener("click", () => $("pinout-modal").close());
  wireDialogOutsideClick($("pinout-modal"));
}
