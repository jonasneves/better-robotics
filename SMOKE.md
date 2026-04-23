# Smoke checklist

Manual verification before merging structural changes (UI redesign, render
pattern shifts, capability refactors, BLE protocol tweaks). Not exhaustive
unit testing — these are the architectural promises the project makes.

If a row breaks, the project's user-visible value broke. Don't ship.

Pure-function tests live in `tests/`; run with `make smoke`. They cover the
parts that don't need a robot. Everything below needs hardware.

## Robot lifecycle

- [ ] Pair a fresh ESP32 → Connect → see capabilities → Disconnect cycle works.
- [ ] Robot reboots mid-session → reconnect succeeds OR button flips to Re-pair (not "Connect that does nothing").
- [ ] BLE drops out-of-range → status reads "Out of range" → button still says Connect → ranging in re-establishes.
- [ ] Two robots paired → connect-all works → both render independently.
- [ ] Pair → Forget → robot disappears → Pair again succeeds.

## Dashboard rendering

- [ ] Robot card renders with no console errors after 30 s of telemetry/robot-status updates (no flash on every notify).
- [ ] Cap headers show state inline ("L: 0 · R: 0", "off", "Not configured").
- [ ] Primary action visible without expanding (Turn on / Stop / Take photo / Scan).
- [ ] Chevron only appears on caps with body content (not on LED, not on Snapshot when no image).
- [ ] Card stripe color matches connection state (green/connected, amber/connecting, red/error, amber/firmware-down).
- [ ] Meta row truncates with ellipsis on long content; CTA stays right-aligned.

## Capabilities

- [ ] **LED** toggle from header without expanding → state updates without card flash.
- [ ] **Motors** joypad drives the robot; releasing → watchdog stops within 500 ms.
- [ ] **WiFi** Scan returns networks (or empty if none); Join succeeds → status shows "WiFi <ip>" in meta.
- [ ] **Camera (ESP32, MJPEG)** renders when WiFi joined; profile dropdown changes profile + restarts robot.
- [ ] **Snapshot** completes in <5 s on standard profile; stalls trigger watchdog with retry.
- [ ] **OTA** progress smoothly reports per chunk; "100% receiving → committing → done" transitions visible.
- [ ] **OTA orphan** state cleared on next connect (no stuck "1% receiving" forever).

## Pip chat

- [ ] Send a prompt → trace appears live (one row per tool call).
- [ ] Stop button visible while iterating; click → loop ends with "(stopped)".
- [ ] At iteration limit → Continue / Stop buttons appear inline.
- [ ] `ask_human` when no phone paired → renders option buttons in chat bubble; click resolves.
- [ ] Notify ≠ chat: opening multiple dialogs in sequence shows latest tip in notify slot, not stacked turns.
- [ ] Prior turns auto-collapse on new prompt; click summary re-expands with full trace.
- [ ] Bubble caps at MAX_CHAT_TURNS (5) — older turns drop from DOM.

## Recovery

- [ ] USB-C recovery console: Pi powered + plugged → Connect → bash prompt appears.
- [ ] ESP32 serial monitor: Connect → boot log + serial output streams.
- [ ] Heartbeat-only mode: `systemctl stop pi-robot.service` → dashboard shows firmware-down banner with IP + recovery button.

## Scripts

- [ ] Open Scripts → load each template → Run executes.
- [ ] `pip.ask` template fires Claude call → returns text.
- [ ] Stop button on a long-running script kills it (browser tab ↻ if needed).

---

When this list passes end-to-end, the project's stated value is intact.
When a row fails, that row IS the regression — fix and re-verify before
merging.
