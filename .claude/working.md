# Current working model — better-robotics

Last updated: 2026-04-18 (3-plane architecture named; bundle OTA + USB recovery + xterm.js + capability config landed)

## Project shape (stable — don't re-question unless new evidence)

The architecture is **three independent planes**:

- **Control plane — BLE.** Always on. Commands, telemetry, state, ops (install, restart, inspect). The browser's pairing UI is the gatekeeper; no credentials cross the air.
- **Data plane — WiFi.** Optional, onboarded over BLE. Large OTA payloads, video streams, cloud calls. Robots work fully without it.
- **Recovery plane — USB.** Last-resort. Composite gadget (ECM ethernet + ACM serial) runs under `usb-gadget.service`, independent of pi-robot firmware. Dashboard exposes a real xterm.js terminal over the ACM endpoint — works even when BLE and WiFi are dead.

Other invariants:
- Each robot advertises a single BLE GATT service. Capabilities (LED, motors, WiFi, OTA, camera, admin) are characteristics inside it. `fw-info` reports `{type, url, caps, bundle_url}` so the dashboard picks the right data plane per-robot and picks between legacy single-file OTA vs bundle OTA automatically.
- **Capability presence is config-driven on Pi** via `/boot/firmware/pi-robot.conf`. Unwired LEDs don't show up; missing motor drivers don't show up. The dashboard renders only what's advertised.
- Actuator characteristics (motor, future servos/pumps/relays) ship with a built-in watchdog — every write resets a timer, silence reverts to safe default.
- Dashboard is the brain; firmware lives on GH Pages and updates via OTA. No server in the critical path.
- **Browser is ES-module-organized.** Capability registry (`public/capabilities/*.js`) + shared infra (`ble.js`, `state.js`, `log.js`, `settings.js`, `dom.js`) + input modules (`gamepad.js`, `voice.js`) + recovery (`recovery.js`) + prepare (`prepare.js`). `app.js` is ~490 lines of orchestration.
- **Dashboard render is per-entry.** `state.devices: Map<id, entry>`; each entry owns its DOM node via `entry.node`. `renderEntry(entry)` rebuilds one card; `render()` reconciles the list (add/remove/order). A characteristic notify for robot A never touches robot B's DOM.
- Chrome/Edge required (Web Bluetooth, Web Serial, File System Access API).

## Pending, roughly ranked

