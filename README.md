# Better Robotics

**Pair any robot in a browser tab. No network, no accounts, no servers.**

A BLE-first robotics kit for ESP32 and Raspberry Pi. Turn on a robot, open a Chrome tab, see it appear. No WiFi credentials to hand out, no configuration files to copy, no backend to run. The laptop is the brain; the robot is a set of typed capabilities over BLE. Multi-robot works out of the box.

## Why BLE-first

Classroom and demo environments rarely give you a joinable WiFi network. The ones that do usually block multicast (so mDNS fails), require captive-portal logins (so ESP32s can't join), or have client isolation (so peers can't see each other). Every WiFi-first onboarding story collapses in a real classroom.

BLE avoids the problem entirely:

- Robot advertises the moment it boots — no network to join.
- Laptop scans and sees every robot in the room.
- Multi-robot discovery is just multi-scan.
- Laptop's own WiFi stays connected (for internet, AI APIs).
- Zero credentials, ever.

## Architecture

Three planes, each independent, each doing what it's best at:

- **Control plane — BLE.** Always on. Commands, telemetry, state changes, ops (install deps, restart service, inspect logs). Low bandwidth (~1–3 Mbps) but reliable and network-free. The browser's pairing UI is the gatekeeper; no credentials cross the air.
- **Data plane — WiFi, optional.** Onboarded via BLE when a robot needs it. Large OTA payloads, video streams, cloud ML. Robots work fully without it.
- **Recovery plane — USB, last-resort.** The Pi exposes a composite USB gadget (ECM ethernet + ACM serial) over its USB-C port. Works when both BLE and WiFi are dead or the firmware is crashing, because the gadget runs under its own systemd unit independent of the robot firmware. The dashboard exposes a real xterm.js terminal over this channel (no SSH client needed).

```
┌──────────────────┐         BLE GATT (always on)          ┌──────────────────┐
│  Chrome browser  │ ◄────────────────────────────────────► │  Robot firmware  │
│  (Web Bluetooth) │   commands · state · ops · triggers    │  (ESP32 or Pi)   │
└──────────────────┘                                        └──────────────────┘
          ▲                                                           ▲
          ├─────────── WiFi (data plane, optional) ────────────────── ┤
          │         large OTA · video · cloud calls                   │
          │                                                           │
          └─────── USB-C (recovery plane, last-resort, Pi only) ───── ┘
                    ECM ethernet · ACM serial console
```

Each robot advertises a single BLE GATT service. Capabilities (LED, motors, WiFi, OTA, camera, admin) are characteristics inside it. Adding a capability means adding a characteristic — not a new protocol. A `fw-info` characteristic reports the robot's type and where to fetch updates, so the dashboard routes firmware through BLE or WiFi per-robot automatically. Capability presence is configurable per-robot via `/boot/firmware/pi-robot.conf` on Pi — unwired LEDs don't show up as dashboard controls.

**Safety on disconnect.** Actuator characteristics (motor, servo, pump, relay — anything mechanical) ship with a watchdog built into the firmware. Every write resets a timer; if no write lands within the window, the firmware reverts to a safe default on its own. The architecture's answer to "what if the operator walks away?" — silence itself is the trigger for the safe state, not a redundant radio.

**No server, no broker, no cloud in the critical path.** The browser pairs directly with the robot over BLE. WiFi, when present, is used only for content fetched from the same GitHub Pages deploy that serves the dashboard itself.

**The brain lives in the browser.** The robot exposes typed primitives (move, sense, observe); the dashboard orchestrates them. This is true for the LLM-driven path (Pip — Claude as tool-using planner, with an in-browser SmolVLM for scene captions and OWLv2 for spatial bounding boxes) and equally true for user-authored code — the Scripts panel is a JS editor with a `robot` API that maps to BLE capabilities. No "upload code to the Pi" step. The same control-loop invariants apply: user scripts and Pip are both planners, and the firmware's safety floor (motor watchdog, pulse caps) bounds them identically. See [USER-CODE.md](USER-CODE.md).

## What it isn't

Loud scope walls — match new ideas against these before extending:

