# Better Robotics

BLE-first robotics kit. Turn on a robot, open a Chrome tab, see it appear. No WiFi credentials, no network joining, no configuration files.

## Why BLE-first

Classroom and demo environments rarely give you a joinable WiFi network. The ones that do usually block multicast (so mDNS fails), require captive-portal logins (so ESP32s can't join), or have client isolation (so peers can't see each other). Every WiFi-first onboarding story collapses in a real classroom.

BLE avoids the problem entirely:
- Robot advertises the moment it boots — no network to join
- Laptop scans and sees every robot in the room
- Multi-robot discovery is just multi-scan
- Laptop's own WiFi stays connected (for internet, AI APIs)
- Zero credentials, ever

## Architecture

Two channels, each doing what it's best at:

- **BLE — control plane.** Always on. Carries commands, telemetry, state changes, and update triggers. Low bandwidth (~1–3 Mbps) but reliable and network-free. The browser's pairing UI is the gatekeeper; no credentials cross the air.
- **WiFi — data plane, optional.** Onboarded via BLE when a robot wants it. Carries anything too big for BLE: large OTA payloads, video streams, cloud ML inference. Robots work fully without it.

Each robot advertises a single BLE GATT service. Capabilities (LED, motors, sensors, WiFi config, OTA) are characteristics inside it. A `fw-info` characteristic reports the robot's type and where to fetch its firmware — BLE-streamed for small payloads (Pi's 9 KB Python), WiFi-fetched when that's faster (ESP32's 1.6 MB binary). Same control protocol, different data plane per robot.

```
┌──────────────────┐      BLE GATT (always on)       ┌──────────────────┐
│  Chrome browser  │ ◄──────────────────────────────► │  Robot firmware  │
│  (Web Bluetooth) │   commands · state · triggers    │  (ESP32 or Pi)   │
└──────────────────┘                                  └──────────────────┘
          ▲                                                     ▲
          └───────────── WiFi (data plane, optional) ───────────┘
                  large OTA · video · cloud calls
```

- **No server, no broker, no cloud in the critical path.** The browser pairs directly with the robot over BLE. WiFi, when present, is used only for content fetched from the same GitHub Pages deploy that serves the dashboard itself.

### Safety on disconnect

Every actuator characteristic (motor, servo, pump, relay — anything that moves, heats, or draws current) ships with a watchdog built into the firmware. Writes reset a timer; if no write lands within the window (default 500 ms), the firmware reverts to a safe default on its own and notifies the dashboard so the UI stays honest.

This is the architecture's answer to "what happens when the channel drops?" — operator out of range, browser tab closes, laptop sleeps. A second comms channel doesn't help with any of those (the operator is just gone), but a watchdog does. The rule applies to any new actuator capability we add — don't layer safety above; make silence itself the trigger for the safe state.

## Scope of this repo (today)

- `firmware/esp32_robot/` — ESP32 variant. Advertises BLE, handles LED control, WiFi onboarding, and OTA self-update.
- `firmware/pi_robot/` — Raspberry Pi variant (Python + `bless`). Same service UUID, same characteristic UUIDs — indistinguishable from the ESP32 side of the dashboard. Same capabilities plus offline-first install.
- `public/index.html` — Chrome dashboard: scans over BLE, pairs, controls LED, onboards WiFi, triggers OTA, prints QR labels per robot.
- `public/prepare.html` — browser-based SD-card prep for fresh Pis (File System Access API).

Each robot's capabilities grow by adding characteristics to the shared service. Motors, sensors, cameras, and more are future characteristics, not future protocols.

## Quickstart

### 1. Install host dependencies (once per machine)
```bash
make setup
```

### 2. Flash the firmware
Plug an ESP32 in over USB:
```bash
make flash
```

### 3. Open the dashboard
```bash
make preview
```
Chrome opens at `http://localhost:8080`. Click **Scan**, pick your ESP32, toggle the LED.

## Hardware

Firmware and published binaries target the **ESP32-CAM-MB** (AI Thinker ESP32-CAM module on the MB programmer carrier). Specifically:

- **`LED_PIN = 33`** — the red onboard LED on the camera module, active-low. Other boards may not have an LED at that pin.
- **FQBN `esp32:esp32:esp32cam:PartitionScheme=min_spiffs`** — dual 1.9 MB app slots (A/B) plus a 128 KB SPIFFS. OTA-capable so future Bluetooth firmware updates don't require USB.
- The bins in `public/firmware/bins/` are compiled against that FQBN. Flashing them onto a different ESP32 board will probably boot, but the LED won't respond and the partition table will be CAM-specific.

To target a different ESP32 board, edit `FQBN` in the Makefile and `LED_PIN` in `firmware/esp32_ble_led/esp32_ble_led.ino`, then rerun `make publish-firmware`.

**USB-serial chip:** the ESP32-CAM-MB ships with either CP210x (Silicon Labs) or FT232R (FTDI). macOS has the FTDI driver built in, but CP210x requires a [one-time driver install](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers). Either works.

## Browser support

Web Bluetooth works in Chrome, Edge, and Opera (desktop + Android). It does **not** work in Safari on iOS or macOS, and it is behind a flag in Firefox. This is a deliberate constraint — the laptop is the central brain.

## Status

End-to-end loop works on Pi 4 and ESP32-CAM-MB hardware: pair over BLE, toggle LED, onboard WiFi, OTA the firmware, print QR labels. Control/data channel split validated. Expanding to motors, sensors, and multi-robot coordination from this shape.

## License

TBD.
