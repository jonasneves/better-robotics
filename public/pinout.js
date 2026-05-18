import { $, escapeHtml } from "./dom.js";
import { state } from "./state.js";
import { getConfig } from "./capabilities/runtime/command.js";
import { onOpsResponse } from "./ops-response.js";
import { uploadFile } from "./capabilities/ota.js";
import { SERVICE_UUID, PIN_CONFIG_CHAR_UUID, encodeJson } from "./ble.js";
import { beginMotorsCalibration } from "./motors-calibrate.js";
import { boardById, cameraReservedSet } from "./boards.js";

// BCM GPIO is what config + firmware use; physical pin is what the header
// silkscreen shows. Users wire against physical, so lead with those.
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

// Pin layouts, labels, footer notes, and camera-reserved sets come from
// boards.js — single source of truth shared with esp-serial.js. boardPins
// adapts the shape (pinsTop/pinsBot/pcbLabel) to the {top, bot, label}
// triple the renderers below expect.
function boardPins(entry) {
  const b = boardById(entry?.fwInfo?.board);
  return { top: b.pinsTop, bot: b.pinsBot, label: b.pcbLabel };
}
function esp32FooterNote(entry) {
  return boardById(entry?.fwInfo?.board).footerNote || "";
}

// ESP32-CAM canvas layout — top-to-bottom matches signal flow:
//   encoders (sensors / inputs)
//        ↓
//   ESP32-CAM (compute)
//        ↓
//   L298N driver (output to motors)
// Encoder OUT wires travel a short distance DOWN to the ESP32 top row
// instead of UP across the L298N region, removing the worst diagonal
// crossings the previous below-the-driver layout produced.
const ESP_W            = 520;
const ESP_PIN_R        = 9;
const ESP_PIN_SPACING  = 56;
const ESP_FIRST_PIN_X  = 50;

const ESP_ENC_PCB_W    = 130;
const ESP_ENC_PCB_H    = 80;
const ESP_ENC_DOT_R    = 6;
const ESP_ENC_PIN_DX   = 32;
const ESP_ENC_Y        = 10;                                        // top of encoder PCBs
const ESP_ENC_DOT_Y    = ESP_ENC_Y + 40;                            // 50 — vertical center of pin dots
const ESP_ENC_LEFT_CX  = 130;
const ESP_ENC_RIGHT_CX = 390;

const ESP_ENC_TO_BOARD_GAP = 35;
const ESP_TOP_ROW_Y    = ESP_ENC_Y + ESP_ENC_PCB_H + ESP_ENC_TO_BOARD_GAP;  // 125
const ESP_BOT_ROW_Y    = ESP_TOP_ROW_Y + 160;                                // 285
const ESP_H            = ESP_BOT_ROW_Y + 50;                                 // 335 — bot pin label space

const ESP_DRIVER_GAP   = 60;
const ESP_DRIVER_Y     = ESP_H + ESP_DRIVER_GAP;                             // 395
const ESP_DRIVER_H     = 175;
const ESP_TERM_R       = 7;
const ESP_TERMINAL_XS  = [50, 134, 218, 302, 386, 470];
const ESP_TERM_CY      = ESP_DRIVER_Y + 85;                                  // 480
const ESP_TOTAL_H      = ESP_DRIVER_Y + ESP_DRIVER_H + 40;                   // 610

// GPIO → (cx, cy) lookup for routing wires to ESP32 pins. Rebuilt per
// render via gpioToPosMap(layout) since pin arrays differ across boards.
// Pin spacing tightens automatically when there are more pins per row so
// the SVG stays within ESP_W. Only labeled GPIO pins make it in;
// power/ground pins are looked up separately by kind.
function pinSpacingForLayout(layout) {
  const n = Math.max(layout.top.length, layout.bot.length);
  // Available width = ESP_W minus 2× ESP_FIRST_PIN_X margin. Pin spacing
  // shrinks for wider rows so the rightmost pin still fits.
  const usable = ESP_W - 2 * ESP_FIRST_PIN_X;
  return n > 1 ? usable / (n - 1) : ESP_PIN_SPACING;
}
function gpioToPosMap(layout) {
  const spacing = pinSpacingForLayout(layout);
  const m = new Map();
  layout.top.forEach((p, i) => {
    if (p.gpio != null) m.set(p.gpio, {
      cx: ESP_FIRST_PIN_X + i * spacing,
      cy: ESP_TOP_ROW_Y,
      row: "top",
    });
  });
  layout.bot.forEach((p, i) => {
    if (p.gpio != null) m.set(p.gpio, {
      cx: ESP_FIRST_PIN_X + i * spacing,
      cy: ESP_BOT_ROW_Y,
      row: "bot",
    });
  });
  return m;
}

// Power/ground destinations for encoder VCC + GND fan-in on ESP32.
function espPinPosByKind(rowArr, rowY, kind, spacing) {
  for (let i = 0; i < rowArr.length; i++) {
    if (rowArr[i].kind === kind) {
      return { cx: ESP_FIRST_PIN_X + i * spacing, cy: rowY };
    }
  }
  return null;
}

// Firmware defaults — MUST match pi_robot.py's LED_PIN and MOTORS_PINS.
// Used as input fallbacks AND as claimsFromConfig fallbacks so the SVG
// wires appear on first open of a fresh robot (where the conf is empty
// and pi_robot.py is running on its compiled-in defaults). Also the
// safe-defaults button's restore target.
const PI_DEFAULTS = {
  led_pin: 17,
  motors_pins: {
    left:  { forward: 5,  backward: 6  },
    right: { forward: 13, backward: 26 },
  },
  encoders_pins: { left: 22, right: 24 },
};

// Supports both flat {role: gpio} and nested {left: {forward: 17, backward: 27}} shapes.
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
  // Pi caps no longer carry pin info in fw-info (kept tiny so the full
  // payload fits the 512 B GATT attribute cap — pre-fix at 615 B Chrome
  // truncated the JSON and dropped every capability card). Derive claims
  // from cap-name presence + PI_DEFAULTS so the read-only diagram still
  // highlights the canonical wiring; Edit fetches the live pi-robot.conf
  // via get-config for users with custom pins.
  const names = new Set((entry?.capSchema || []).map(c => c.name));
  return claimsFromConfig({
    led_enabled:      names.has("led"),
    led_pin:          PI_DEFAULTS.led_pin,
    motors_enabled:   names.has("motors"),
    motors_pins:      PI_DEFAULTS.motors_pins,
    encoders_enabled: names.has("encoders"),
    encoders_pins:    PI_DEFAULTS.encoders_pins,
  });
}

// Shared Pi-header SVG geometry — exposed so the combined "Pi + driver board"
// view (renderBoardWithDriver) can compute wire endpoints in the same
// coordinate space.
const PI_W = 450;
const PI_ROW_H = 24;
const PI_PAD_Y = 14;
const PI_H = PI_PAD_Y * 2 + PI_ROW_H * 20;   // 508
const PI_LEFT_CX  = 195;
const PI_RIGHT_CX = 255;
const PI_PIN_R = 7;

// Returns: { cx, cy } for a physical pin on the Pi header.
function piPinCenter(phys) {
  const idx = PINS.findIndex(([p]) => p === phys);
  if (idx < 0) return null;
  const row = Math.floor(idx / 2);
  const cx = (idx % 2 === 0) ? PI_LEFT_CX : PI_RIGHT_CX;
  const cy = PI_PAD_Y + row * PI_ROW_H + PI_ROW_H / 2;
  return { cx, cy };
}

