# Better Robotics

**Open a tab, pair a robot, ship code.**

No install, no servers.

[![Live](https://img.shields.io/badge/live-neevs.io%2Fbetter--robotics-blue)](https://neevs.io/better-robotics/)
[![Build firmware](https://github.com/jonasneves/better-robotics/actions/workflows/build-firmware.yml/badge.svg)](https://github.com/jonasneves/better-robotics/actions/workflows/build-firmware.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Web Bluetooth](https://img.shields.io/badge/Web%20Bluetooth-Chrome%20%7C%20Edge-orange)](#browser-support)

## What this is

Open a Chrome tab. Pair a robot over BLE. Write JavaScript that drives it.

```js
// Multi-robot is a forEach.
for (const r of robots) {
  await r.led(true);
  await r.move({ left: 30, right: 30, durationMs: 400 });
  await r.led(false);
}

// Vision in the loop — uses the in-browser VLM.
const scene = await robot.scene("Is the path ahead clear?");
```

- **Browser is the IDE.** Scripts panel + capability cards. localStorage is the file system; BLE is the runtime link.
- **Models run in the browser too.** VLM and open-vocab detector run client-side. No GPU server, no cloud inference bill.
- **Two authorable surfaces, co-equal:** user code (you write JS) and Pip (a tool-using LLM with replay and ask-human, currently Claude). Both bound by the same firmware safety floor.
- **Fork the repo, push to your GitHub Pages, you have a robotics platform.** No backend, no accounts, no data leaving the browser.

## Architecture

Three independent planes:

```
┌──────────────────┐         BLE GATT (always on)          ┌──────────────────┐
│  Chrome browser  │ ◄────────────────────────────────────► │  Robot firmware  │
│  (Web Bluetooth) │   commands · state · ops · triggers    │  (ESP32 or Pi)   │
└──────────────────┘                                        └──────────────────┘
          ▲                                                           ▲
          ├─────────── WiFi (data plane, optional) ────────────────── ┤
          │   camera (WebRTC ↔ HTTP MJPEG, per-camera toggle)         │
          │                                                           │
          └─────── USB-C (recovery plane, last-resort, Pi only) ───── ┘
                    ECM ethernet · ACM serial console
```

- **Control plane — BLE.** Always on. Commands, telemetry, state changes, ops. ~1–3 Mbps, reliable, network-free. Pairing UI is the gatekeeper; no credentials cross the air.
- **Data plane — WiFi, optional.** Onboarded via BLE when needed. Carries video (per-camera toggle between WebRTC and HTTP MJPEG), large OTA, cloud LLM calls. Robots work fully without it.
- **Recovery plane — USB-C, last-resort (Pi).** Composite USB gadget (ECM + ACM serial) under its own systemd unit, independent of robot firmware. Dashboard exposes an xterm.js terminal over this.

**Why BLE for control:** classroom and demo WiFi rarely cooperates (blocked multicast, captive portals, client isolation). BLE sidesteps all three. Robot advertises on boot; laptop scans and sees every robot in the room. Multi-robot discovery is just multi-scan.

**Safety on disconnect.** Actuator characteristics (motor, servo, pump, relay) ship with a firmware watchdog. Every write resets a timer; if no write lands in the window, firmware reverts to a safe default. Silence is the trigger, not a redundant radio.

## What it isn't

The wedge is **fork-and-run dev environment with AI assist**, not these adjacent shapes:

- **Not a teleop dashboard.** Joystick UIs for human pilots are a different shape. Decision loops are seconds, not 20Hz.
- **Not a fleet manager.** Server-resident cloud for managing N robots is Viam's space; here, it's one operator forking their own platform.
- **Not autonomous.** The LLM doesn't drive everything. Pip is one of two authorable surfaces; user code is co-equal; ask-human is the terminal cascade rung.
- **Not real-time.** Pulse-bounded motion is the response: every motor command carries a `duration_ms` and firmware auto-stops at the end.
- **Not spatially aware.** Monocular camera + VLM + open-vocab detector. No depth, no SLAM, no metric maps. Navigation is semantic, not geometric.
- **Not a primary-online product.** Works on cafe wifi, after API outages, with no network at all (offline shell + local LFM fallback once installed). Cloud is augmentation.

## Quickstart

### Use it (no install)

1. Open [neevs.io/better-robotics](https://neevs.io/better-robotics/) in Chrome or Edge.
2. Flash or prepare hardware:
   - **ESP32 on USB:** click **Flash firmware** — bins come from GitHub Pages, no local toolchain.
   - **Pi 4 with a flashed SD card:** click **Customize card** (or hit the URL with `?prepare`) and point it at the mounted boot partition.
3. Click **Scan**, pair a robot, toggle LED, onboard WiFi, drive motors. Future updates go over BLE via **Update firmware**.

### Edit firmware (contributors)

```bash
make setup          # one-time — arduino-cli + ESP32 core (macOS)
make flash          # compile local source, upload over USB — fast iteration
make preview        # serve the dashboard locally while you iterate
```

Commit + push when ready. CI rebuilds firmware artifacts on every `firmware/**` change and commits them back; devices pick up the new version via OTA.

## Repo layout

- `firmware/esp32_robot_idf/` — ESP32 firmware (ESP-IDF; LED, WiFi onboarding, OTA, motors, camera, WebRTC peer).
- `firmware/pi_robot/` — Raspberry Pi firmware (Python + `bless`). Same service UUID and characteristic UUIDs as ESP32. [Details](firmware/pi_robot/README.md).
- `public/` — the dashboard (static ES modules, no build step). `docs/` is a symlink for GitHub Pages.
- `tests/` — pure-function unit tests; `make smoke`. Manual checklist in [SMOKE.md](SMOKE.md).
- `.claude/` — agent + project context (wedge, model discipline, control-loop architecture).

The dashboard is flat by convention; naming prefixes carry the subsystem boundary:

- **Pair layer** (`pairing.js`, `phones.js`, `mobile.js`, `phone.html`) — desktop ↔ phone WebRTC link.
- **Perception + detection** (`perception.js`, `grounding.js`) — in-browser LFM2.5-VL-450M (VLM), Grounding DINO tiny (open-vocab detector).
- **Pip / assistant** (`assistant.js`, `claude.js`, `local-llm.js`, `pip-tools.js`, `replay.js`) — tool-using LLM integration, tool schemas, executor, replay logging, offline LFM fallback.
- **Robot ops** (`ble.js`, `ops-response.js`, `capabilities/`) — BLE protocol, typed-ops channel, per-capability cards + runtime handlers.
- **Robot lifecycle** (`prepare.js`, `recovery.js`, `pinout.js`) — SD-card prep, USB serial recovery, pinout config editor.
- **User code** (`scripts.js`) — browser-resident IDE; the `robot` API mirrors BLE capabilities. See [USER-CODE.md](USER-CODE.md).
- **App shell** (`app.js`, `dom.js`, `state.js`, `settings.js`, `log.js`, `auth.js`, `passwords.js`, `index.html`, `styles.css`).

## Further reading

- [**Hardware guide**](HARDWARE.md) — recommended boards, board-specific knobs, driver notes.
- [**Pi firmware**](firmware/pi_robot/README.md) — BLE service spec, SD-card prep details, Bookworm/Trixie troubleshooting.
- [**User code**](USER-CODE.md) — how to write scripts in the browser; the `robot` API surface.
- [**Developer reference**](DEV.md) — URL flags, console handles, replay store, Chrome `chrome://` diagnostic pages.

## Browser support

Web Bluetooth: Chrome, Edge, Opera on desktop and Android. Not Safari. Firefox only behind a flag. Deliberate constraint: the laptop is the brain.

## License

[MIT](LICENSE).
