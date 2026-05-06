// Shared disclosure-list wrapper for capability sections.
//
// Each capability renders a header (icon + label + state + primary action)
// that's always visible, plus an optional body that toggles open/collapsed.
// Modeled on iOS Settings list rows + macOS Finder outline: action stays
// clickable when collapsed, depth is one tap away.
//
// Open state persists per capability NAME (not per robot) — user's
// "always show motors" preference is the same across all their robots.
import { escapeHtml } from "../../dom.js";

// v3 — bumped when the default-open shape changed: motors now defaults
// to open (it's the daily-driver verb); other caps stay collapsed.
const STORE_KEY = "better-robotics:cap-open:v3";
const DEFAULTS = { motors: true };

let _state = null;
function load() {
  if (_state) return _state;
  try { _state = JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); }
  catch { _state = {}; }
  return _state;
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(_state || {})); } catch {}
}

export function isOpen(name) {
  const s = load();
  if (s[name] != null) return !!s[name];
  return DEFAULTS[name] ?? false;
}

export function setOpen(name, open) {
  load()[name] = !!open;
  save();
}

// Render a capability section. `body` is the HTML between the header and
// the bottom edge of the section — shown only when open. `action` is HTML
// that goes in the header (typically the primary action button); always
// visible. Pass `state` for the secondary text (e.g. "off", "L:0 R:0").
//
// When body is empty, the chevron is dropped — there's nothing to expand,
// so a disclosure toggle would lie.
export function capSection({
  name, label, state = "", action = "", body = "",
  transport = "",
}) {
  const hasBody = !!body && body.trim().length > 0;
  const open = isOpen(name);
  // Tiny transport hint — surfaces "this fails when X is down" without
  // forcing the user to know which caps live on which channel. Hidden
  // when transport isn't specified (legacy / self-evident caps).
  const transportIcon = transport === "ble"
    ? `<svg class="icon-svg cap-transport" aria-label="via Bluetooth"><use href="icons.svg#icon-bluetooth"/></svg>`
    : transport === "wifi"
    ? `<svg class="icon-svg cap-transport" aria-label="via WiFi"><use href="icons.svg#icon-wifi"/></svg>`
    : "";
  const labelHtml = `
    ${transportIcon}
    <span class="cap-label">${escapeHtml(label)}</span>
    ${state ? `<span class="cap-state">${escapeHtml(state)}</span>` : ""}
  `;
  const head = hasBody
    ? `<button class="cap-toggle" data-cap-toggle="${escapeHtml(name)}" aria-expanded="${open}" type="button">
         <svg class="icon-svg cap-chevron" aria-hidden="true"><use href="icons.svg#icon-chevron-down"/></svg>
         ${labelHtml}
       </button>`
    : `<div class="cap-static">${labelHtml}</div>`;
  return `
    <div class="cap-section" data-cap-name="${escapeHtml(name)}">
      <div class="cap-header">
        ${head}
        ${action}
      </div>
      ${hasBody ? `<div class="cap-body" ${open ? "" : "hidden"}>${body}</div>` : ""}
    </div>
  `;
}
