# pi_robot

Python robot firmware for the Raspberry Pi. Mirrors `firmware/esp32_robot/` — same BLE service, same characteristic UUIDs, same dashboard experience.

## BLE service

Core characteristics under one service UUID (others — motors, ops, telemetry, camera-signal/-status — are advertised dynamically via `fw-info` per the device's configured capabilities):

- `led` — read/write/notify. 1 byte: 0 or 1.
- `wifi-scan` — read/notify. JSON array of `{s, r, p}` (ssid, 0..100 strength, 1 if secured). Reading triggers a rescan; results arrive via notify.
- `wifi-join` — write. JSON `{s, p}` (ssid, password). Empty password for open networks.
- `wifi-status` — read/notify. JSON `{st, ssid, err}`. `st` ∈ `idle|joining|joined|failed`.

## Device identity

Generated at `firstrun.sh` if absent; survives SD re-imaging if preserved. Stored at `/var/lib/pi-robot/peer-key.json` (mode `0600`, directory `0700`, owner `pi`):

```json
{ "priv_b64": "<Ed25519 raw seed, 32 bytes, base64>",
  "pub_b64":  "<Ed25519 raw public key, 32 bytes, base64>" }
```

`wifi_discover.py` reads `pub_b64` at startup and publishes it in each ad as `data.pubkey`. Deleting the file and re-running `firstrun.sh` rotates the identity (breaks any dashboard trust pinned to the old key); don't do that unless you mean it.

## SD-card first boot

Flash Raspberry Pi OS to the card normally, then open the [dashboard](https://neevs.io/better-robotics/) and click **Customize card** in the Set up new hardware panel (or go direct with `?prepare` in the URL). Fill in hostname + sudo password, paste or pick your SSH public key, and pick the mounted boot partition (usually `/Volumes/bootfs` on macOS). The dialog stages aarch64 Python wheels (`bless`, `bleak`, `dbus-fast`, `dbus-next`, `typing-extensions`) into `/boot/firmware/wheels/`, the pi_robot source into `/boot/firmware/betterpi/`, renders `firstrun.sh`, and patches `cmdline.txt` + `config.txt`. Wheels for both Python 3.11 and 3.13 are bundled so either Pi OS Bookworm or Trixie works without a re-prep.

First boot runs entirely offline: no WiFi, no captive portal, no PyPI roundtrip. `firstrun.sh` copies the staged firmware into `/home/pi/better-robotics/firmware/pi_robot/`, creates a venv with `--system-site-packages` (so it picks up `python3-lgpio` from the base Pi OS image), installs with `pip install --no-index --find-links=/boot/firmware/wheels`, unblocks Bluetooth via rfkill, enables BlueZ's experimental advertising API, and starts `pi-robot.service` as root. Progress is appended to `/boot/firmware/firstrun.status` as an offline breadcrumb.

After that, the Pi runs BLE-only. WiFi is onboarded from the dashboard via the `wifi-scan` + `wifi-join` characteristics whenever a network is wanted. The SD card holds no credentials.

Developers: the wheels + template the Customize-card dialog consumes live under `public/firmware/pi_robot/`. CI refreshes them automatically on any push touching `firmware/**` (see `.github/workflows/build-firmware.yml`). Run `make publish-pi-firmware` locally only if you want to test the artifacts before pushing.

## Manual run (development)

```bash
cd firmware/pi_robot
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 pi_robot.py
```

Needs `bluetoothd` running and (usually) the user in the `bluetooth` group. The robot advertises as `BetterRobot-XXXX` (suffix derived from the Pi's chip serial). Scan for it from the dashboard at [neevs.io/better-robotics](https://neevs.io/better-robotics/).

## LED wiring

Default GPIO pin is `17` (BCM). To change, edit the `LED_PIN` constant at the top of `pi_robot.py`. For a quick test without an external LED, pick any pin and probe it with a multimeter — or swap to GPIO 47 (the green ACT LED on Pi 4) if you'd rather not wire anything.

## Permissions

Registering BLE advertisements via BlueZ on Pi OS reliably requires running as root — the non-root D-Bus policy path is brittle across BlueZ versions. The systemd unit (`pi-robot.service`) already sets `User=root`. For `python3 pi_robot.py` in development, prefix with `sudo`.

## Auto-start on boot

The SD-card first-boot flow installs `pi-robot.service` automatically. For manual install on an existing Pi:

```bash
sudo install -m 644 pi-robot.service /etc/systemd/system/pi-robot.service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-robot
```

## Adding capabilities

Same pattern as the ESP32 variant: add new characteristics inside the existing service. Motors, sensors, and encoders become additional characteristics that the dashboard discovers on connect. The service UUID stays the same, so a Pi robot and an ESP32 robot look identical to users.

## Optional: Pi Camera (WebRTC)

If a Pi Camera Module is attached and the optional deps are installed, the firmware advertises two extra characteristics (`camera-signal`, `camera-status`) and the dashboard shows a Camera section with a live video feed.

```bash
sudo apt install -y python3-picamera2 ffmpeg
pip install aiortc av
```

The firmware auto-detects the stack: if any import fails, the camera characteristics simply aren't registered and the dashboard doesn't show a camera UI. No camera = no behavior change.

Signaling (SDP/ICE) flows over BLE using a chunked opcode protocol (begin, chunk, commit) symmetric to OTA. Once the WebRTC PeerConnection is established, video frames flow directly over the ICE-negotiated path (LAN direct when possible).

## Troubleshooting

Hard-won gotchas from getting first boot to actually work on Pi OS Trixie. Check these first if something fails.

- **Green LED blinks briefly then goes dark, nothing else happens.** Pi isn't completing boot. Most common cause is under-voltage — Pi 4 wants 5V/3A; phone chargers rated 2A often brown out. Less common: ext4 root corrupted from an earlier bad boot (re-flash Raspberry Pi OS). HDMI monitor is the fastest diagnostic.
- **`firstrun.status` exists but `pi-robot.service` isn't advertising.** Check `pi-robot-journal.log`. If you see `dbus_next.errors.DBusError: Failed to register advertisement`, Bluetooth is rfkill-blocked. Pi OS Trixie ships with `hci0` soft-blocked by default. `firstrun.sh` handles this, but if you're running manually, `sudo rfkill unblock bluetooth` first.
- **`pip install` fails with `No matching distribution found` for a wheel that exists.** Python version mismatch. Pi OS Bookworm ships Python 3.11, Trixie ships 3.13. Wheels for both are bundled; if you're staging manually, target `--python-version 313` for current images.
- **`bless` install fails with "no dbus-next / typing-extensions".** Don't use pip's resolver across platforms — enumerate the Linux dep chain explicitly: `bless bleak dbus-fast dbus-next typing-extensions`. bless needs `dbus-next` on Linux; `bleak` separately needs `dbus-fast` + `typing-extensions` (on Python<3.12).
- **Browser SD-prep page can't fetch wheels.** `files.pythonhosted.org` has no CORS headers. Host the wheels on the same origin as the dashboard (we do, under `public/firmware/pi_robot/wheels/` with a `manifest.json`).
- **`sudo: unable to resolve host <name>` warning in `firstrun.status`.** Benign — the hostname changed mid-session and `/etc/hosts` hasn't caught up. sudo continues normally. Not a failure.
- **AppleDouble `._*.whl` gotcha.** macOS creates companion files on FAT32; deleting the primary auto-deletes the companion, so naive directory iteration can return a file that's already gone. Skip names starting with `._` during iteration. The browser SD-prep tool handles this already.
