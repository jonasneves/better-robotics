// Ops-response dispatch registry — shared by every module that awaits a reply
// to a signed-pair ops verb (get-log, get-config, etc). Lives in its own leaf
// module so callers (app.js's connect flow, pip-tools.js's one-shot waiters)
// don't need to import each other and end up in a circular dep. Multiple
// handlers per op so persistent subscribers (pinout) and transient ones
// (pip-tools) coexist; onOpsResponse returns an unregister fn.
const _handlers = {};  // op → Array<fn>

export function onOpsResponse(op, fn) {
  (_handlers[op] ||= []).push(fn);
  return () => {
    const arr = _handlers[op] || [];
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  };
}

export function dispatchOpsResponse(entry, msg) {
  for (const fn of _handlers[msg.op] || []) {
    try { fn(entry, msg); } catch {}
  }
}
