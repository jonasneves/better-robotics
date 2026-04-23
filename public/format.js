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
export function summarizeTool(name, input, result, error) {
  const lbl = labelTool(name);
  if (error) return `${lbl} · ${shorten(error, 80)}`;
  const r = result || {};
  if (name === "move_motor" || name === "pulse_motor") {
    const a = r.applied || input || {};
    return `${lbl} · L${a.l ?? a.left ?? "?"} R${a.r ?? a.right ?? "?"} · ${a.duration_ms ?? "?"}ms`;
  }
  if (name === "get_robot_scene" || name === "ask_robot_scene" || name === "get_robot_scene_now") {
    return `${lbl} · "${shorten(r.scene || r.text || "", 80)}"`;
  }
  if (name === "ask_human") {
    const via = r.via ? ` (via ${r.via})` : "";
    return `${lbl}${via} · "${shorten(r.answer || "(no answer)", 60)}"`;
  }
  if (name === "start_live_scene" || name === "stop_live_scene") {
    return `${lbl} · ${input?.id || "?"}${r.already_watching ? " (already on)" : ""}`;
  }
  if (name === "list_robots") {
    return `${lbl} · ${(r.robots || []).map(x => x.name).join(", ") || "(none)"}`;
  }
  if (name === "get_robot_state") return `${lbl} · ${r.name || "?"}`;
  if (name === "get_log") {
    return `${lbl} · ${shorten((r.text || "").trim().split("\n").pop() || "(empty)", 80)}`;
  }
  return `${lbl} · ${shorten(JSON.stringify(r), 80)}`;
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

// "reset: panic" — only for ABNORMAL reasons. poweron / sw / ext are normal
// and noisy; suppressing them is part of the smart-safety / signal-to-noise
// discipline (don't surface routine info that competes with real signals).
export function formatResetReason(reason) {
  if (!reason) return null;
  if (reason === "poweron" || reason === "sw" || reason === "ext") return null;
  return `reset: ${reason}`;
}