// Inner fragment of Pi rows — shared between renderBoard (Pi alone) and the
// combined Pi+driver view. Keeps the single source of truth for pin layout.
function piRowsFragment(claims) {
  const rows = [];
  for (let i = 0; i < PINS.length; i += 2) {
    const [lp, ll, lk] = PINS[i];
    const [rp, rl, rk] = PINS[i + 1];
    const lc = claims[lp];
    const rc = claims[rp];
    const y = PI_PAD_Y + (i / 2) * PI_ROW_H + PI_ROW_H / 2;
    // data-wire links pin-dot + claim text to the motor-wire chain
    // (claim-text + wire path + driver terminal share the same value, so
    // hovering any element lights up the whole connection). Only motor
    // claims get the attribute; LED/camera-style single-pin caps have
    // nothing to chain to. Tooltips intentionally minimal — the GPIO
    // label, physical pin number, and cap/role are already shown in
    // adjacent columns, so a verbose title would just restate them.
    const lWire = lc?.cap === "motors" ? ` data-wire="${escapeHtml(lc.role)}"` : "";
    const rWire = rc?.cap === "motors" ? ` data-wire="${escapeHtml(rc.role)}"` : "";
    // Encoder claims are redundant with the breakout-module label that
    // sits beside the pin row in the SVG — suppress the row text so it
    // doesn't compete with the module for the same horizontal space.
    const lcText = lc && lc.cap !== "encoders"
      ? `<text class="pin-claim" x="118" y="${y}" text-anchor="end"${lWire}>${escapeHtml(lc.cap)} · ${escapeHtml(lc.role)}</text>` : "";
    const rcText = rc && rc.cap !== "encoders"
      ? `<text class="pin-claim" x="332" y="${y}" text-anchor="start"${rWire}>${escapeHtml(rc.cap)} · ${escapeHtml(rc.role)}</text>` : "";
    rows.push(`
      <g class="pin-row">
        ${lcText}
        <text class="pin-label" x="178" y="${y}" text-anchor="end">${escapeHtml(ll)}</text>
        <circle class="pin-dot kind-${lk} ${lc ? "claimed" : ""}" cx="${PI_LEFT_CX}" cy="${y}" r="${PI_PIN_R}" data-phys="${lp}"${lWire}><title>${escapeHtml(ll)}</title></circle>
        <text class="pin-num" x="225" y="${y}" text-anchor="middle">${lp}·${rp}</text>
        <circle class="pin-dot kind-${rk} ${rc ? "claimed" : ""}" cx="${PI_RIGHT_CX}" cy="${y}" r="${PI_PIN_R}" data-phys="${rp}"${rWire}><title>${escapeHtml(rl)}</title></circle>
        <text class="pin-label" x="272" y="${y}" text-anchor="start">${escapeHtml(rl)}</text>
        ${rcText}
      </g>
    `);
  }
  return rows.join("");
}

// SVG representation of the Pi 40-pin header. Looks like a physical header
// (green PCB, black plastic strip, gold pin dots) so users mentally match it
// to the board in front of them. Later phases attach click-to-pulse and
// live pin-state here — the SVG substrate makes animations cheap and
// keyboard/screen-reader semantics honest.
function renderBoard(claims) {
  return `
    <div class="pinout-svg-wrap">
      <svg class="pinout-svg" viewBox="0 0 ${PI_W} ${PI_H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Raspberry Pi 40-pin header with current pin assignments">
        <rect class="pinout-strip" x="180" y="${PI_PAD_Y - 4}" width="90" height="${PI_H - 2 * PI_PAD_Y + 8}" rx="3"/>
        ${piRowsFragment(claims)}
      </svg>
    </div>
  `;
}

// Combined view: Pi header on top, H-bridge driver board below, wires drawn
// from Pi GPIOs to driver IN/EN terminals based on the current motors_pins
// config. Same coordinate system throughout so wires are just paths between
// known (cx, cy) points — no DOM measurements, no cross-SVG math.
//
// Driver layout: six labeled terminals in a row (ENA, IN1, IN2, IN3, IN4, ENB).
// ENA flanks motor-A's INs, ENB flanks motor-B's INs — mirrors the physical
// L298N silkscreen. Terminals omit the power row (12V/5V/GND) since those
// aren't user-configurable through this UI.
//
// Wires:
//   IN pins  → blue solid (direction control)
//   EN pins  → purple dashed (optional speed control; dashed signals optional)
// Low opacity keeps wires visually secondary to the pin dots themselves.
//
// Encoder modules sit beside the Pi strip — left/right of the header at
// the vertical level of their wired pins. Side-placement keeps each
// wire as a short horizontal jump instead of a long S-curve that would
// otherwise cross the L298N's motor wires below. Per-side pin order:
// VCC nearest the Pi (3V3 fan-in is short), GND outermost. Per-side
// ground destinations stay on each module's own column (pin 25 for the
// left module, pin 20 for the right), so only the right module's VCC
// wire crosses the strip (unavoidable — 3V3 is left-column only).
// VCC/GND wires are faint (infrastructure); OUT wire pops in blue (the
// editable signal).
const ENC_PCB_W    = 100;
const ENC_PCB_H    = 72;
const ENC_DOT_R    = 6;
const ENC_PIN_DX   = 28;
const ENC_CY       = 218;                       // centered on row 8 (between rows 7+8)
const ENC_DOT_Y    = ENC_CY;
// Module right/left edges must clear the Pi-row label band (x=128–178
// on the left, x=272–322 on the right — widest label "GPIO22" measured
// at 11px monospace). Modules tuck snug against the labels but leave
// the GPIO column readable.
const ENC_LEFT_CX  = 68;                        // right edge ≈ 118, clears label band
const ENC_RIGHT_CX = 382;                       // left edge  ≈ 332, clears label band
// Canonical supply pins for the fan-in. 3V3 is left-column only, so
// both modules' VCC converges there; GND uses each module's own column
// so only the right VCC crosses the strip.
const ENC_VCC_PHYS = 17;                        // 3V3 (left col, row 8)
const ENC_GND_LEFT_PHYS  = 25;                  // GND (left col, row 12)
const ENC_GND_RIGHT_PHYS = 20;                  // GND (right col, row 9)
const ENCODER_TO_PATH = { left: "encoders_pins.left", right: "encoders_pins.right" };

const DRIVER_GAP = 60;
const DRIVER_Y   = PI_H + DRIVER_GAP;          // 568 — back to pre-encoder spacing
const DRIVER_H   = 175;
const TOTAL_H    = DRIVER_Y + DRIVER_H;        // 743
const TERM_R     = 7;
const TERMINAL_XS = [45, 117, 189, 261, 333, 405];
const TERMINAL_ROLES = ["ena", "in1", "in2", "in3", "in4", "enb"];
const TERMINAL_LABELS = { ena: "ENA", in1: "IN1", in2: "IN2", in3: "IN3", in4: "IN4", enb: "ENB" };
const TERM_CY = DRIVER_Y + 85;                  // 653
// motors_pins path (role from flattenPins) → driver terminal role. The
// per-motor names (forward/backward/enable) match gpiozero's Motor()
// constructor; the L298N chip-side names (IN1..IN4/ENA/ENB) match the
// silkscreen. Two vocabularies on purpose — the wires between them
// document the mapping that "forward/backward" hides on the chip.
const ROLE_TO_TERMINAL = {
  "left forward":   "in1",
  "left backward":  "in2",
  "left enable":    "ena",
  "right forward":  "in3",
  "right backward": "in4",
  "right enable":   "enb",
};

// Reverse mapping for edit-mode inline inputs. The SVG terminal carries an
// input whose data-path matches the form-input handlers in renderEdit, so
// save/validation/conflict logic stays unchanged — the only thing that
// changed is where the input lives on screen.
const TERMINAL_TO_PATH = {
  in1: { path: "motors_pins.left.forward",   optional: false },
  in2: { path: "motors_pins.left.backward",  optional: false },
  in3: { path: "motors_pins.right.forward",  optional: false },
  in4: { path: "motors_pins.right.backward", optional: false },
  ena: { path: "motors_pins.left.enable",    optional: true  },
  enb: { path: "motors_pins.right.enable",   optional: true  },
};

// One encoder breakout — three pin dots inside a small rounded PCB.
// Per-side pin order puts VCC nearest the Pi so the 3V3 fan-in is short
// (mirror layout: left module is [GND,OUT,VCC], right is [VCC,OUT,GND]).
// In edit mode the OUT pin carries an inline input; data-path matches
// the form-input handlers in renderEdit, so save/validation/conflict
// logic stays unchanged.
function encoderModuleFragment(side, cx, opts) {
  const { editable, editConfig, flagged } = opts;
  const pcbX = cx - ENC_PCB_W / 2;
  const vccDx = side === "left" ? +ENC_PIN_DX : -ENC_PIN_DX;
  const gndDx = -vccDx;
  const vccX  = cx + vccDx;
  const outX  = cx;
  const gndX  = cx + gndDx;
  const pcbTopY = ENC_CY - ENC_PCB_H / 2;
  const wireAttr = ` data-wire="${escapeHtml(`encoders.${side}`)}"`;

  let inputFrag = "";
  if (editable) {
    const path = ENCODER_TO_PATH[side];
    const v = editConfig?.encoders_pins?.[side] ?? PI_DEFAULTS.encoders_pins[side];
    const display = String(v);
    const conflictCls = flagged.has(v) ? " conflict" : "";
    inputFrag = `
      <foreignObject x="${outX - 22}" y="${ENC_DOT_Y + 12}" width="44" height="22">
        <input xmlns="http://www.w3.org/1999/xhtml" type="text" inputmode="numeric" maxlength="2"
               class="terminal-input${conflictCls}" data-path="${path}"${wireAttr}
               value="${escapeHtml(display)}" />
      </foreignObject>
    `;
  }

  // Reuse .pin-dot so encoder pins inherit kind-* fills, hover, and the
  // [data-wire] cursor rule; .enc-pin tweaks stroke for the smaller
  // breakout-board scale without re-declaring colors.
  return `
    <rect class="enc-pcb" x="${pcbX}" y="${pcbTopY}" width="${ENC_PCB_W}" height="${ENC_PCB_H}" rx="6"/>
    <text class="enc-title" x="${cx}" y="${pcbTopY + 16}" text-anchor="middle">encoder · ${side}</text>
    <text class="enc-pin-label" x="${vccX}" y="${ENC_DOT_Y - 11}" text-anchor="middle">VCC</text>
    <circle class="pin-dot enc-pin kind-3v3" cx="${vccX}" cy="${ENC_DOT_Y}" r="${ENC_DOT_R}"/>
    <text class="enc-pin-label" x="${outX}" y="${ENC_DOT_Y - 11}" text-anchor="middle">OUT</text>
    <circle class="pin-dot enc-pin kind-gpio" cx="${outX}" cy="${ENC_DOT_Y}" r="${ENC_DOT_R}"${wireAttr}/>
    <text class="enc-pin-label" x="${gndX}" y="${ENC_DOT_Y - 11}" text-anchor="middle">GND</text>
    <circle class="pin-dot enc-pin kind-gnd" cx="${gndX}" cy="${ENC_DOT_Y}" r="${ENC_DOT_R}"/>
    ${inputFrag}
  `;
}

