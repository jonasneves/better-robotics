# Better Robotics

**Open a tab, pair a robot, ship code.**

No install, no servers.

[![Live](https://img.shields.io/badge/live-better--robotics.github.io-blue)](https://better-robotics.github.io/)
[![Build firmware](https://github.com/jonasneves/better-robotics/actions/workflows/build-firmware.yml/badge.svg)](https://github.com/jonasneves/better-robotics/actions/workflows/build-firmware.yml)
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

## Quickstart

### Use it (no install)

1. Open [better-robotics.github.io](https://better-robotics.github.io/) in Chrome or Edge.
2. Flash or prepare hardware:
   - **ESP32 on USB:** click **Flash firmware** — bins come from GitHub Pages, no local toolchain.
   - **Pi 4 with a flashed SD card:** click **Customize card** (or hit the URL with `?prepare`) and point it at the mounted boot partition.
3. Click **Scan**, pair a robot, toggle LED, onboard WiFi, drive motors. Future updates go over BLE via **Update firmware**.

### Develop locally

```bash
make setup          # one-time ESP-IDF + arduino-cli setup (macOS)
make flash          # build ESP32 firmware, upload over USB
make preview        # serve the dashboard at http://localhost:8000
```

Pi firmware is Python; see [`firmware/pi_robot/README.md`](firmware/pi_robot/README.md) for the SD-card prep flow and BLE service spec.

Commit and push. CI rebuilds firmware artifacts on `firmware/**` changes and commits them back; devices pick up new versions via OTA.

## Repo layout

```
firmware/esp32_robot_idf/   ESP32 firmware (ESP-IDF)
firmware/pi_robot/          Raspberry Pi firmware (Python + bless)
packages/                   Reusable ESP-IDF components (pid, sensors, filters)
public/                     Dashboard — static ES modules, no build step
tests/                      Pure-function unit tests · make smoke
.claude/                    Agent + project context
```

ESP32 and Pi expose the same service UUID and characteristic UUIDs, so the dashboard talks to either without conditional logic. `docs/` is a symlink to `public/` for GitHub Pages serving. The dashboard is flat by convention — naming prefixes carry subsystem boundaries; see `.claude/CLAUDE.md` for the subsystem map.

## Further reading

- [**Hardware guide**](HARDWARE.md) — recommended boards, board-specific knobs, driver notes.
- [**Pi firmware**](firmware/pi_robot/README.md) — BLE service spec, SD-card prep details, Bookworm/Trixie troubleshooting.
- [**User code**](USER-CODE.md) — how to write scripts in the browser; the `robot` API surface.
- [**Developer reference**](DEV.md) — URL flags, console handles, replay store, Chrome `chrome://` diagnostic pages.

## Browser support

Web Bluetooth: Chrome, Edge, Opera on desktop and Android. Not Safari. Firefox only behind a flag. Deliberate constraint: the laptop is the brain.

## License

[MIT](LICENSE).
