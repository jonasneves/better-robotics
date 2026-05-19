// Persistent reflex watcher. Lifts the "show sign → robot reacts" demo
// out of the script lifecycle and into the robot's capability surface so
// it works without a script open, and Pip can compose it ("watch for X,
// then ask_human"). Mirrors openpilot-panda's terminal-rung pattern —
// fire once and stand down so the action is a single, reviewable event
// rather than a forever-on edge that re-fires every frame.
//
// Actions are a closed set (halt / speak / notify). Same containment
// principle as ask_human being the bottom rung: a hallucinated Pip call
// can pick which verb, not invent a new one.

import { startDetection, isMediapipeFailed } from "./mediapipe.js";
import { pulseMotors } from "./capabilities/runtime/signed-pair.js";
import { listCameraSources } from "./camera-frame.js";
import { capSection } from "./capabilities/runtime/cap-section.js";
import { renderEntry } from "./capabilities/runtime/render-bus.js";
import { escapeHtml } from "./dom.js";
import { speak as ttsSpeak } from "./voice.js";

// id → { stop }
const _running = new Map();

// Fire-event listeners — assistant.js subscribes so it can inject a
// synthetic observation into Pip's active turn (L2 "harness pushes state
// to planner" pattern from Butter-Bench / ExploreVLM). Fire-once-disable
// means at most one event per arm cycle, so this can't spam the chat.
const _fireListeners = new Set();
export function onWatcherFire(fn) {
  _fireListeners.add(fn);
  return () => _fireListeners.delete(fn);
}
function emitFire(entry, det) {
  for (const fn of _fireListeners) {
    try { fn(entry, det); } catch (err) { console.warn("[watcher] fire listener:", err); }
  }
}

const ACTIONS = {
  halt:   async (entry)      => { await pulseMotors(entry.id, 0, 0, 200); },
  speak:  async (_entry, det) => { ttsSpeak(`saw ${det.label}`); },
  notify: async (entry, det) => {
    console.log(`[watcher] ${entry.name} saw ${det.label} (${(det.score * 100 | 0)}%)`);
  },
};
export const ACTION_NAMES = Object.keys(ACTIONS);

function ensureConfig(entry) {
  if (!entry.watcher) entry.watcher = { classes: ["stop sign"], action: "halt", enabled: false, lastDetection: null };
  return entry.watcher;
}

export function startWatcher(entry, opts = {}) {
  const cfg = ensureConfig(entry);
  if (opts.classes) {
    const list = Array.isArray(opts.classes) ? opts.classes : [String(opts.classes)];
    const cleaned = list.map(s => String(s).trim()).filter(Boolean);
    if (cleaned.length) cfg.classes = cleaned;
  }
  if (opts.action && ACTIONS[opts.action]) cfg.action = opts.action;
  stopWatcher(entry, { silent: true });
  cfg.enabled = true;
  const { promise, stop } = startDetection(entry, { classes: cfg.classes });
  _running.set(entry.id, { stop });
  promise.then(async (det) => {
    _running.delete(entry.id);
    if (!det) {
      // null = manually stopped, timed out, or detector permanently failed
      cfg.enabled = false;
      renderEntry(entry);
      return;
    }
    cfg.lastDetection = { label: det.label, score: det.score, ts: Date.now() };
    cfg.enabled = false;
    renderEntry(entry);
    try { await ACTIONS[cfg.action]?.(entry, det); }
    catch (err) { console.warn(`[watcher] action ${cfg.action} failed:`, err); }
    // Notify subscribers AFTER the action ran so the observation reads
    // "saw X, action Y executed" rather than "saw X, about to act."
    emitFire(entry, det);
  });
  renderEntry(entry);
  return cfg;
}

export function stopWatcher(entry, { silent = false } = {}) {
  const active = _running.get(entry.id);
  if (active) {
    active.stop();
    _running.delete(entry.id);
  }
  if (entry.watcher) entry.watcher.enabled = false;
  if (!silent) renderEntry(entry);
}

export function watcherStatus(entry) {
  const cfg = entry.watcher;
  if (!cfg) return { enabled: false };
  return {
    enabled: !!cfg.enabled,
    classes: cfg.classes,
    action: cfg.action,
    lastDetection: cfg.lastDetection,
  };
}

function fmtClock(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function renderSection(entry) {
  if (entry.status !== "connected") return "";
  // No camera = no reflex source. Hide the section so it doesn't pretend
  // to be functional on a robot it can't watch.
  if (listCameraSources(entry).length === 0) return "";
  if (isMediapipeFailed()) return "";
  const cfg = ensureConfig(entry);
  const enabled = !!cfg.enabled;
  const last = cfg.lastDetection;
  const state = enabled
    ? `watching: ${cfg.classes.join(", ")}`
    : last ? `saw ${last.label} at ${fmtClock(last.ts)}` : "off";
  const action = enabled
    ? `<button class="secondary sm" data-action="watcher-stop">Stop</button>`
    : `<button class="secondary sm" data-action="watcher-start">Start</button>`;
  const actionOpts = ACTION_NAMES.map(a =>
    `<option value="${a}"${cfg.action === a ? " selected" : ""}>${a}</option>`
  ).join("");
  const body = `
    <div class="watcher-body">
      <div class="row">
        <div class="label">Watch for</div>
        <input type="text" class="watcher-classes" data-action="watcher-classes"
               value="${escapeHtml(cfg.classes.join(", "))}"
               placeholder="stop sign, person"
               ${enabled ? "disabled" : ""}>
      </div>
      <div class="row">
        <div class="label">On detection</div>
        <select data-action="watcher-action" ${enabled ? "disabled" : ""}>${actionOpts}</select>
      </div>
      <div class="meta">Closed-vocab COCO (~80 classes). For open-vocab text prompts, use Pip's get_robot_detections.</div>
    </div>
  `;
  return capSection({ name: "watcher", label: "Reflex", state, action, body });
}

function wireActions(entry, node) {
  const cfg = ensureConfig(entry);
  const classesInput = node.querySelector(`input[data-action="watcher-classes"]`);
  if (classesInput) {
    classesInput.addEventListener("change", () => {
      const list = classesInput.value.split(",").map(s => s.trim()).filter(Boolean);
      if (list.length) cfg.classes = list;
    });
  }
  const actionSel = node.querySelector(`select[data-action="watcher-action"]`);
  if (actionSel) {
    actionSel.addEventListener("change", () => {
      if (ACTIONS[actionSel.value]) cfg.action = actionSel.value;
    });
  }
  node.querySelector(`[data-action="watcher-start"]`)?.addEventListener("click", () => startWatcher(entry));
  node.querySelector(`[data-action="watcher-stop"]`)?.addEventListener("click", () => stopWatcher(entry));
}

export const watcherCap = {
  name: "watcher",
  renderSection,
  wireActions,
};