// Wires from one module to its three destination Pi pins. Horizontal-
// dominant routing: emerge from the encoder pin's edge facing the Pi
// and arrive at the Pi pin's edge facing the encoder. VCC/GND draw
// even when encoders are disabled (infrastructure hint); OUT draws
// only when a live claim exists.
function encoderWiresFragment(side, claims) {
  const cx   = side === "left" ? ENC_LEFT_CX : ENC_RIGHT_CX;
  const vccX = side === "left" ? cx + ENC_PIN_DX : cx - ENC_PIN_DX;
  const outX = cx;
  const gndX = side === "left" ? cx - ENC_PIN_DX : cx + ENC_PIN_DX;
  const gndPhys = side === "left" ? ENC_GND_LEFT_PHYS : ENC_GND_RIGHT_PHYS;
  const out = [];

  const vccPt = piPinCenter(ENC_VCC_PHYS);
  if (vccPt) out.push(encWirePath(side, vccX, ENC_DOT_Y, vccPt.cx, vccPt.cy, "wire-vcc"));
  const gndPt = piPinCenter(gndPhys);
  if (gndPt) out.push(encWirePath(side, gndX, ENC_DOT_Y, gndPt.cx, gndPt.cy, "wire-gnd"));

  let outPhys = null;
  for (const [physStr, info] of Object.entries(claims)) {
    if (info?.cap === "encoders" && info?.role === side) {
      outPhys = parseInt(physStr, 10);
      break;
    }
  }
  if (outPhys != null) {
    const pt = piPinCenter(outPhys);
    if (pt) out.push(encWirePath(side, outX, ENC_DOT_Y, pt.cx, pt.cy, "wire-out", `encoders.${side}`));
  }
  return out.join("");
}

// Side-aware wire path. Endpoints are offset to the Pi-facing edge of
// each circle, so the wire visually terminates at the dot perimeter
// instead of overlapping the dot. Control points at midX produce a
// horizontal trunk then a vertical drop (or rise) toward the Pi pin —
// keeps the wire outside the Pi strip until close to the destination
// when the Pi pin is not directly aligned vertically.
function encWirePath(side, encX, encY, piX, piY, cls, wireRole) {
  const sx = side === "left" ? encX + ENC_DOT_R : encX - ENC_DOT_R;
  const ex = side === "left" ? piX  - PI_PIN_R  : piX  + PI_PIN_R;
  const midX = (sx + ex) / 2;
  const dataAttr = wireRole ? ` data-wire="${escapeHtml(wireRole)}"` : "";
  return `<path class="enc-wire ${cls}" d="M${sx},${encY} C${midX},${encY} ${midX},${piY} ${ex},${piY}"${dataAttr}/>`;
}

function renderBoardWithDriver(claims, opts = {}) {
  const { editable = false, editConfig = null, flagged = new Set() } = opts;
  const driverPcb = `
    <rect class="driver-pcb" x="15" y="${DRIVER_Y}" width="${PI_W - 30}" height="${DRIVER_H}" rx="6"/>
    <text class="driver-title" x="${PI_W / 2}" y="${DRIVER_Y + 22}" text-anchor="middle">H-bridge driver inputs</text>
  `;
  // Split modules from wires so the render order can interleave with
  // motor wires — both wire groups draw last so they sit on top of any
  // pin dot they touch.
  const encoderModules = `
    ${encoderModuleFragment("left",  ENC_LEFT_CX,  { editable, editConfig, flagged })}
    ${encoderModuleFragment("right", ENC_RIGHT_CX, { editable, editConfig, flagged })}
  `;
  const encoderWires = `
    ${encoderWiresFragment("left",  claims)}
    ${encoderWiresFragment("right", claims)}
  `;

  // Reverse ROLE_TO_TERMINAL via the live claims map — only includes
  // terminals that are actually wired in the current config, so unwired
  // terminals stay non-interactive (no data-wire, no hover chain).
  const terminalToWire = {};
  for (const info of Object.values(claims)) {
    if (info?.cap !== "motors") continue;
    const t = ROLE_TO_TERMINAL[info.role];
    if (t) terminalToWire[t] = info.role;
  }

  const terminals = TERMINAL_ROLES.map((role, i) => {
    const cx = TERMINAL_XS[i];
    const kind = role.startsWith("en") ? "enable" : "input";
    const wireRole = terminalToWire[role];
    const wireAttr = wireRole ? ` data-wire="${escapeHtml(wireRole)}"` : "";

    // Inline editable input below each terminal — turns the SVG into the
    // editor instead of a preview of one. data-path matches what the
    // existing input handlers expect; conflict class flags GPIOs that
    // appear in hard/reserved sets so the user sees the offender right
    // at the wire endpoint instead of in a banner.
    let inputFrag = "";
    if (editable) {
      const { path, optional } = TERMINAL_TO_PATH[role];
      const parts = path.split(".");
      let v = editConfig;
      for (const p of parts) v = v?.[p];
      if (v == null && !optional) {
        // Required pins fall back to PI_DEFAULTS so first-open shows
        // what pi_robot.py is actually using, not blanks.
        let dv = PI_DEFAULTS.motors_pins;
        for (const p of parts.slice(1)) dv = dv?.[p];
        v = dv;
      }
      const display = v == null ? "" : String(v);
      const placeholder = optional ? "—" : "";
      const conflictCls = (v != null && flagged.has(v)) ? " conflict" : "";
      inputFrag = `
        <foreignObject x="${cx - 22}" y="${TERM_CY + 12}" width="44" height="22">
          <input xmlns="http://www.w3.org/1999/xhtml" type="text" inputmode="numeric" maxlength="2"
                 class="terminal-input${conflictCls}" data-path="${path}"${optional ? ' data-optional="true"' : ""}${wireAttr}
                 value="${escapeHtml(display)}" placeholder="${placeholder}" />
        </foreignObject>
      `;
    }

    return `
      <text class="driver-label" x="${cx}" y="${TERM_CY - 14}" text-anchor="middle">${TERMINAL_LABELS[role]}</text>
      <circle class="driver-pin ${kind}" cx="${cx}" cy="${TERM_CY}" r="${TERM_R}" data-role="${role}"${wireAttr}/>
      ${inputFrag}
    `;
  }).join("");

  // Decorative supply-side note — reminds the user of connections they
  // must make themselves (not wireable via the dashboard config). Most
  // common failure after removing ENA/ENB jumpers: no common GND between
  // Pi and driver, or motor supply not hooked up. Rendered as muted text
  // at the bottom of the driver PCB, visually subordinate to the
  // configurable INs and ENs above.
  const supplyY = TERM_CY + (editable ? 58 : 45);
  const supplyNote = `
    <text class="driver-supply" x="${PI_W / 2}" y="${supplyY}" text-anchor="middle">
      Also connect (not shown): Pi GND ↔ L298N GND · motor supply 7–12V to VS
    </text>
  `;

  // Wires derive from the same claims map used to decorate Pi pins — so
  // view mode and edit mode render wires identically. Each motors-claimed
  // pin has a role like "left forward" that maps to a driver terminal.
  const wires = [];
  for (const [physStr, info] of Object.entries(claims)) {
    if (info?.cap !== "motors") continue;
    const driverRole = ROLE_TO_TERMINAL[info.role];
    if (!driverRole) continue;
    const phys = parseInt(physStr, 10);
    const piPt = piPinCenter(phys);
    if (!piPt) continue;
    const termIdx = TERMINAL_ROLES.indexOf(driverRole);
    const termCx = TERMINAL_XS[termIdx];
    const startX = piPt.cx, startY = piPt.cy + PI_PIN_R;
    const endX   = termCx,  endY   = TERM_CY - TERM_R;
    // Cubic Bézier with control points at the vertical midpoint of the span
    // gives a smooth S-curve regardless of horizontal offset.
    const midY = (startY + endY) / 2;
    const wireClass = driverRole.startsWith("en") ? "wire-enable" : "wire-input";
    wires.push(`<path class="motor-wire ${wireClass}" d="M${startX},${startY} C${startX},${midY} ${endX},${midY} ${endX},${endY}" data-wire="${escapeHtml(info.role)}"/>`);
  }

  return `
    <div class="pinout-svg-wrap">
      <svg class="pinout-svg" viewBox="0 0 ${PI_W} ${TOTAL_H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Raspberry Pi header with encoder modules and H-bridge driver wiring">
        <rect class="pinout-strip" x="180" y="${PI_PAD_Y - 4}" width="90" height="${PI_H - 2 * PI_PAD_Y + 8}" rx="3"/>
        ${piRowsFragment(claims)}
        ${encoderModules}
        ${driverPcb}
        ${terminals}
        ${encoderWires}
        ${wires.join("")}
        ${supplyNote}
      </svg>
    </div>
  `;
}

