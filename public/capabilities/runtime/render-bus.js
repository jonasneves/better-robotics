// Single back-channel from the runtime cap modules to the dashboard's
// renderEntry. Replaces the 7-fold `let renderEntry = () => {}; export
// function setRender(fn) { renderEntry = fn; }` boilerplate that used to
// live in every cap module — the indirection was identical across all of
// them, fanned out through runtime/index.js.
//
// Cap modules import { renderEntry } and call it on state changes; this
// file holds the single live binding. setRender (called once from
// runtime/index.js's setRuntimeRenderer) plumbs the dashboard's actual
// renderEntry through.

let _impl = () => {};
export function setRender(fn) { _impl = fn; }
export function renderEntry(entry) { return _impl(entry); }
