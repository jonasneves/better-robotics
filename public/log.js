// Log is a three-column grid (time · name · msg). Name is suppressed on older
// lines in a burst from the same robot so a stream of events reads as one
// group with a single anchor. Adjacent-duplicate coalescing rewrites the
// newest line with a (xN) counter instead of stacking.
import { $ } from "./dom.js";

let _lastLogNode = null;
let _lastLogMsgNode = null;
let _lastLogNameNode = null;
let _lastLogKey = null;
let _lastLogName = null;
let _lastLogCount = 0;

const _errRe = /\b(fail(?:ed|ure)?|error|rejected|timeout|cancelled|stalled|stuck|not found)\b/i;
const _okRe  = /\b(paired|joined|installed|done|ready|enabled|ok)\b/i;
const _logClass = (msg) => _errRe.test(msg) ? "err" : _okRe.test(msg) ? "ok" : "";

export const log = (msg, name = "") => {
  const el = $("log");
  const now = new Date().toLocaleTimeString();
  const key = `${name}|${msg}`;
  if (key === _lastLogKey && _lastLogMsgNode) {
    _lastLogCount++;
    _lastLogMsgNode.textContent = `${msg} (×${_lastLogCount})`;
    return;
  }
  _lastLogKey = key;
  _lastLogCount = 1;
  const line = document.createElement("div");
  const cls = _logClass(msg);
  if (cls) line.className = cls;
  if (!name) line.classList.add("sys");
  const timeSpan = document.createElement("span");
  timeSpan.className = "log-time";
  timeSpan.textContent = now;
  const nameSpan = document.createElement("span");
  nameSpan.className = "log-name";
  nameSpan.textContent = name;
  const msgSpan = document.createElement("span");
  msgSpan.className = "log-msg";
  msgSpan.textContent = msg;
  line.append(timeSpan, nameSpan, msgSpan);
  el.prepend(line);
  // Suppress the previous line's name when this burst continues from it —
  // anchor name stays on the newest line, older siblings go anonymous.
  if (name && name === _lastLogName && _lastLogNameNode) {
    _lastLogNameNode.classList.add("dup");
  }
  _lastLogNode = line;
  _lastLogMsgNode = msgSpan;
  _lastLogNameNode = nameSpan;
  _lastLogName = name;
};

// Robot-scoped logging. Stores the message as the entry's last-activity line
// so each card shows its most recent event inline without scrolling the global
// log. Note: the render() re-trigger is injected by the caller (see render.js)
// to avoid log.js depending on render.js.
let _renderEntry = () => {};
export function setLogRenderer(fn) { _renderEntry = fn; }

export const logFor = (entry, msg) => {
  log(msg, entry.name);
  if (entry.lastEvent !== msg) {
    entry.lastEvent = msg;
    _renderEntry(entry);
  }
};
