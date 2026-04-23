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

const STORE_KEY = "better-robotics:cap-open:v1";

// Sensible defaults: motors is the verb, others are situational.
const DEFAULTS = {
  motors: true,
  led: false,
  wifi: false,
  camera: false,
  snapshot: false,
  ops: false,
};

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
export function capSection({ name, label, state = "", action = "", body = "" }) {
  const open = isOpen(name);
  return `
    <div class="cap-section" data-cap-name="${escapeHtml(name)}">
      <div class="cap-header">
        <button class="cap-toggle" data-cap-toggle="${escapeHtml(name)}" aria-expanded="${open}" type="button">
          <svg class="icon-svg cap-chevron" aria-hidden="true"><use href="icons.svg#icon-chevron-down"/></svg>
          <span class="cap-label">${escapeHtml(label)}</span>
          ${state ? `<span class="cap-state">${escapeHtml(state)}</span>` : ""}
        </button>
        ${action}
      </div>
      ${body ? `<div class="cap-body" ${open ? "" : "hidden"}>${body}</div>` : ""}
    </div>
  `;
}
