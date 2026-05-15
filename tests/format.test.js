// Smoke tests for pure formatters. `make smoke` (node --test). Anything
// that needs DOM, fetch, BLE, or browser APIs lives in SMOKE.md.
//
// New formatters in public/format.js earn a test row. Catching
// architectural drift, not coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shorten, labelTool, summarizeTool,
  formatUptime, formatWifi, formatWifiShort, formatResetReason,
  formatRssi, rssiSeverity, tempSeverity,
} from "../public/format.js";

test("shorten: leaves short strings alone", () => {
  assert.equal(shorten("hi", 10), "hi");
  assert.equal(shorten("", 10), "");
  assert.equal(shorten(null, 10), "");
});

test("shorten: truncates with ellipsis at the boundary", () => {
  assert.equal(shorten("hello world", 5), "hell…");
  assert.equal(shorten("exactly", 7), "exactly");
});

test("labelTool: strips common prefixes and snake-case", () => {
  assert.equal(labelTool("get_log"), "log");
  assert.equal(labelTool("ask_human_via_phone"), "human via phone");
  assert.equal(labelTool("set_camera_profile"), "camera profile");
  assert.equal(labelTool("move_motor"), "move motor");  // no prefix to strip
  assert.equal(labelTool(""), "");
});

test("summarizeTool: error wins over result", () => {
  const out = summarizeTool("get_log", {}, { text: "..." }, "timeout");
  assert.match(out, /timeout/);
});

test("summarizeTool: move_motor picks applied over input", () => {
  const out = summarizeTool("move_motor",
    { l: 100, r: 100, duration_ms: 5000 },
    { applied: { l: 40, r: 40, duration_ms: 2000 } },
    null);
  // Firmware clamps; the trace should reflect what actually went out.
  assert.match(out, /L40 R40 · 2000ms/);
});

test("summarizeTool: scene truncates", () => {
  const long = "a".repeat(200);
  const out = summarizeTool("get_robot_scene", {}, { scene: long }, null);
  assert.ok(out.length < 120, `expected truncation, got ${out.length} chars`);
});

test("summarizeTool: ask_human surfaces transport", () => {
  const out = summarizeTool("ask_human", {}, { answer: "Forward", via: "chat" }, null);
  assert.match(out, /\(via chat\)/);
  assert.match(out, /"Forward"/);
});

test("summarizeTool: unknown tool falls back to truncated JSON", () => {
  const out = summarizeTool("future_thing", {}, { ok: true, foo: "bar" }, null);
  assert.match(out, /future thing/);
  assert.match(out, /ok/);
});

test("summarizeTool: durationMs renders as paren suffix in ms or s", () => {
  // Sub-10s reads in ms, integer rounded.
  const fast = summarizeTool("get_log", {}, { text: "ok" }, null, 47.6);
  assert.match(fast, / \(48ms\)$/);
  // 10s+ switches to one-decimal seconds.
  const slow = summarizeTool("ask_human", {}, { answer: "Forward", via: "chat" }, null, 28412);
  assert.match(slow, / \(28\.4s\)$/);
  // Errors carry the duration too — useful when a slow timeout hides as a fast-looking failure.
  const err = summarizeTool("get_log", {}, null, "timeout", 5000);
  assert.match(err, / \(5000ms\)$/);
});

test("summarizeTool: omitting durationMs leaves no annotation", () => {
  const out = summarizeTool("get_log", {}, { text: "ok" }, null);
  assert.doesNotMatch(out, /\(\d/);
});

test("formatUptime: prefers seconds, falls back to ms", () => {
  assert.equal(formatUptime({ uptime_s: 30 }), "up 30s");
  assert.equal(formatUptime({ uptime_s: 90 }), "up 1m");
  assert.equal(formatUptime({ uptime_s: 7330 }), "up 2h 2m");
  assert.equal(formatUptime({ uptime_s: 90000 }), "up 1d");
  assert.equal(formatUptime({ uptime_ms: 30000 }), "up 30s");
  assert.equal(formatUptime(null), null);
  assert.equal(formatUptime({}), null);
});

test("formatWifi: state machine maps cleanly to display strings", () => {
  assert.equal(formatWifi({ st: "joined", ip: "10.0.0.5" }), "WiFi 10.0.0.5");
  assert.equal(formatWifi({ st: "joined", ssid: "Foo" }), "WiFi Foo");
  assert.equal(formatWifi({ st: "joining" }), "WiFi joining…");
  assert.equal(formatWifi({ st: "scanning" }), "WiFi scanning");
  assert.equal(formatWifi({ st: "failed" }), "WiFi failed");
  assert.equal(formatWifi({ st: "idle" }), null);
  assert.equal(formatWifi(null), null);
});

test("formatResetReason: suppresses routine reasons, surfaces abnormal", () => {
  assert.equal(formatResetReason("poweron"), null);
  assert.equal(formatResetReason("sw"), null);
  assert.equal(formatResetReason("ext"), null);
  assert.equal(formatResetReason("panic"), "reset: panic");
  assert.equal(formatResetReason("task-wdt"), "reset: task-wdt");
  assert.equal(formatResetReason("brownout"), "reset: brownout");
  assert.equal(formatResetReason(null), null);
  assert.equal(formatResetReason(""), null);
});

test("formatWifiShort: drops IP for tight primary-row use", () => {
  assert.equal(formatWifiShort({ st: "joined", ip: "10.0.0.5" }), "WiFi");
  assert.equal(formatWifiShort({ st: "joining" }), "WiFi joining…");
  assert.equal(formatWifiShort({ st: "failed" }), "WiFi failed");
  assert.equal(formatWifiShort({ st: "idle" }), null);
  assert.equal(formatWifiShort(null), null);
});

test("formatRssi: dBm or null", () => {
  assert.equal(formatRssi(-52), "-52 dBm");
  assert.equal(formatRssi(-90), "-90 dBm");
  assert.equal(formatRssi(null), null);
  assert.equal(formatRssi(undefined), null);
});

test("rssiSeverity: thresholds match the primary-row warning policy", () => {
  assert.equal(rssiSeverity(-40), null);     // strong
  assert.equal(rssiSeverity(-70), null);     // healthy
  assert.equal(rssiSeverity(-75), "weak");   // boundary
  assert.equal(rssiSeverity(-80), "weak");
  assert.equal(rssiSeverity(-85), "bad");    // boundary
  assert.equal(rssiSeverity(-95), "bad");
  assert.equal(rssiSeverity(null), null);
});

test("tempSeverity: Pi SoC thresholds", () => {
  assert.equal(tempSeverity(40), null);
  assert.equal(tempSeverity(64.9), null);
  assert.equal(tempSeverity(65), "warm");
  assert.equal(tempSeverity(75), "warm");
  assert.equal(tempSeverity(80), "bad");
  assert.equal(tempSeverity(null), null);
});