- **Not autonomous.** The human is always one `ask_human` away by design. Confidence-based handoff is core policy, not an escape hatch.
- **Not real-time.** Decision loop is seconds, not milliseconds. Reactive control is impossible at this latency; pulse-bounded motion is how we live with that — every LLM motor command carries a `duration_ms` and the firmware auto-stops at the end.
- **Not spatially aware.** Monocular camera + VLM text + bbox detector — no depth, no SLAM, no metric maps. Navigation is semantic, not geometric.
- **Not a code-deploy target.** User code runs in the browser, not on the Pi. No CI push, no sync server, no `scp`. See [USER-CODE.md](USER-CODE.md).
- **Not a remote-shell host over BLE/WiFi.** The dashboard's USB-C recovery xterm is the only shell surface, bounded by physical access. BLE/WiFi debug goes through typed ops verbs (`get-log`, `get-config`, `restart-service`, …).
- **Not a fleet manager.** One operator, one robot at a time. Multi-robot lists render for completeness; workflow assumes single-target focus.
- **Not a primary-online product.** Works on cafe wifi, after API outages, with no network at all (offline shell + local LFM fallback once installed). Cloud is augmentation.

## Quickstart

### Using the project (no install)

1. Open [neevs.io/better-robotics](https://neevs.io/better-robotics/) in Chrome or Edge.
2. Flash or prepare hardware:
   - **ESP32 on USB:** click **Flash firmware** — bins come from GitHub Pages, no local toolchain.
   - **Pi 4 with a flashed SD card:** click **Customize card** (or hit the URL with `?prepare`) and point it at the mounted boot partition.
3. Click **Scan for new**, pair a robot, toggle LED, onboard WiFi, drive motors. Future updates go over BLE via **Update firmware**.

### Editing firmware (contributors)

```bash
make setup          # one-time — arduino-cli + ESP32 core (macOS)
make flash          # compile local source, upload over USB — fast iteration
make preview        # serve the dashboard locally while you iterate
```

Commit + push when ready. CI rebuilds firmware artifacts on every change under `firmware/**` and commits them back; devices pick up the new version via OTA. No need to run `make publish-*` locally unless you want to preview before pushing.

## Repo layout

- `firmware/esp32_robot_idf/` — ESP32 firmware (ESP-IDF; LED, WiFi onboarding, OTA, motors, camera, WebRTC peer).
- `firmware/pi_robot/` — Raspberry Pi firmware (Python + `bless`). Same service UUID and characteristic UUIDs as the ESP32 — indistinguishable from the dashboard's side. [Details + troubleshooting](firmware/pi_robot/README.md).
- `public/` — the dashboard (static ES modules, no build step). `docs/` is a symlink here for GitHub Pages.
- `tests/` — pure-function unit tests; `make smoke`. Manual checklist in [SMOKE.md](SMOKE.md).
- `.claude/` — agent + project context (working model, direction, scope discipline, model discipline).

The dashboard is flat by convention; naming prefixes carry the subsystem boundary:

- **Pair layer** (`pairing.js`, `phones.js`, `phone.js`, `phone.html`) — desktop ↔ phone WebRTC link.
- **Perception** (`perception.js`, `grounding.js`) — in-browser SmolVLM + OWLv2 for scene captions and spatial bounding boxes.
- **Pip / assistant** (`assistant.js`, `claude.js`, `pip-tools.js`, `replay.js`, `local-llm.js`) — Claude integration, tool schemas, executor, replay logging, offline LFM fallback.
- **Robot ops** (`ble.js`, `ops-response.js`, `capabilities/`) — BLE protocol, typed-ops channel, per-capability cards + runtime handlers.
- **Robot lifecycle** (`prepare.js`, `recovery.js`, `pinout.js`) — SD-card prep, USB serial recovery, pinout config editor.
- **User code** (`scripts.js`) — browser-resident IDE; the `robot` API mirrors BLE capabilities. See [USER-CODE.md](USER-CODE.md).
- **App shell** (`app.js`, `dom.js`, `state.js`, `settings.js`, `log.js`, `auth.js`, `passwords.js`, `index.html`, `styles.css`).

## Further reading

- [**Hardware guide**](HARDWARE.md) — recommended boards, board-specific knobs, driver notes.
- [**Pi firmware**](firmware/pi_robot/README.md) — BLE service spec, SD-card prep details, Bookworm/Trixie troubleshooting.
- [**User code**](USER-CODE.md) — why per-user code runs in the browser, not on the Pi.
- [**Observations**](OBSERVATIONS.md) — why Pip's proactive messages come from project state, not a scheduled content feed.

## Browser support

Web Bluetooth works in Chrome, Edge, and Opera on desktop and Android. Not Safari. Firefox only behind a flag. Deliberate constraint — the laptop is the central brain.

## License

TBD.
