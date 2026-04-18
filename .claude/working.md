# Current working model — better-robotics

Last updated: 2026-04-18 (per-card render, wider layout, setup collapse, scout findings folded in)

## Project shape (stable — don't re-question unless new evidence)

- **BLE is the control plane** (always on, always available). Carries commands, telemetry, state, OTA triggers.
- **WiFi is the data plane** (optional, onboarded over BLE). Carries anything too big for BLE — large OTA payloads, video, cloud calls. Robots work fully without it.
- Each robot advertises a single BLE GATT service. Capabilities (LED, motors, WiFi, OTA, fw-info) are characteristics inside it. `fw-info` reports `{type, url}` so the dashboard knows where to fetch firmware from.
- Actuator characteristics (motor, future servos/pumps/relays) ship with a built-in watchdog — every write resets a timer, silence reverts to safe default. That's the answer to "what happens when the channel drops?"
- Dashboard is the brain; firmware lives on GH Pages and updates via OTA. No server in the critical path.
- Browser-only SPA. Chrome/Edge required (Web Bluetooth, File System Access API).
- **Dashboard render is per-entry.** `state.devices: Map<id, entry>`; each entry owns its DOM node via `entry.node`. `renderEntry(entry)` rebuilds one card; `render()` reconciles the list (add/remove/order). A characteristic notify for robot A never touches robot B's DOM. This is also the foundation for the future LLM-orchestrator direction — `get_robot_state(id)` and per-entry state-push map cleanly onto it.

## Pending, roughly ranked

### 1. ESP32 URL-trigger OTA still fails with http -1 on CAM-MB (partial fix shipped, awaiting validation)
- Firmware confirmed new on-device (fw-info read returns esp32/url JSON). HTTPS GET fails before data flows.
- `HTTPClient.GET()` returns -1 = `HTTPC_ERROR_CONNECTION_FAILED`. Root cause most likely **TLS handshake under memory pressure** — BLE stack + mbedTLS co-resident on ESP32-CAM.
- **Shipped mitigations:** setFollowRedirects, 20s timeout, free-heap logging in the failure message so we can confirm memory pressure next attempt.
- **Couldn't ship:** `setBufferSizes(rx, tx)` — the API went away in ESP32 Arduino 3.x (WiFiClientSecure → NetworkClientSecure).
- **BLE-stream fallback still active** — dashboard auto-retries over BLE after 8s silence, so users aren't stuck.
- **Most promising next move (from scout):** migrate BLE stack to NimBLE. Default in arduino-esp32 3.3.0+ already; materially smaller RAM footprint than Bluedroid. Likely frees the headroom mbedTLS needs for the TLS handshake to complete on CAM-MB. Pin to 3.3.8+ for the signed-OTA fix.
- **Heap logging stays** — load-bearing until the next on-device test confirms whether pressure is the cause.
- **Other next moves if NimBLE doesn't resolve it:**
  1. Run the HTTPS fetch in a dedicated FreeRTOS task (separate stack, can allocate larger buffers without stealing from BLE).
  2. Alternative: signal/WebSocket transport (different tradeoff — still TLS).
  3. Accept BLE fallback as good enough for CAM-MB (S3/C6 are recommended hardware; CAM-MB quirks may not be worth fighting indefinitely).

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

### 6. LLM-orchestrated dashboard (direction, not yet in flight)
- Direction confirmed: eventually an LLM (webmcp-style) drives pairing, driving, OTA, etc. through a tool interface. Per-card render ships today specifically to set up this future — one state change mutates one card, a `get_robot_state(id)` tool returns one entry, a state-push channel notifies by entry-id rather than whole-page snapshots.
- **Patterns worth stealing from `~/Github/organizations/hatch` when we get here:**
  1. Domain-scoped tool adapters with per-context system prompts (one adapter per "mode" — pairing, debugging, classroom demo).
  2. Tool results as JSON objects, not text. Errors too (`{error: "..."}`, not mixed strings).
  3. Two-phase inspection: `list_robots()` → `get_robot_state(id)` → targeted actions. LLM learns to drill down.
  4. Approval gates for learned tools + confidence scoring. Gate before auto-executing; refine-and-resubmit on drift.
  5. SSE state push (optional, when state changes originate outside the LLM — e.g., a watchdog firing on a robot).
- **Don't copy from hatch:** behavioral-trust ledger (overkill for single-user dashboard), multi-bridge primary/secondary election (only needed for multi-client orchestration).

## Recently landed (context for what's "done")
- **Per-card render foundation.** `entry.node` owns the card DOM; `renderEntry(entry)` scopes innerHTML rebuild to one card; `render()` handles list-level changes only. Sets up the entry-addressable state shape the future LLM-orchestrator will drive tools against.
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
