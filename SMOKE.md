# Smoke checklist

Manual verification before merging structural changes (UI redesign, render-pattern shifts, capability refactors, BLE protocol tweaks). These are the architectural promises.

If a row breaks, user-visible value broke. Don't ship.

Pure-function tests live in `tests/`; run with `make smoke`. Below needs hardware.

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
- [ ] **Motors — human joypad:** drag drives the robot; releasing → watchdog stops within 500 ms.
- [ ] **Motors — pulse-bounded LLM path:** Pip-issued motor command with `duration_ms` stops at end of window without a separate stop call (firmware auto-stop). Control-loop invariant; regression means planner-layer code can leave the robot moving between decisions.
- [ ] **Phone Stop button:** from a paired phone, tapping Stop relays through the desktop's BLE session and halts a moving robot. With no robot connected, button surfaces "no robot connected" inline. Safety primitive must be legible, no silent no-op.
- [ ] **WiFi** Scan returns networks (or empty if none); Join succeeds → status shows "WiFi <ip>" in meta.
- [ ] **Camera (ESP32)** renders when WiFi joined. Per-camera transport toggle (WebRTC ↔ HTTP MJPEG) switches the live view without page reload; both transports paint frames.
- [ ] **Camera (Pi)** WebRTC stream comes up once `pi-robot-rtc.service` is healthy; ICE survives Pi reboot.
- [ ] **Snapshot** completes in <5 s; stalls trigger watchdog with retry.
- [ ] **OTA** progress smoothly reports per chunk; "100% receiving → committing → done" transitions visible.
- [ ] **OTA orphan** state cleared on next connect (no stuck "1% receiving" forever).

## Pip chat

- [ ] Send a prompt → trace appears live (one row per tool call).
- [ ] Stop button visible while iterating; click → loop ends with "(stopped)".
- [ ] At iteration limit → Continue / Stop buttons appear inline.
- [ ] `ask_human` when no phone paired → renders option buttons in chat bubble; click resolves.
- [ ] Notify ≠ chat: opening multiple dialogs in sequence shows latest tip in notify slot, not stacked turns.
- [ ] Prior turns auto-collapse on new prompt; click summary re-expands with full trace.
- [ ] Conversation context sent to the LLM is bounded (HISTORY_LIMIT in `assistant.js`) — the planner doesn't see unbounded history.

## Recovery

- [ ] Pi serial console: Pi powered + plugged → Serial console → Pi mode → Connect → bash prompt appears.
- [ ] ESP32 serial console: Serial console → ESP32 mode → Connect → boot log + serial output streams.
- [ ] ESP32 flash: Serial console → ESP32 mode → Flash firmware → bins stream, chip reboots.
- [ ] Heartbeat-only mode: `systemctl stop pi-robot.service` → dashboard shows firmware-down banner with IP + recovery button.

## Offline / PWA

- [ ] First load online → DevTools Network → Offline → reload → dashboard still loads.
- [ ] Bump `VERSION` in public/sw.js → deploy → visit → "New dashboard version available" banner appears.
- [ ] Click Reload on the banner → page reloads with new version, no stale assets.
- [ ] Dismiss banner with × → no reload, banner gone for the session.

## Scripts

- [ ] Open Scripts → load each template → Run executes.
- [ ] `pip.ask` template fires Claude call → returns text.
- [ ] Stop button on a long-running script kills it (browser tab ↻ if needed).