// ESP32-CAM header SVG — landscape layout that matches the physical board's
// shape (two horizontal pin rows along the long edges). Status colors
// (green / amber / grey) override the kind-based gold for GPIO pins so the
// "free vs. SD-shared vs. reserved" story reads at a glance.

function espPinFragment(pin, cx, cy, labelAbove, claimed) {
  const statusClass = pin.status ? `esp-${pin.status}` : "";
  const claimedClass = claimed ? "claimed" : "";
  const title = pin.note ? `${pin.label} — ${pin.note}` : pin.label;
  const labelY = labelAbove ? cy - 22 : cy + 26;
  // data-gpio enables the focus-highlight chain (input → matching pin
  // dot) and is the ESP32 analogue of the Pi side's data-phys.
  const gpioAttr = pin.gpio != null ? ` data-gpio="${pin.gpio}"` : "";
  return `
    <text class="pin-label" x="${cx}" y="${labelY}" text-anchor="middle">${escapeHtml(pin.label)}</text>
    <circle class="pin-dot kind-${pin.kind} ${statusClass} ${claimedClass}" cx="${cx}" cy="${cy}" r="${ESP_PIN_R}"${gpioAttr}>
      <title>${escapeHtml(title)}</title>
    </circle>
  `;
}

function renderEsp32Board(entry) {
  const layout = boardPins(entry);
  const spacing = pinSpacingForLayout(layout);
  const topPins = layout.top.map((p, i) =>
    espPinFragment(p, ESP_FIRST_PIN_X + i * spacing, ESP_TOP_ROW_Y, true),
  ).join("");
  const botPins = layout.bot.map((p, i) =>
    espPinFragment(p, ESP_FIRST_PIN_X + i * spacing, ESP_BOT_ROW_Y, false),
  ).join("");
  const pcbY = ESP_TOP_ROW_Y + 18;
  const pcbH = ESP_BOT_ROW_Y - ESP_TOP_ROW_Y - 36;
  return `
    <div class="pinout-svg-wrap esp32">
      <svg class="pinout-svg esp32" viewBox="0 0 ${ESP_W} ${ESP_H}" preserveAspectRatio="xMidYMid meet"
           xmlns="http://www.w3.org/2000/svg" role="img"
           aria-label="ESP32 header pins and GPIO availability">
        <rect class="esp-pcb" x="20" y="${pcbY}" width="${ESP_W - 40}" height="${pcbH}" rx="6"/>
        <text class="esp-chip-label" x="${ESP_W / 2}" y="${(ESP_TOP_ROW_Y + ESP_BOT_ROW_Y) / 2}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(layout.label)}</text>
        ${topPins}
        ${botPins}
      </svg>
    </div>
  `;
}

// Encoder VCC + GND destinations are derived per-board from the active
// layout (boards differ in where 3V3 / GND pins sit on the header).
// AI-Thinker: top-row GND, bot-row 3V3. DevKit/C3 mirror or differ;
// boardKindPositions() returns the first-matching position per kind.
function boardKindPositions(layout) {
  const spacing = pinSpacingForLayout(layout);
  return {
    vcc:      espPinPosByKind(layout.bot, ESP_BOT_ROW_Y, "3v3", spacing)
           || espPinPosByKind(layout.top, ESP_TOP_ROW_Y, "3v3", spacing),
    gndLeft:  espPinPosByKind(layout.top, ESP_TOP_ROW_Y, "gnd", spacing)
           || espPinPosByKind(layout.bot, ESP_BOT_ROW_Y, "gnd", spacing),
    gndRight: espPinPosByKind(layout.top, ESP_TOP_ROW_Y, "gnd", spacing)
           || espPinPosByKind(layout.bot, ESP_BOT_ROW_Y, "gnd", spacing),
  };
}

// Maps the motors_pins.* paths the fw advertises into L298N terminal
// roles. Same mapping as the Pi side because the schema is shared.
const ESP_ROLE_TO_TERMINAL = {
  "left forward":  "in1",
  "left backward": "in2",
  "right forward": "in3",
  "right backward":"in4",
};

function esp32ClaimsFromEntry(entry) {
  // Mirror of claimsFromEntry, but ESP32 claims are keyed by GPIO
  // number directly (there's no separate "physical pin number"
  // identifier — the silkscreen label is the GPIO).
  const claims = {};
  for (const cap of entry?.capSchema || []) {
    if (cap.pin != null) {
      claims[cap.pin] = { cap: cap.name, role: cap.pin_mode || cap.type };
    }
    for (const [role, gpio] of flattenPins(cap.pins)) {
      claims[gpio] = { cap: cap.name, role };
    }
  }
  return claims;
}

function espMotorWiresFragment(claims, gpioMap) {
  const wires = [];
  for (const [gpioStr, info] of Object.entries(claims)) {
    if (info?.cap !== "motors") continue;
    const term = ESP_ROLE_TO_TERMINAL[info.role];
    if (!term) continue;
    const pos = gpioMap.get(parseInt(gpioStr, 10));
    if (!pos) continue;
    const termIdx = ["ena", "in1", "in2", "in3", "in4", "enb"].indexOf(term);
    const termCx = ESP_TERMINAL_XS[termIdx];
    // Top-row pins emerge from BOTTOM of the dot; bottom-row pins also
    // emerge from bottom (since the L298N sits below the whole board).
    const startY = pos.cy + ESP_PIN_R;
    const endY = ESP_TERM_CY - ESP_TERM_R;
    const midY = (startY + endY) / 2;
    wires.push(`<path class="motor-wire wire-input" d="M${pos.cx},${startY} C${pos.cx},${midY} ${termCx},${midY} ${termCx},${endY}" data-wire="${escapeHtml(info.role)}"/>`);
  }
  return wires.join("");
}

function espEncoderModuleFragment(side, cx, opts) {
  const { editable, editConfig, flagged } = opts || {};
  const pcbX = cx - ESP_ENC_PCB_W / 2;
  const vccDx = side === "left" ? +ESP_ENC_PIN_DX : -ESP_ENC_PIN_DX;
  const gndDx = -vccDx;
  const vccX  = cx + vccDx;
  const outX  = cx;
  const gndX  = cx + gndDx;
  const pcbTopY = ESP_ENC_Y;

  let inputFrag = "";
  if (editable) {
    const key = side === "left" ? "enc_l" : "enc_r";
    const v = editConfig?.[key];
    const display = v == null || v < 0 ? "" : String(v);
    const conflictCls = v != null && v >= 0 && flagged?.has(v) ? " conflict" : "";
    inputFrag = `
      <foreignObject x="${outX - 22}" y="${ESP_ENC_DOT_Y + 12}" width="44" height="22">
        <input xmlns="http://www.w3.org/1999/xhtml" type="text" inputmode="numeric" maxlength="2"
               class="terminal-input${conflictCls}" data-key="${key}"
               value="${escapeHtml(display)}" placeholder="—" />
      </foreignObject>
    `;
  }

  return `
    <rect class="enc-pcb" x="${pcbX}" y="${pcbTopY}" width="${ESP_ENC_PCB_W}" height="${ESP_ENC_PCB_H}" rx="6"/>
    <text class="enc-title" x="${cx}" y="${pcbTopY + 16}" text-anchor="middle">encoder · ${side}</text>
    <text class="enc-pin-label" x="${vccX}" y="${ESP_ENC_DOT_Y - 11}" text-anchor="middle">VCC</text>
    <circle class="pin-dot enc-pin kind-3v3" cx="${vccX}" cy="${ESP_ENC_DOT_Y}" r="${ESP_ENC_DOT_R}"/>
    <text class="enc-pin-label" x="${outX}" y="${ESP_ENC_DOT_Y - 11}" text-anchor="middle">OUT</text>
    <circle class="pin-dot enc-pin kind-gpio" cx="${outX}" cy="${ESP_ENC_DOT_Y}" r="${ESP_ENC_DOT_R}" data-wire="${escapeHtml(`encoders.${side}`)}"/>
    <text class="enc-pin-label" x="${gndX}" y="${ESP_ENC_DOT_Y - 11}" text-anchor="middle">GND</text>
    <circle class="pin-dot enc-pin kind-gnd" cx="${gndX}" cy="${ESP_ENC_DOT_Y}" r="${ESP_ENC_DOT_R}"/>
    ${inputFrag}
  `;
}

