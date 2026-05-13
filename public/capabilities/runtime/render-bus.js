// Single back-channel from the runtime cap modules to the dashboard's
// renderEntry. Cap modules import { renderEntry } and call it on state
// changes; this file holds the single live binding. setRender (called
// once from runtime/index.js's setRuntimeRenderer) plumbs the dashboard's
// actual renderEntry through.

let _impl = () => {};
export function setRender(fn) { _impl = fn; }
export function renderEntry(entry) { return _impl(entry); }