### 1. ESP32 URL-trigger OTA still fails with http -1 on CAM-MB (partial fix shipped, awaiting validation)
- Firmware confirmed new on-device (fw-info read returns esp32/url JSON). HTTPS GET fails before data flows.
- `HTTPClient.GET()` returns -1 = `HTTPC_ERROR_CONNECTION_FAILED`. Root cause most likely **TLS handshake under memory pressure** — BLE stack + mbedTLS co-resident on ESP32-CAM.
- **Shipped mitigations:** setFollowRedirects, 20s timeout, free-heap logging in the failure message so we can confirm memory pressure next attempt.
- **Couldn't ship:** `setBufferSizes(rx, tx)` — the API went away in ESP32 Arduino 3.x (WiFiClientSecure → NetworkClientSecure).
- **BLE-stream fallback still active** — dashboard auto-retries over BLE after 8s silence, so users aren't stuck.
- **Corrected NimBLE framing (verified 2026-04-18 from primary sources):** NimBLE is NOT the default on ESP32 WROOM/CAM in arduino-esp32 3.3.x — only on newer SoCs (S3/C3/C6) that lack Bluedroid support. Built-in `BLEDevice.h` stays Bluedroid-backed on WROOM/CAM; our current sketch compiles unchanged on 3.3.8. A NimBLE migration on CAM requires switching to the separate `h2zero/NimBLE-Arduino` library (include + class-name rewrite) — not a recompile. The "CAM NimBLE instability" concern from an earlier scan was unverifiable from primary sources; treat it as unknown, not blocking. ~100KB memory savings from NimBLE is still the right direction for CAM-MB's TLS pressure problem, just more work than we thought.
- **Pinned arduino-esp32 3.3.8** in Makefile + CI — 3.3.6/3.3.7 silently bypass signed-OTA verification (PR #12425).
- **Heap logging stays** — load-bearing until the next on-device test confirms whether pressure is the cause.
- **Next moves, in priority order:**
  1. **Accept BLE fallback** as the CAM-MB story (10 min vs 10 sec is a cost, not a failure). Doc it as "expected on CAM" so users don't hunt a ghost. Lowest-effort resolution.
  2. **FreeRTOS-task HTTPS fetch** — separate stack for the download, doesn't steal from BLE. Keeps Bluedroid. ~2 hr work.
  3. **NimBLE migration via `h2zero/NimBLE-Arduino`** — real code rewrite, ~100KB relief. Validate on S3/C6 first (stable NimBLE territory), then try on CAM. Half-day work plus on-device iteration.
  4. Signal/WebSocket transport — still TLS, doesn't solve the memory problem.

### 2. Would a Service Worker improve the architecture? (open question)
- **Yes for:** offline dashboard (cache static assets + firmware bins so pairing+basic use works without internet, OTA keeps working after a WiFi drop), PWA installability (Add to Home Screen for classroom/demo iPads and Android), faster repeat visits.
- **No for:** holding BLE connections across page reloads (SW can't use Web Bluetooth — only foreground page can), running robot activity in the background.
- **When it earns itself:** if the project leans into field/classroom use where flaky WiFi + many-robot demos matter. Today the dashboard works fine as a page; SW is polish, not critical path.
- **Not blocking anything.** Decide when the use case surfaces.

### 3. USB gadget mode validation
- `dtoverlay=dwc2` + `modules-load=dwc2,g_ether` + NM shared-mode `usb0` at `10.55.0.1/24` wired into `prepare.html` but never tested. User's current Pi was prepped before this was added.
- **Plan:** next card re-prep, plug USB-C to Mac, try `ssh pi@10.55.0.1`. Confirms the debug channel works before we actually need it.
- **Not a blocker.**

### 4. Signal as messaging transport (deferred, not rejected)
- Considered using `~/Github/jonasneves/signal` (Cloudflare Workers rendezvous rooms) as the data plane instead of hardcoded URLs.
- Doesn't solve the current TLS-memory bug (WSS = still TLS on ESP32).
- Adds WebSocket client lib to firmware (~50KB). Adds signal as critical-path infra.
- **Reconsider when:** streaming video, multi-robot coordination, or another feature requires browser-as-source for bulk data that doesn't fit BLE.

### 5. Scout-surfaced follow-ups (folded in 2026-04-18)
- **`bluez-peripheral` 0.2.0a5 spike.** Modern BlueZ-native peripheral lib; if it works non-root and without `--experimental`, the Pi firstrun script gets materially simpler. Worth a time-boxed trial.
- **Update `docs/hardware.md` to call out ESP32-C6** as the recommended board for new non-camera BLE-first builds. S3 is fine but C6 has native BLE 5.3 + more RAM headroom and matches the "BLE is the control plane" framing better than S3's dual-radio emphasis.
- **Treat `getDevices()` persistence fallback as load-bearing, not transitional.** Web Bluetooth's `getDevices()` has stayed flag-gated for years with no movement. The localStorage+filter-by-name path in `loadPaired()` is the primary paired-device persistence story; don't plan to retire it.

### 6. In-browser SD-card flasher (backlog, ~2 days when it earns a slot)
- Kill the last "install something" step in the user journey: Raspberry Pi Imager. Replace with a browser flow that claims the USB SD-card reader via WebUSB, issues SCSI WRITE(10) commands to stream Pi OS onto the card, verifies with SHA-256 readback, then hands off to the existing Customize-card flow.
- **Precedent, not standardized:** `balena-sdcard-web` and a couple of educational-kit vendors ship this. Official `rpi-imager` has no web version.
- **Friction caveat on macOS:** OS auto-mounts the card; user has to `diskutil unmountDisk /dev/diskN` before the browser can claim the USB interface. Doable but needs explicit guidance in the UI. ChromeOS handles this cleaner.
- **Scope:** ~1.5–2 days. Stage 1: WebUSB device claim + single-partition raw write + verify. Stage 2: progress UI + resume-on-disconnect + SHA-256 readback.
- **Worth it when:** 3+ people are setting up Pis from scratch. Until then, `open -a "Raspberry Pi Imager"` is one shell command.

### 7. LLM-orchestrated dashboard (direction, not yet in flight)
- Direction confirmed: eventually an LLM (webmcp-style) drives pairing, driving, OTA, etc. through a tool interface. Per-card render ships today specifically to set up this future — one state change mutates one card, a `get_robot_state(id)` tool returns one entry, a state-push channel notifies by entry-id rather than whole-page snapshots.
- **Patterns worth stealing from `~/Github/organizations/hatch` when we get here:**
  1. Domain-scoped tool adapters with per-context system prompts (one adapter per "mode" — pairing, debugging, classroom demo).
  2. Tool results as JSON objects, not text. Errors too (`{error: "..."}`, not mixed strings).
  3. Two-phase inspection: `list_robots()` → `get_robot_state(id)` → targeted actions. LLM learns to drill down.
  4. Approval gates for learned tools + confidence scoring. Gate before auto-executing; refine-and-resubmit on drift.
  5. SSE state push (optional, when state changes originate outside the LLM — e.g., a watchdog firing on a robot).
- **Don't copy from hatch:** behavioral-trust ledger (overkill for single-user dashboard), multi-bridge primary/secondary election (only needed for multi-client orchestration).

## Recently landed (context for what's "done")
- **Recovery plane: USB-CDC-ACM + xterm.js.** Pi runs composite USB gadget (ECM + ACM) via `usb-gadget.service` (independent of pi-robot). Dashboard has a Recovery console menu item that dynamic-loads xterm.js over a Web Serial connection to `/dev/cu.usbmodem*`. Real terminal — Ctrl+C, ANSI escapes, arrows, selection all work.
- **Bundle OTA.** Multi-file updates in one BLE transfer. Manifest at `firmware/pi_robot/ota-manifest.json` declares files + modes + post_install commands + reboot. Pi's `_apply_bundle` validates, stages to `.new` paths, atomic-renames, runs hooks, reboots. Legacy single-file OTA still works for backward compat (pi sniffs payload shape at commit). Dest-path whitelist prevents a malformed manifest from writing to arbitrary locations.
- **Install-on-demand for camera.** Admin-style BLE opcode → Pi runs apt+pip in background with progress streamed back via camera-status notify. No SSH needed for optional dep install. Uses sys.executable (venv's python) to avoid PEP 668 externally-managed Python errors.
- **Admin characteristic.** `Restart service` menu item → ADMIN_OP_RESTART opcode → Pi runs `systemctl restart pi-robot`. Soft-stuck recovery without USB or SSH.
- **Capability config on Pi.** `/boot/firmware/pi-robot.conf` declares `led_enabled`, `led_pin`, `motors_enabled`, `camera_enabled`. Firmware gates characteristic registration on config. Dashboard Customize-card flow writes the config based on checkboxes.
- **Consistent modal close behavior.** `wireDialogOutsideClick()` helper in dom.js. Every `<dialog>` closes on backdrop click (Escape is native). Popover `robot-menu` has explicit click + Escape listeners at document level.
- **Browser refactor (stages 1–3).** app.js went from 1440-line monolith to 490 lines of orchestration + capability registry + input modules. Adding a capability = one new file + one line in registry.
- **Per-card render foundation.** `entry.node` owns the card DOM; `renderEntry(entry)` scopes innerHTML rebuild to one card; `render()` handles list-level changes only.
- **Wider layout.** `main` max-width 1200px; `#robot-list` is `repeat(auto-fill, minmax(360px, 1fr))` — stacks on phone, side-by-side on laptop. Setup-grid capped at 800px so two onboarding cards don't stretch across a wide page. `h1`/`p.lede` capped at 640px for readability.
- **Collapsible setup section.** `<details id="setup-section">` with "Set up new hardware" as the `<summary>`; folded by default when robots exist, expanded when the list is empty. Session's user toggle persists (render doesn't force-reset).
- **Dashboard visual compression pass.** Log is now a three-column grid (time · name · msg) with name-dedup across bursts; system-level log lines (no robot name) span the message into the name slot; status dot moved left of the robot name; "Connected" / "Not connected" text dropped (dot + button carry it); redundant connecting/connected/disconnected log lines removed; dead `_debug_log` wifi-scan instrumentation in pi_robot.py removed; watchdog-rationale comments tightened to one sentence at each declaration; `makeEntry()` factory shared between `entryFor` and `loadPaired` hydration.
- **Vision-led README + `docs/hardware.md` split.** Tagline matches the website; board-specific FQBNs / LED pins / kext notes moved out.
- **New tagline:** "Pair any robot in a browser tab. No network, no accounts, no servers." Set on the website and GitHub About.
- **Setup section split into two top-level cards** (ESP32 / Pi), label moved outside, CTA buttons anchored to the bottom so they align across cards.
- **SSH Upload overlay** in the prepare dialog — replaces the separate "Load from file…" row with a code-block-style button in the textarea corner.
- **ESP32 advertising resumes on disconnect** — no more reboot-to-re-pair; matches the Pi's BlueZ behavior.
- **Dashboard split into html/css/js; prepare.html folded into a `<dialog>` inside index.html.** styles.css and app.js linked; IIFE-scoped prepare logic shares helpers. `?prepare` URL param auto-opens the dialog.
- Per-card "last activity" footer; log lines prefixed with robot name.
- Motors with watchdog (both platforms)
- Multi-robot simultaneous BLE connections
- Per-robot top-level cards (each robot is its own `<section class="card">`)
- URL-trigger OTA + BLE-stream fallback
- OTA commit deferred restart (fixes the "GATT operation failed" false negative after successful flash)
- Log messages prefixed with robot name + per-card last-activity line
- Platform APIs adopted: Wake Lock during OTA, Bluetooth availability detection, Forget repairs Chrome's paired-list via `getDevices()`
- CI builds firmware on `firmware/**` push and commits artifacts back
- README architecture rewrite: control/data channels named, watchdog as a convention, ESP32-S3 recommended for new builds
- CLI `make sd-prep` / `prepare-sd.py` removed — browser `prepare.html` is the only blessed path

## Known gotchas — don't re-learn these
- Pi OS Trixie = Python 3.13 (Bookworm = 3.11). Stage wheels for the running version.
- Pi OS Trixie ships Bluetooth **soft-blocked** by rfkill. `bluetoothctl power on` silently fails until `rfkill unblock bluetooth` runs. This was a multi-cycle debug.
- `bless` requires BlueZ `--experimental` flag *and* `Experimental=true` in `/etc/bluetooth/main.conf`. Both — different BlueZ versions honor different paths.
- `bless` on Pi OS must run as root. Non-root DBus policy is brittle across BlueZ versions.
- `bless` Linux dep chain: `bless` needs `dbus-next` (not `dbus-fast`); `bleak` needs `dbus-fast` + `typing-extensions` (Python<3.12). pip's resolver cross-platform picks the wrong variants.
- `files.pythonhosted.org` has no CORS headers. Wheels must be hosted same-origin as the dashboard.
- ESP32 BLE default `numHandles` is 15. Current service needs ~22. Excess characteristics are silently dropped at registration — devices appear to advertise only the first N.
- `ESP.restart()` inside a BLE `onWrite` callback eats the ATT response. Defer via a flag polled in `loop()`.
- Web Bluetooth serializes writes per-characteristic. Fast slider events cause "GATT operation already in progress." Use drop-intermediate-values: always queue the latest wanted value, send after in-flight write completes.

## Conventions (active rules)
- **Reframe at stable checkpoints** (cross-project, lives in `~/.claude/CLAUDE.md`) — after a thing works, ask if the shape itself was right rather than micro-optimizing what shipped.
- Actuator characteristics ship with a watchdog; don't layer safety above the capability.
- BLE writes with sha256 integrity means `setInsecure()` on the ESP32 HTTPClient is OK — integrity is cryptographically verified before commit.
- Commit messages name what the project has now, not the diff.
- No hardcoded trust in external infrastructure in the critical path. WiFi/signal/etc. are optional data planes; BLE always works.