function espEncoderWiresFragment(side, claims, gpioMap, kindPos) {
  const cx   = side === "left" ? ESP_ENC_LEFT_CX : ESP_ENC_RIGHT_CX;
  const vccX = side === "left" ? cx + ESP_ENC_PIN_DX : cx - ESP_ENC_PIN_DX;
  const outX = cx;
  const gndX = side === "left" ? cx - ESP_ENC_PIN_DX : cx + ESP_ENC_PIN_DX;
  const gndPos = side === "left" ? kindPos.gndLeft : kindPos.gndRight;
  const vccPos = kindPos.vcc;
  const out = [];

  // Encoder pin BOTTOMS face DOWN toward the ESP32 (encoders sit above
  // the board). Wires emerge from the bottom of the encoder dot and
  // arrive at the top of the ESP32 pin dot. Bezier control points at
  // midY produce a vertical-dominant S-curve.
  const path = (sx, sy, ex, ey, cls, role) => {
    const midY = (sy + ey) / 2;
    const dataAttr = role ? ` data-wire="${escapeHtml(role)}"` : "";
    return `<path class="enc-wire ${cls}" d="M${sx},${sy} C${sx},${midY} ${ex},${midY} ${ex},${ey}"${dataAttr}/>`;
  };
  const encY = ESP_ENC_DOT_Y + ESP_ENC_DOT_R;             // bottom of encoder dot
  const targetY = (pos) => pos.cy - ESP_PIN_R;            // top of ESP32 pin dot

  if (vccPos) out.push(path(vccX, encY, vccPos.cx, targetY(vccPos), "wire-vcc"));
  if (gndPos) out.push(path(gndX, encY, gndPos.cx, targetY(gndPos), "wire-gnd"));

  let outGpio = null;
  for (const [g, info] of Object.entries(claims)) {
    if (info?.cap === "encoders" && info?.role === side) { outGpio = parseInt(g, 10); break; }
  }
  if (outGpio != null) {
    const pos = gpioMap.get(outGpio);
    if (pos) out.push(path(outX, encY, pos.cx, targetY(pos), "wire-out", `encoders.${side}`));
  }
  return out.join("");
}

// ESP32 has two driving modes — same shape as the Pi side's gpiozero
// Motor(enable=…) constructor:
//   PWM-on-direction: ENA/ENB tied HIGH externally; PWM on IN1..IN4.
//                     Firmware ignores m_ena / m_enb (left -1).
//   PWM-on-enable:    ENA/ENB wired to MCU pins; firmware PWMs on them
//                     and toggles IN1..IN4 as digital direction lines.
// Both terminals are editable now; firmware's modes_init() picks the
// drive path based on whether m_ena / m_enb are set.
const ESP_TERMINAL_TO_KEY = {
  ena: "m_ena",
  in1: "m_l_fwd",
  in2: "m_l_bwd",
  in3: "m_r_fwd",
  in4: "m_r_bwd",
  enb: "m_enb",
};

