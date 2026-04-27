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

// Unread-error pip on the collapsed tray. Yielding lens: the log stays out of
// the way when quiet, but has to step forward when errors land while closed,
// otherwise "collapsed" silently hides failures from the operator.
let _trayWired = false;
let _trayHasAlert = false;
function _getTray() {
  const el = $("log");
  return el && el.closest("details.tray");
}
function _wireTrayOnce(tray) {
  if (_trayWired || !tray) return;
  _trayWired = true;
  tray.addEventListener("toggle", () => {
    if (tray.open && _trayHasAlert) {
      _trayHasAlert = false;
      tray.classList.remove("has-alert");
    }
  });
}
function _flagTrayAlert() {
  const tray = _getTray();
  if (!tray) return;
  _wireTrayOnce(tray);
  if (tray.open || _trayHasAlert) return;
  _trayHasAlert = true;
  tray.classList.add("has-alert");
}

// Split on the last hyphen so "BetterRobot-" dims and the identifying suffix
// ("E9D4") keeps the weight — and the column truncates the prefix first under
// width pressure rather than the part that actually identifies the robot.
function buildNameSpan(name) {
  const outer = document.createElement("span");
  outer.className = "log-name";
  outer.title = name;  // hover-tooltip safety net for long custom names
  const dash = name.lastIndexOf("-");
  const hasSplit = dash > 0 && dash < name.length - 1;
  if (hasSplit) {
    const prefix = document.createElement("span");
    prefix.className = "log-name-prefix";
    prefix.textContent = name.slice(0, dash + 1);
    outer.appendChild(prefix);
  }
  const suffix = document.createElement("span");
  suffix.className = "log-name-suffix";
  suffix.textContent = hasSplit ? name.slice(dash + 1) : name;
  outer.appendChild(suffix);
  return outer;
}

export const log = (msg, name = "") => {
  const el = $("log");
  // Tray is hidden until the first log line lands — keeps the empty state
  // truly empty. Any subsequent log() calls find it already visible.
  const tray = $("log-tray");
  if (tray && tray.hidden) tray.hidden = false;
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
  if (cls === "err") _flagTrayAlert();
  if (!name) line.classList.add("sys");
  const timeSpan = document.createElement("span");
  timeSpan.className = "log-time";
  timeSpan.textContent = now;
  const nameSpan = buildNameSpan(name);
  const msgSpan = document.createElement("span");
  msgSpan.className = "log-msg";
  msgSpan.textContent = msg;
  line.append(timeSpan, nameSpan, msgSpan);
  el.prepend(line);
  // Burst continuation: anchor name on newest line, older siblings go anonymous.
  if (name && name === _lastLogName && _lastLogNameNode) {
    _lastLogNameNode.classList.add("dup");
  }
  _lastLogNode = line;
  _lastLogMsgNode = msgSpan;
  _lastLogNameNode = nameSpan;
  _lastLogName = name;
};

export const logFor = (entry, msg) => log(msg, entry.name);
