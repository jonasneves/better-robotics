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

// v2 — bumped when the default-open shape changed: previously motors
// defaulted to open (it's the verb); the new shape is "all collapsed,
// user expands what they need." The bump invalidates pre-v2 prefs so
// existing operators get the cleaner default instead of carrying their
// old "every cap I ever opened stays open forever" state.
const STORE_KEY = "better-robotics:cap-open:v2";

// All collapsed by default. Hick's law: 7+ equally-weighted controls
// visible at once slows decisions; progressive disclosure puts each one
// behind a single tap and lets the user open the 1-2 they're using
// right now. Override per-cap via setOpen (persisted in localStorage).
const DEFAULTS = {};

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
// so a disclosure toggle would lie. The header renders as plain (label +
// state + action) without the cap-toggle button.
//
// Source attribution (composite robots):
//   sourceMember = { id, name, fwType }
//     When set, a small chip after the label says "from <name>" colored
//     by fwType. Tells the operator which member contributed this cap.
//   alternativeMemberIds = [deviceId, ...]
//     Other members that ALSO declare this cap name. When non-empty, a ⇄
//     swap button appears in the header — clicking it sets the
//     capSourcePref to the next member in the cycle. Empty (the common
//     case, no overlap) = no swap button rendered.
export function capSection({
  name, label, state = "", action = "", body = "",
  sourceMember = null, alternativeMemberIds = [],
}) {
  const hasBody = !!body && body.trim().length > 0;
  const open = isOpen(name);
  const sourceChip = sourceMember
    ? `<span class="cap-source type-badge type-${escapeHtml(sourceMember.fwType || "")}" title="from ${escapeHtml(sourceMember.name)}">${
        escapeHtml(sourceMember.fwType === "esp32" ? "ESP32" : (sourceMember.fwType || "").toUpperCase())
      }</span>`
    : "";
  const labelHtml = `
    <span class="cap-label">${escapeHtml(label)}</span>
    ${sourceChip}
    ${state ? `<span class="cap-state">${escapeHtml(state)}</span>` : ""}
  `;
  const head = hasBody
    ? `<button class="cap-toggle" data-cap-toggle="${escapeHtml(name)}" aria-expanded="${open}" type="button">
         <svg class="icon-svg cap-chevron" aria-hidden="true"><use href="icons.svg#icon-chevron-down"/></svg>
         ${labelHtml}
       </button>`
    : `<div class="cap-static">${labelHtml}</div>`;
  // Swap button appears only when another member also declares this cap —
  // gives the user a one-click way to override first-member-wins for THIS
  // cap without splitting the whole robot. Disappears when there's nothing
  // to swap to, so single-source caps stay clean.
  const swapBtn = alternativeMemberIds.length > 0
    ? `<button class="icon sm cap-swap" data-action="cap-swap-${escapeHtml(name)}" title="Use a different device for this capability" aria-label="Swap source"><svg class="icon-svg"><use href="icons.svg#icon-swap"/></svg></button>`
    : "";
  return `
    <div class="cap-section" data-cap-name="${escapeHtml(name)}">
      <div class="cap-header">
        ${head}
        ${swapBtn}
        ${action}
      </div>
      ${hasBody ? `<div class="cap-body" ${open ? "" : "hidden"}>${body}</div>` : ""}
    </div>
  `;
}