function renderEsp32BoardWithDriver(entry, opts = {}) {
  const { editable = false, editConfig = null, flagged = new Set() } = opts;
  const layout = boardPins(entry);
  const spacing = pinSpacingForLayout(layout);
  const gpioMap = gpioToPosMap(layout);
  const kindPos = boardKindPositions(layout);
  const claims = esp32ClaimsFromEntry(entry);
  // Mark a top/bot pin as "claimed" if any cap currently uses its GPIO
  // — gives the same blue-ring affordance the Pi pin dots have.
  const renderRow = (arr, y, labelAbove) => arr.map((p, i) =>
    espPinFragment(p, ESP_FIRST_PIN_X + i * spacing, y, labelAbove,
                   p.gpio != null && claims[p.gpio] != null),
  ).join("");
  const topPins = renderRow(layout.top, ESP_TOP_ROW_Y, true);
  const botPins = renderRow(layout.bot, ESP_BOT_ROW_Y, false);
  const pcbY = ESP_TOP_ROW_Y + 18;
  const pcbH = ESP_BOT_ROW_Y - ESP_TOP_ROW_Y - 36;

  const driverPcb = `
    <rect class="driver-pcb" x="15" y="${ESP_DRIVER_Y}" width="${ESP_W - 30}" height="${ESP_DRIVER_H}" rx="6"/>
    <text class="driver-title" x="${ESP_W / 2}" y="${ESP_DRIVER_Y + 22}" text-anchor="middle">H-bridge driver inputs</text>
  `;
  const terminals = ["ena", "in1", "in2", "in3", "in4", "enb"].map((role, i) => {
    const cx = ESP_TERMINAL_XS[i];
    const kind = role.startsWith("en") ? "enable" : "input";
    const label = { ena: "ENA", in1: "IN1", in2: "IN2", in3: "IN3", in4: "IN4", enb: "ENB" }[role];
    let inputFrag = "";
    if (editable && ESP_TERMINAL_TO_KEY[role]) {
      const key = ESP_TERMINAL_TO_KEY[role];
      const v = editConfig?.[key];
      const display = v == null || v < 0 ? "" : String(v);
      const conflictCls = v != null && v >= 0 && flagged.has(v) ? " conflict" : "";
      inputFrag = `
        <foreignObject x="${cx - 22}" y="${ESP_TERM_CY + 12}" width="44" height="22">
          <input xmlns="http://www.w3.org/1999/xhtml" type="text" inputmode="numeric" maxlength="2"
                 class="terminal-input${conflictCls}" data-key="${key}"
                 value="${escapeHtml(display)}" />
        </foreignObject>
      `;
    }
    return `
      <text class="driver-label" x="${cx}" y="${ESP_TERM_CY - 14}" text-anchor="middle">${label}</text>
      <circle class="driver-pin ${kind}" cx="${cx}" cy="${ESP_TERM_CY}" r="${ESP_TERM_R}" data-role="${role}"/>
      ${inputFrag}
    `;
  }).join("");

  const encoderModules = `
    ${espEncoderModuleFragment("left",  ESP_ENC_LEFT_CX, { editable, editConfig, flagged })}
    ${espEncoderModuleFragment("right", ESP_ENC_RIGHT_CX, { editable, editConfig, flagged })}
  `;
  const encoderWires = `
    ${espEncoderWiresFragment("left",  claims, gpioMap, kindPos)}
    ${espEncoderWiresFragment("right", claims, gpioMap, kindPos)}
  `;
  const motorWires = espMotorWiresFragment(claims, gpioMap);

  const supplyNote = `
    <text class="driver-supply" x="${ESP_W / 2}" y="${ESP_TOTAL_H - 18}" text-anchor="middle">
      Also connect (not shown): common GND between ESP32 + L298N · motor supply 7–12V to VS
    </text>
  `;

  return `
    <div class="pinout-svg-wrap esp32">
      <svg class="pinout-svg esp32" viewBox="0 0 ${ESP_W} ${ESP_TOTAL_H}" preserveAspectRatio="xMidYMid meet"
           xmlns="http://www.w3.org/2000/svg" role="img"
           aria-label="ESP32-CAM header with encoder modules and H-bridge driver wiring">
        <rect class="esp-pcb" x="20" y="${pcbY}" width="${ESP_W - 40}" height="${pcbH}" rx="6"/>
        <text class="esp-chip-label" x="${ESP_W / 2}" y="${(ESP_TOP_ROW_Y + ESP_BOT_ROW_Y) / 2}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(layout.label)}</text>
        ${topPins}
        ${botPins}
        ${encoderModules}
        ${driverPcb}
        ${terminals}
        ${encoderWires}
        ${motorWires}
        ${supplyNote}
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
  // Fall back to PI_DEFAULTS for any field the conf doesn't override —
  // matches what pi_robot.py is actually using (and what the input fields
  // display) so SVG wires render on first open of a fresh robot.
  const claims = {};
  const ledPin = cfg?.led_pin ?? PI_DEFAULTS.led_pin;
  if (cfg?.led_enabled && ledPin != null) {
    const phys = GPIO_TO_PHYS.get(ledPin);
    if (phys) claims[phys] = { cap: "led", role: "out" };
  }
  if (cfg?.motors_enabled) {
    const mp = cfg.motors_pins || {};
    const effective = {
      left:  { ...PI_DEFAULTS.motors_pins.left,  ...(mp.left  || {}) },
      right: { ...PI_DEFAULTS.motors_pins.right, ...(mp.right || {}) },
    };
    for (const [role, gpio] of flattenPins(effective)) {
      const phys = GPIO_TO_PHYS.get(gpio);
      if (phys) claims[phys] = { cap: "motors", role };
    }
  }
  // Encoders default-on in firmware (matches camera_enabled pattern),
  // so undefined in the conf means enabled.
  if (cfg?.encoders_enabled !== false) {
    const effective = { ...PI_DEFAULTS.encoders_pins, ...(cfg?.encoders_pins || {}) };
    for (const [role, gpio] of Object.entries(effective)) {
      const phys = GPIO_TO_PHYS.get(gpio);
      if (phys) claims[phys] = { cap: "encoders", role };
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
  // Show Pi + driver + encoders diagram when any of those caps is
  // claimed; plain Pi board otherwise. The diagram is the high-value
  // reference while wiring — users need to see it in view mode, not
  // only edit.
  const hasBoardClaims = Object.values(claims).some(c => c?.cap === "motors" || c?.cap === "encoders");
  $("pinout-body").innerHTML = `
    ${hasBoardClaims ? renderBoardWithDriver(claims) : renderBoard(claims)}
    <div class="row" style="margin-top: 12px;">${legend}${editBtn}</div>
  `;
  $("pinout-edit-btn")?.addEventListener("click", () => beginEdit(entry.id));
  wireUpMotorChains($("pinout-body"));
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
  const encodersChecked = c.encoders_enabled !== false ? "checked" : "";
  const motors = c.motors_pins || {};
  const encoders = c.encoders_pins || {};
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
  const encodersEnabledEff = c.encoders_enabled !== false;
  for (const [role, g] of Object.entries(encoders)) {
    if (typeof g !== "number") continue;
    (usage[g] ||= []).push({ role: `encoders.${role}`, enabled: encodersEnabledEff });
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
  for (const [role, g] of Object.entries(encoders)) {
    if (typeof g === "number") checkReserved(g, `encoders.${role}`, encodersEnabledEff);
  }
  // GPIOs to flag inline (red border on the input). Soft conflicts live in
  // the warning line only — they aren't actively-broken state, so flagging
  // both sides would mislead.
  const flagged = new Set();
  for (const [g] of hard) flagged.add(parseInt(g, 10));
  for (const r of reservedHits) flagged.add(r.pin);

  const warnParts = [];
  if (hard.length) warnParts.push(`<span class="warn-hard">Conflict: ${hard.map(([g, v]) => `GPIO ${g} (${fmt(v)})`).join("; ")}</span>`);
  if (soft.length) warnParts.push(`<span class="warn-soft">Latent: ${soft.map(([g, v]) => `GPIO ${g} (${fmt(v)})`).join("; ")}</span>`);
  if (reservedHits.length) warnParts.push(`<span class="warn-soft">Reserved: ${reservedHits.map(h => `GPIO ${h.pin} (${h.fn})`).join("; ")}</span>`);
  const warnLine = warnParts.length
    ? `<div class="pinout-warn-line${hard.length ? " has-hard" : ""}">${warnParts.join(" · ")}</div>`
    : "";

  const ledFlagCls = (c.led_pin != null && flagged.has(c.led_pin)) ? " conflict" : "";

  $("pinout-body").innerHTML = `
    <div class="pinout-toolbar">
      <label class="toolbar-toggle">
        <input type="checkbox" data-toggle="led_enabled" ${ledChecked}>
        <span>LED</span>
        <!-- LED is one pin direct to one LED — no driver chip, no diagram
             value beyond the Pi pin claim. Lives in the toolbar; the SVG
             below stays focused on the H-bridge wiring. -->
        <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input${ledFlagCls}"
               data-path="led_pin" value="${c.led_pin ?? PI_DEFAULTS.led_pin}">
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" data-toggle="motors_enabled" ${motorsChecked}>
        <span>Motors (H-bridge)</span>
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" data-toggle="encoders_enabled" ${encodersChecked}>
        <span>Encoders</span>
        <!-- Pin inputs live on the SVG breakout modules below — same
             pattern as the L298N terminals. Toolbar carries only the
             advertise/don't-advertise toggle. -->
      </label>
      <label class="toolbar-toggle">
        <input type="checkbox" data-toggle="camera_auto" ${cameraChecked}>
        <span>Camera (auto)</span>
      </label>
    </div>
    ${renderBoardWithDriver(claims, { editable: true, editConfig: c, flagged })}
    ${warnLine}
    <div class="meta pinout-helper">
      Numbers are BCM GPIO IDs. Empty ENA/ENB = jumpers left on (no speed-control wire).
      Swap "forward"/"backward" to fix a wheel that spins the wrong way.
      Encoder VCC/GND tap any Pi 3V3 / GND; check your sensor's voltage (most are 3V3).
    </div>
    <div class="modal-footer">
      <button class="secondary sm" id="pinout-cancel-btn">Cancel</button>
      <!-- One-click preset: pins set to safe, non-reserved, conflict-free
           values that work on any Pi 4 with stock raspi-config. -->
      <button class="secondary sm" id="pinout-safe-defaults-btn">Use safe defaults</button>
      <!-- Pulses each motor in turn, asks what wheel turned + which way,
           writes the derived orientation flips. Eliminates the recurring
           swap/polarity wiring guesswork. -->
      <button class="secondary sm" id="pinout-calibrate-btn">Calibrate motors</button>
      <button class="sm" id="pinout-save-btn" ${hard.length ? "disabled" : ""}>Save &amp; restart</button>
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
      const raw = el.value.trim();
      let obj = editConfig;
      for (let i = 0; i < path.length - 1; i++) {
        obj[path[i]] ||= {};
        obj = obj[path[i]];
      }
      const key = path[path.length - 1];
      // Empty value on an optional field clears the key from config so the
      // wire disappears. Required fields stay in a transient invalid state
      // (the input is empty, editConfig still holds the prior value) and
      // skip the re-render — otherwise the rebuild snaps the input back to
      // the prior value from editConfig and the user can't replace the
      // last remaining digit.
      if (raw === "") {
        if (el.dataset.optional === "true") {
          delete obj[key];
          renderEdit(entry);
        }
        return;
      }
      const v = parseInt(raw, 10);
      if (Number.isNaN(v)) return;
      obj[key] = v;
      renderEdit(entry);
    });
    // Focus a pin input → highlight the corresponding circle on the board so
    // the user sees which physical pin they're about to edit. Re-renders
    // blow the class away; we re-apply at the end of renderEdit.
    el.addEventListener("focus", () => highlightPinFromInput(el));
    el.addEventListener("blur",  () => clearPinHighlight());
  });
  $("pinout-cancel-btn")?.addEventListener("click", () => {
    editMode = false;
    editConfig = null;
    renderView(entry);
  });
  $("pinout-save-btn")?.addEventListener("click", () => saveEdit(entry));
  // Safe-defaults preset: matches pi_robot.py's MOTORS_PINS + LED_PIN
  // defaults. Now that the edit-form fallbacks match too, this button
  // is a *restore* affordance — useful after the user has drifted off
  // the canonical assignments and wants the working ones back.
  $("pinout-safe-defaults-btn")?.addEventListener("click", () => {
    editConfig.led_pin = PI_DEFAULTS.led_pin;
    editConfig.motors_pins = structuredClone(PI_DEFAULTS.motors_pins);
    editConfig.encoders_pins = structuredClone(PI_DEFAULTS.encoders_pins);
    renderEdit(entry);
  });
  $("pinout-calibrate-btn")?.addEventListener("click", () => {
    beginMotorsCalibration({
      entry,
      editConfig,
      onCancel: () => renderEdit(entry),
      onDone: (ok) => {
        if (ok) {
          // Service restart drops BLE briefly; close the dialog so the user
          // sees the disconnect+reconnect on the card. Mirrors saveEdit.
          editMode = false;
          editConfig = null;
          $("pinout-modal").close();
        } else {
          // Save failed — drop back to the editor; the orientation we
          // derived is still in the user's head, they can retry.
          renderEdit(entry);
        }
      },
    });
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
  // innerHTML rebuild wiped the focused-pin class on the SVG; re-apply based
  // on whatever input is currently focused so the highlight tracks typing.
  const act = document.activeElement;
  if (act?.dataset?.path) highlightPinFromInput(act);
  wireUpMotorChains($("pinout-body"));
}

function highlightPinFromInput(el) {
  clearPinHighlight();
  const gpio = parseInt(el.value, 10);
  if (Number.isNaN(gpio)) return;
  const phys = GPIO_TO_PHYS.get(gpio);
  if (!phys) return;
  const circle = document.querySelector(`.pinout-svg .pin-dot[data-phys="${phys}"]`);
  circle?.classList.add("focused");
}

function clearPinHighlight() {
  document.querySelectorAll(".pinout-svg .pin-dot.focused")
    .forEach(el => el.classList.remove("focused"));
}

// Wires up cross-element hover + click on motor connections. Elements
// tagged with the same `data-wire` value (pin-dot, claim-text, wire
// path, driver terminal) light up together on hover. Click jumps focus
// to the matching editor input — only effective in edit mode, when the
// inputs exist; in view mode it's a no-op so the chain still works as a
// read-only legend.
function wireUpMotorChains(container) {
  const activate = (wire) => {
    container.querySelectorAll(`[data-wire="${wire}"]`)
      .forEach(e => e.classList.add("wire-active"));
  };
  const deactivate = () => {
    container.querySelectorAll(".wire-active")
      .forEach(e => e.classList.remove("wire-active"));
  };
  container.querySelectorAll("[data-wire]").forEach(el => {
    const wire = el.dataset.wire;
    el.addEventListener("mouseenter", () => activate(wire));
    el.addEventListener("mouseleave", deactivate);
    el.addEventListener("click", () => {
      // role "left forward" → config path "motors_pins.left.forward".
      const path = `motors_pins.${wire.replace(" ", ".")}`;
      const input = container.querySelector(`input[data-path="${path}"]`);
      if (input) {
        input.focus();
        try { input.setSelectionRange(0, input.value.length); } catch {}
      }
    });
  });
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
  if (entry.fwType === "esp32") {
    renderEsp32View(entry);
  } else {
    renderView(entry);
  }
  $("pinout-modal").showModal();
}

// ESP32 path — read current pin assignments straight from fw-info (no
// get-config round-trip needed; the firmware already advertises them on
// the led/flash/motors cap entries). Edit in place; save by writing JSON
// to the PIN_CONFIG char (firmware persists to NVS + restarts).

function esp32PinsFromFwInfo(entry) {
  const caps = entry?.fwInfo?.caps || [];
  const led      = caps.find(c => c.name === "led")?.pin;
  const flash    = caps.find(c => c.name === "flash")?.pin;
  const motors   = caps.find(c => c.name === "motors")?.pins;
  const encoders = caps.find(c => c.name === "encoders")?.pins;
  return {
    led:     led    ?? 33,
    // No-cap fallback: -1 (disabled). C3/DevKit firmware doesn't advertise
    // flash at all; defaulting to GPIO 4 fabricates a phantom claim that
    // collides with whatever the user has on 4 (often a motor IN pin).
    flash:   flash  ?? -1,
    m_l_fwd: motors?.left?.forward   ?? 14,
    m_l_bwd: motors?.left?.backward  ?? 15,
    m_r_fwd: motors?.right?.forward  ?? 13,
    m_r_bwd: motors?.right?.backward ?? 12,
    // ENA/ENB optional — firmware uses PWM-on-direction when these are
    // -1 (L298N's factory jumpers on +5V), PWM-on-enable when set.
    m_ena:   motors?.left?.enable    ?? -1,
    m_enb:   motors?.right?.enable   ?? -1,
    // Encoders default disabled on ESP32 (firmware ships -1) — pin
    // pressure on ESP32-CAM makes a sensible default infeasible.
    enc_l:   encoders?.left  ?? -1,
    enc_r:   encoders?.right ?? -1,
  };
}

// Camera-reserved lookups live in boards.js — empty Set on no-camera
// boards by design so the editor's conflict guard doesn't false-positive
// on DevKit / C3 motor assignments.
function cameraReservedFor(entry) {
  return cameraReservedSet(entry?.fwInfo?.board);
}
// Static AI-Thinker camera set for esp32PinNote — the read-only pin
// notes default to the AI-Thinker context where the camera surface is
// the most common confusion. DevKit/C3 don't render notes through this
// function for those pins because their pin entries already carry
// board-specific notes via boards.js.
const ESP32_CAMERA_RESERVED_AITHINKER = cameraReservedSet("aithinker_cam");

function esp32PinNote(pin) {
  if (ESP32_CAMERA_RESERVED_AITHINKER.has(pin)) return "camera";
  if (pin === 1 || pin === 3) return "UART (sacrifices serial)";
  if (pin === 2)  return "strap (must be HIGH/floating at boot)";
  if (pin === 12) return "strap (must be LOW at boot — most blue L298N boards work; some need a 10k pull-down)";
  if (pin === 16 || pin === 17) return "PSRAM on some AI-Thinker revisions — risky";
  if (pin === 4)  return "white flash LED";
  if (pin === 33) return "red status LED";
  if (pin >= 13 && pin <= 15) return "safe (SD pins, free when SD unused)";
  return "";
}

function renderEsp32View(entry) {
  const pins = esp32PinsFromFwInfo(entry);
  const row = (label, key) => {
    const v = pins[key];
    const note = v < 0 ? "(disabled)" : esp32PinNote(v);
    return `<div class="pinout-edit-row">
      <span class="pinout-edit-label">${label}</span>
      <code>${v < 0 ? "—" : "GPIO " + v}</code>
      ${note ? `<span class="meta">· ${escapeHtml(note)}</span>` : ""}
    </div>`;
  };
  // The Flash row is the AI-Thinker camera-flash LED. Boards without a
  // camera (DevKit, C3) have nowhere to wire it; the firmware also
  // disables it by default. Hide the row instead of showing a permanently
  // disabled slot that reads as "we're reserving something for camera."
  const hasFlash = (entry?.fwInfo?.caps || []).some(c => c.name === "flash");
  const connected = entry?.status === "connected";
  const editBtn = connected
    ? `<button class="secondary sm" id="pinout-edit-btn">Edit pins</button>`
    : "";
  $("pinout-body").innerHTML = `
    ${renderEsp32BoardWithDriver(entry)}
    <div class="pinout-edit">
      <div class="pinout-edit-section">
        ${row("LED",            "led")}
        ${hasFlash ? row("Flash", "flash") : ""}
        ${row("Left forward",   "m_l_fwd")}
        ${row("Left backward",  "m_l_bwd")}
        ${row("Left enable",    "m_ena")}
        ${row("Right forward",  "m_r_fwd")}
        ${row("Right backward", "m_r_bwd")}
        ${row("Right enable",   "m_enb")}
        ${row("Encoder left",   "enc_l")}
        ${row("Encoder right",  "enc_r")}
      </div>
    </div>
    <div class="row" style="margin-top: 12px;">
      <div class="meta">${esp32FooterNote(entry)}</div>
      ${editBtn}
    </div>
  `;
  $("pinout-edit-btn")?.addEventListener("click", () => beginEsp32Edit(entry));
  wireUpMotorChains($("pinout-body"));
}

function beginEsp32Edit(entry) {
  editMode = true;
  editConfig = esp32PinsFromFwInfo(entry);
  renderEsp32Edit(entry);
}

function renderEsp32Edit(entry) {
  // Preserve focus across the innerHTML rebuild so typing into a pin
  // input doesn't blur after every keystroke. Mirrors the Pi side's
  // approach.
  const active = document.activeElement;
  const savedKey = active?.dataset?.key || null;

  const c = editConfig;
  // Flash only exists on boards that advertise the cap (AI-Thinker CAM).
  // Excluding it from ALL_KEYS on no-flash boards keeps the conflict guard
  // from flagging a phantom claim against the real motor/LED assignments.
  const hasFlash = (entry?.fwInfo?.caps || []).some(c => c.name === "flash");
  const ALL_KEYS = ["led", ...(hasFlash ? ["flash"] : []), "m_l_fwd", "m_l_bwd", "m_r_fwd", "m_r_bwd", "m_ena", "m_enb", "enc_l", "enc_r"];
  const usedBy = {};
  for (const k of ALL_KEYS) {
    if (c[k] < 0) continue;  // -1 = disabled, multiple disables don't conflict
    (usedBy[c[k]] ||= []).push(k);
  }
  const dup = Object.entries(usedBy).filter(([, v]) => v.length > 1);
  const cameraReserved = cameraReservedFor(entry);
  const cameraHits = ALL_KEYS.flatMap(k => {
    const p = c[k];
    return (p >= 0 && cameraReserved.has(p)) ? [[k, p]] : [];
  });

  // GPIOs to flag inline (red border on input). Hard conflicts + camera
  // hits earn the flag; the warning bar names the offenders in prose.
  const flagged = new Set();
  for (const [, v] of dup) for (const k of v) if (c[k] >= 0) flagged.add(c[k]);
  for (const [, p] of cameraHits) flagged.add(p);

  const warn = [
    dup.length
      ? `<div class="pinout-warn">Conflict: ${dup.map(([g, v]) => `GPIO ${g} assigned to ${v.join(" + ")}`).join("; ")}</div>`
      : "",
    cameraHits.length
      ? `<div class="pinout-warn">Camera-reserved: ${cameraHits.map(([k, p]) => `GPIO ${p} (${k})`).join("; ")} — must be reassigned before saving.</div>`
      : "",
  ].filter(Boolean).join("");

  const blocked = dup.length > 0 || cameraHits.length > 0;
  // Synthesize a transient entry-shaped object so renderEsp32BoardWithDriver
  // can derive claims from the in-progress edit (mirrors the Pi side's
  // editConfig flow, which feeds claimsFromConfig). fwInfo carries over
  // from the live entry so the board-aware layout dispatch keeps using
  // the right pin map (DevKit / C3 / AI-Thinker) during edit.
  const previewEntry = {
    fwInfo: entry?.fwInfo,
    capSchema: [
      ...(c.m_l_fwd >= 0 ? [{
        name: "motors",
        pins: {
          left:  {
            forward: c.m_l_fwd,
            backward: c.m_l_bwd,
            ...(c.m_ena >= 0 ? { enable: c.m_ena } : {}),
          },
          right: {
            forward: c.m_r_fwd,
            backward: c.m_r_bwd,
            ...(c.m_enb >= 0 ? { enable: c.m_enb } : {}),
          },
        },
      }] : []),
      ...(c.enc_l >= 0 || c.enc_r >= 0 ? [{
        name: "encoders",
        pins: { left: c.enc_l >= 0 ? c.enc_l : -1, right: c.enc_r >= 0 ? c.enc_r : -1 },
      }] : []),
    ],
  };
  // Toolbar carries LED + Flash because they don't belong to any chip
  // below the ESP32 (LED is direct-attach, Flash is the white LED on
  // GPIO4). Motors + encoders edit inline on the SVG below.
  const ledV   = c.led < 0   ? "" : String(c.led);
  const flashV = c.flash < 0 ? "" : String(c.flash);
  const ledCls   = c.led   >= 0 && flagged.has(c.led)   ? " conflict" : "";
  const flashCls = c.flash >= 0 && flagged.has(c.flash) ? " conflict" : "";

  $("pinout-body").innerHTML = `
    <div class="pinout-toolbar">
      <label class="toolbar-toggle">
        <span>LED</span>
        <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input${ledCls}"
               data-key="led" value="${ledV}" placeholder="—">
      </label>
      ${hasFlash ? `<label class="toolbar-toggle">
        <span>Flash</span>
        <input type="text" inputmode="numeric" maxlength="2" class="pinout-edit-input${flashCls}"
               data-key="flash" value="${flashV}" placeholder="—">
      </label>` : ""}
    </div>
    ${renderEsp32BoardWithDriver(previewEntry, { editable: true, editConfig: c, flagged })}
    ${warn}
    <div class="meta pinout-helper">
      Numbers are ESP32 GPIO IDs. Blank input = capability disabled.
      Camera-reserved pins (15 GPIOs) are off-limits; hover any pin for its constraint.
    </div>
    <div class="modal-footer">
      <button class="secondary sm" id="pinout-cancel-btn">Cancel</button>
      <!-- Pulses each motor in turn, asks which wheel turned + which way,
           writes the derived orientation flips via the ops char. Same
           wizard as Pi — different transport, same outcome. -->
      <button class="secondary sm" id="pinout-calibrate-btn">Calibrate motors</button>
      <button class="sm" id="pinout-save-btn" ${blocked ? "disabled" : ""}>Save &amp; restart</button>
    </div>
  `;
  $("pinout-body").querySelectorAll("input[data-key]").forEach(el => {
    el.addEventListener("input", () => {
      const raw = el.value.trim();
      // Empty input = -1 (cap disabled). Otherwise parse the integer; ignore
      // unparseable so partial typing doesn't snap to NaN mid-keystroke.
      const v = raw === "" ? -1 : parseInt(raw, 10);
      if (!Number.isNaN(v)) {
        editConfig[el.dataset.key] = v;
        renderEsp32Edit(entry);  // re-render to refresh conflict + wires
      }
    });
    // Focus a pin input → highlight the corresponding ESP32 pin dot so
    // the user sees which physical pin they're about to edit.
    el.addEventListener("focus", () => highlightEsp32PinFromInput(el));
    el.addEventListener("blur",  () => clearPinHighlight());
  });
  $("pinout-cancel-btn").addEventListener("click", () => {
    editMode = false; editConfig = null; renderEsp32View(entry);
  });
  $("pinout-calibrate-btn")?.addEventListener("click", () => {
    beginMotorsCalibration({
      entry,
      editConfig,
      onCancel: () => renderEsp32Edit(entry),
      onDone: (ok) => {
        if (ok) {
          // ESP32 calibration save calls motors_set_orientation, which
          // schedules a 500ms restart on the chip. BLE drops briefly;
          // dashboard's auto-reconnect picks it back up. Close the dialog
          // so the user sees the reconnect on the card.
          editMode = false;
          editConfig = null;
          $("pinout-modal").close();
        } else {
          renderEsp32Edit(entry);
        }
      },
    });
  });
  $("pinout-save-btn").addEventListener("click", () => saveEsp32Edit(entry));
  wireUpMotorChains($("pinout-body"));

  // Restore focus + cursor across the innerHTML rebuild so the user
  // can keep typing without re-clicking.
  if (savedKey) {
    const el = $("pinout-body").querySelector(`input[data-key="${savedKey}"]`);
    if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n); } catch {} }
  }
  // Re-apply focus highlight on the SVG dot for whatever input has focus.
  const act = document.activeElement;
  if (act?.dataset?.key) highlightEsp32PinFromInput(act);
}

