# pi_robot

Python robot firmware for the Raspberry Pi. Mirrors `firmware/esp32_robot_idf/` — same BLE service, same characteristic UUIDs, same dashboard experience.

## BLE service

All characteristics live under one service UUID. Presence is config-driven (`/boot/firmware/pi-robot.conf`) and reported per-robot in `fw-info`; the dashboard renders only what's advertised. Wire shapes for the always-present characteristics:

- `led` — read/write/notify. 1 byte: 0 or 1.
- `wifi-scan` — read/notify. JSON array of `{s, r, p}` (ssid, 0..100 strength, 1 if secured). Reading triggers a rescan; results arrive via notify.
- `wifi-join` — write. JSON `{s, p}` (ssid, password). Empty password for open networks.
- `wifi-status` — read/notify. JSON `{st, ssid, err, ip?}`. `st` ∈ `idle|joining|joined|failed`.
- `fw-info` — read. JSON `{type, url, caps, bundle_url, version, authorized?}`.
- `robot-status` — notify. JSON `{st, msg?}` — top-level state, sticky-on-disconnect.
- `telemetry` — notify (~6s). JSON `{uptime_s, mem_free_mb, temp_c?}`.
- `ops` / `ops-response` — write / chunked notify. Typed verbs: `get-log`, `get-config`, `restart-service`, `reboot`, `install-pkg`, `enroll-key`. Each verb is a deliberate, reviewable decision; this is the BLE/WiFi debug surface in lieu of a remote shell.
- `motors` — write. Pulse-bounded; auto-stop watchdog in firmware.
- `ota-control` / `ota-data` — single-file and bundle OTA, sha256-verified.
- `camera-signal` / `camera-status` — registered only when the camera stack imports successfully; WebRTC SDP/ICE chunked over a symmetric protocol to OTA.
- `admin` — write. Reserved for low-level ops (e.g. install-on-demand for camera deps).

## Companion services

Three services run alongside `pi-robot.service`, each independently restartable:

- **`pi-robot-heartbeat.service`** — minimal always-on BLE advertiser (`heartbeat.py`). Keeps the robot observable when `pi-robot.service` is down: dashboard shows a "firmware-down" banner with the LAN IP and a recovery button. The connection-first invariant — connectivity outlives capabilities.
- **`pi-robot-health.service`** — stdlib HTTP server on `:81` exposing `GET /health` returning `{ok, type:"pi", robotId, ip, uptime_s, pi_robot_service}`. Pulled by the dashboard's mDNS + cached-IP probe (every 30 s per paired robot). Same recovery convention as heartbeat — its own unit, zero dependency on `pi_robot.py`. avahi-daemon publishes `<hostname>._http._tcp.local` so the probe can resolve `<name>.local` without an internet rendezvous (`/etc/avahi/services/betterrobot.service`).
- **`pi-robot-rtc.service`** — WebRTC peer (`pi_robot_rtc.py`) signaled via `wss://signal.neevs.io/pi-rtc-<robotId>/ws`. Independent of the BLE-signaled camera path: the BLE path streams Pi Camera frames once paired in-LAN; this service exposes the recovery-tier shell channel reachable across networks. Either path can be used in isolation; they don't share state.

## SD-card first boot

