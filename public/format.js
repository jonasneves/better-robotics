// Pure formatters — no DOM, no BLE. Importable in Node (`node --test`) so
// the parts that don't need hardware can be smoke-tested cheaply. Anything
// that touches `document` or `navigator` doesn't belong here.

// "BetterRobot-XXXX · 5 actions · partial reply…" — anything with hard
// invariants gets a test in tests/format.test.js.
export function shorten(s, n) {
  s = String(s ?? "");
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// "led" → "led", "get_log" → "get log", "ask_human_via_phone" → "human via phone"
// (strips one common prefix; intentionally one-pass, not greedy).
export function labelTool(name) {
  return String(name || "").replace(/^(get_|set_|do_|ask_)/, "").replace(/_/g, " ");
}

// Scene/uptime/etc. Best-effort one-line summary per tool name; falls back
// to truncated JSON for unknown tools. Result/error shape is what the
// pip-tools dispatcher returns. Used by the Pip chat trace renderer.
//
// durationMs is wall-clock for the call (BLE/WebRTC roundtrip + executor
// work). Distinct from any duration_ms inside results (e.g. move_motor's
// firmware-applied pulse length). Suffix in parens so the two read as
// annotation, not as another result field.
export function summarizeTool(name, input, result, error, durationMs) {
  const lbl = labelTool(name);
  const dur = durationMs == null ? "" : ` (${formatCallDur(durationMs)})`;
  if (error) return `${lbl} · ${shorten(error, 80)}${dur}`;
  const r = result || {};
  if (name === "move_motor") {
    const a = r.applied || input || {};
    return `${lbl} · L${a.l ?? a.left ?? "?"} R${a.r ?? a.right ?? "?"} · ${a.duration_ms ?? "?"}ms${dur}`;
  }
  if (name === "get_robot_scene" || name === "ask_robot_scene") {
    return `${lbl} · "${shorten(r.scene || r.text || "", 80)}"${dur}`;
  }
  if (name === "ask_human") {
    const via = r.via ? ` (via ${r.via})` : "";
    return `${lbl}${via} · "${shorten(r.answer || "(no answer)", 60)}"${dur}`;
  }
  if (name === "start_live_scene" || name === "stop_live_scene") {
    return `${lbl} · ${input?.id || "?"}${r.already_watching ? " (already on)" : ""}${dur}`;
  }
  if (name === "list_robots") {
    return `${lbl} · ${(r.robots || []).map(x => x.name).join(", ") || "(none)"}${dur}`;
  }
  if (name === "get_robot_state") return `${lbl} · ${r.name || "?"}${dur}`;
  if (name === "get_log") {
    return `${lbl} · ${shorten((r.text || "").trim().split("\n").pop() || "(empty)", 80)}${dur}`;
  }
  return `${lbl} · ${shorten(JSON.stringify(r), 80)}${dur}`;
}

// Sub-10s in ms for resolution; 10s+ in 0.1s steps so a 28-second
// ask_human_via_phone reads as "28.4s" not "28412ms".
function formatCallDur(ms) {
  return ms < 10000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Compact uptime: "up 42s" / "up 5m" / "up 2h 13m" / "up 3d". Both Pi (s)
// and ESP32 (ms) supply uptime in their telemetry; pick whichever is set.
export function formatUptime(telemetry) {
  if (!telemetry) return null;
  const s = typeof telemetry.uptime_s === "number" ? telemetry.uptime_s
          : typeof telemetry.uptime_ms === "number" ? Math.floor(telemetry.uptime_ms / 1000)
          : null;
  if (s == null) return null;
  if (s < 60) return `up ${s}s`;
  if (s < 3600) return `up ${Math.floor(s / 60)}m`;
  if (s < 86400) return `up ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `up ${Math.floor(s / 86400)}d`;
}

// "WiFi 192.168.1.42" / "WiFi joining…" / null when nothing useful to show.
// Status shape matches pi_robot.py's wifi-status JSON ({st, ssid, ip}).
export function formatWifi(wifiStatus) {
  const w = wifiStatus;
  if (!w) return null;
  if (w.st === "joined") return `WiFi ${w.ip || w.ssid || "joined"}`;
  if (w.st === "joining") return "WiFi joining…";
  if (w.st === "scanning") return "WiFi scanning";
  if (w.st === "failed")   return "WiFi failed";
  return null;  // idle / unknown — caller renders nothing
}

// Terser WiFi for the primary row, where width is precious — drops the IP
// (which lives in the system line / WiFi section). "WiFi" / "WiFi joining…" /
// "WiFi failed". Stays null for idle so an offline robot's row doesn't carry
// an empty label.
export function formatWifiShort(wifiStatus) {
  const w = wifiStatus;
  if (!w) return null;
  if (w.st === "joined") return "WiFi";
  if (w.st === "joining") return "WiFi joining…";
  if (w.st === "scanning") return "WiFi scanning";
  if (w.st === "failed")   return "WiFi failed";
  return null;
}

// "-52 dBm" or null. Negative dBm — closer to zero is stronger. Caller
// decides what to do with weak values; this formatter is just rendering.
export function formatRssi(rssi) {
  if (typeof rssi !== "number") return null;
  return `${rssi} dBm`;
}

// dBm thresholds for the warning chip on the primary row. -75 is "noticeably
// weak"; below that, range is the explanation for flaky behavior so we want
// the user to see it at a glance. Above, the link is healthy enough to stay
// invisible.
export function rssiSeverity(rssi) {
  if (typeof rssi !== "number") return null;
  if (rssi <= -85) return "bad";
  if (rssi <= -75) return "weak";
  return null;
}

// Pi SoC thermal warning. Pi 4/5 throttle at ~80°C; surfacing at 65°C lets
// the user notice before throttling kicks in. Below this, the value lives
// in the system line and not on the primary row.
export function tempSeverity(c) {
  if (typeof c !== "number") return null;
  if (c >= 80) return "bad";
  if (c >= 65) return "warm";
  return null;
}

// "reset: panic" — only for ABNORMAL reasons. poweron / sw / ext are normal
// and noisy; suppressing them is part of the smart-safety / signal-to-noise
// discipline (don't surface routine info that competes with real signals).
export function formatResetReason(reason) {
  if (!reason) return null;
  if (reason === "poweron" || reason === "sw" || reason === "ext") return null;
  return `reset: ${reason}`;
}