function highlightEsp32PinFromInput(el) {
  clearPinHighlight();
  const gpio = parseInt(el.value, 10);
  if (Number.isNaN(gpio)) return;
  const circle = document.querySelector(`.pinout-svg.esp32 .pin-dot[data-gpio="${gpio}"]`);
  circle?.classList.add("focused");
}

async function saveEsp32Edit(entry) {
  // Range check (firmware also validates, but reject early so the user
  // gets a focused error instead of a silent ignore over BLE). -1 means
  // "cap disabled" — accepted; only out-of-range positives reject.
  for (const key of ["led", "flash", "m_l_fwd", "m_l_bwd", "m_r_fwd", "m_r_bwd", "enc_l", "enc_r"]) {
    const v = editConfig[key];
    if (!Number.isInteger(v) || v === -1) continue;
    if (v < 0 || v > 39) {
      alert(`${key}: GPIO ${v} is out of range [0, 39] (or leave blank to disable).`);
      return;
    }
  }
  $("pinout-body").innerHTML = `<div class="meta">Writing pin config + restarting…</div>`;
  try {
    if (!entry.device?.gatt?.connected) throw new Error("not connected");
    const svc = await entry.device.gatt.getPrimaryService(SERVICE_UUID);
    const ch  = await svc.getCharacteristic(PIN_CONFIG_CHAR_UUID);
    await ch.writeValueWithResponse(encodeJson(editConfig));
    // Robot reboots immediately; BLE drops. Close the dialog so the user
    // sees the reconnect happen on the card.
    editMode = false;
    editConfig = null;
    $("pinout-modal").close();
  } catch (err) {
    $("pinout-body").innerHTML = `
      <div class="meta" style="color: var(--danger);">Save failed: ${escapeHtml(err.message || String(err))}</div>
      <div class="row" style="margin-top: 12px; justify-content: flex-end;">
        <button class="secondary sm" id="pinout-retry-btn">Retry</button>
      </div>
    `;
    $("pinout-retry-btn")?.addEventListener("click", () => renderEsp32Edit(entry));
  }
}