Flash Raspberry Pi OS, then open the [dashboard](https://better-robotics.github.io/) and click **Customize card** in the Set up new hardware panel (or `?prepare` in the URL). Fill in hostname + sudo password, paste or pick an SSH public key, point at the mounted boot partition (usually `/Volumes/bootfs` on macOS). The dialog stages aarch64 Python wheels (`bless`, `bleak`, `dbus-fast`, `dbus-next`, `typing-extensions`) into `/boot/firmware/wheels/`, pi_robot source into `/boot/firmware/betterpi/`, renders `firstrun.sh`, and patches `cmdline.txt` + `config.txt`. Wheels for both Python 3.11 and 3.13 are bundled so Bookworm or Trixie works without re-prep.

First boot runs entirely offline: no WiFi, no captive portal, no PyPI roundtrip. `firstrun.sh` copies staged firmware into `/home/pi/better-robotics/firmware/pi_robot/`, creates a venv with `--system-site-packages` (picks up `python3-lgpio` from the base image), installs with `pip install --no-index --find-links=/boot/firmware/wheels`, unblocks Bluetooth via rfkill, enables BlueZ's experimental advertising API, and starts `pi-robot.service` as root. Progress appends to `/boot/firmware/firstrun.status` as an offline breadcrumb.

After that, Pi runs BLE-only. WiFi is onboarded from the dashboard via the `wifi-scan` + `wifi-join` characteristics whenever a network is wanted. SD card holds no credentials.

Developers: wheels + template that Customize-card consumes live under `public/firmware/pi_robot/`. CI refreshes them on any push touching `firmware/**` (see `.github/workflows/build-firmware.yml`). Run `make publish-pi-firmware` locally only to test artifacts before pushing.

## Manual run (development)

```bash
cd firmware/pi_robot
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 pi_robot.py
```

Needs `bluetoothd` running and (usually) the user in the `bluetooth` group. Robot advertises as `BR-XXXX` (suffix from Pi chip serial). Scan from the dashboard at [better-robotics.github.io](https://better-robotics.github.io/).

## LED wiring

Default GPIO pin is `17` (BCM). To change, edit `LED_PIN` at the top of `pi_robot.py`. For a quick test without an external LED, pick any pin and probe with a multimeter, or swap to GPIO 47 (green ACT LED on Pi 4).

## Permissions

Registering BLE advertisements via BlueZ on Pi OS reliably requires root; the non-root D-Bus policy path is brittle across BlueZ versions. `pi-robot.service` already sets `User=root`. For `python3 pi_robot.py` in development, prefix with `sudo`.

## Auto-start on boot

The SD-card first-boot flow installs `pi-robot.service` automatically. For manual install on an existing Pi:

```bash
sudo install -m 644 pi-robot.service /etc/systemd/system/pi-robot.service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-robot
```

## Adding capabilities

Same pattern as ESP32: add new characteristics inside the existing service. Motors, sensors, encoders become characteristics the dashboard discovers on connect. Service UUID stays the same, so a Pi robot and an ESP32 robot look identical.

## Optional: Pi Camera (WebRTC)

With a Pi Camera Module attached and optional deps installed, firmware advertises `camera-signal` + `camera-status` and the dashboard shows a Camera section with a live video feed.

```bash
sudo apt install -y python3-picamera2 ffmpeg
pip install aiortc av
```

Firmware auto-detects: if any import fails, camera characteristics aren't registered and the dashboard shows no camera UI.

Signaling (SDP/ICE) flows over BLE via a chunked opcode protocol (begin, chunk, commit) symmetric to OTA. Once the PeerConnection is established, video frames flow over the ICE-negotiated path (LAN direct when possible).

## Troubleshooting

Hard-won gotchas from getting first boot to work on Pi OS Trixie.

- **Green LED blinks briefly then goes dark, nothing else happens.** Pi isn't completing boot. Most common cause is under-voltage — Pi 4 wants 5V/3A; phone chargers rated 2A often brown out. Less common: ext4 root corrupted from an earlier bad boot (re-flash Raspberry Pi OS). HDMI monitor is the fastest diagnostic.
- **`firstrun.status` exists but `pi-robot.service` isn't advertising.** Check `pi-robot-journal.log`. If you see `dbus_next.errors.DBusError: Failed to register advertisement`, Bluetooth is rfkill-blocked. Pi OS Trixie ships with `hci0` soft-blocked by default. `firstrun.sh` handles this, but if you're running manually, `sudo rfkill unblock bluetooth` first.
- **`pip install` fails with `No matching distribution found` for a wheel that exists.** Python version mismatch. Pi OS Bookworm ships Python 3.11, Trixie ships 3.13. Wheels for both are bundled; if you're staging manually, target `--python-version 313` for current images.
- **`bless` install fails with "no dbus-next / typing-extensions".** Don't use pip's resolver across platforms — enumerate the Linux dep chain explicitly: `bless bleak dbus-fast dbus-next typing-extensions`. bless needs `dbus-next` on Linux; `bleak` separately needs `dbus-fast` + `typing-extensions` (on Python<3.12).
- **Browser SD-prep page can't fetch wheels.** `files.pythonhosted.org` has no CORS headers. Host the wheels on the same origin as the dashboard (we do, under `public/firmware/pi_robot/wheels/` with a `manifest.json`).
- **`sudo: unable to resolve host <name>` warning in `firstrun.status`.** Benign — the hostname changed mid-session and `/etc/hosts` hasn't caught up. sudo continues normally. Not a failure.
- **AppleDouble `._*.whl` gotcha.** macOS creates companion files on FAT32; deleting the primary auto-deletes the companion, so naive directory iteration can return a file that's already gone. Skip names starting with `._` during iteration. The browser SD-prep tool handles this already.
