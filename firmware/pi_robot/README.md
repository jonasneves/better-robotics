# pi_robot

Python robot firmware for the Raspberry Pi. Mirrors `firmware/esp32_robot/` — same BLE service, same characteristic UUIDs, same dashboard experience.

## BLE service

Four characteristics under one service UUID:

- `led` — read/write/notify. 1 byte: 0 or 1.
- `wifi-scan` — read/notify. JSON array of `{s, r, p}` (ssid, 0..100 strength, 1 if secured). Reading triggers a rescan; results arrive via notify.
- `wifi-join` — write. JSON `{s, p}` (ssid, password). Empty password for open networks.
- `wifi-status` — read/notify. JSON `{st, ssid, err}`. `st` ∈ `idle|joining|joined|failed`.

## SD-card first boot

Flash Raspberry Pi OS to the card normally, then with the boot partition mounted at `/Volumes/bootfs`:

```bash
USER_PASS='sudopass' make sd-prep
```

`sd-prep` stages aarch64 Python wheels (`bless`, `bleak`, `dbus-fast`, `dbus-next`, `typing-extensions`) into `/boot/firmware/wheels/` and the pi_robot source into `/boot/firmware/betterpi/`, then renders `firstrun.sh` with your values and patches `cmdline.txt`. Wheels for both Python 3.11 and 3.13 are bundled so either Pi OS Bookworm or Trixie works without a re-prep.

Browser equivalent: open `/prepare.html` on the deployed dashboard and pick the boot partition with File System Access API. Same end state, no Python or terminal.

First boot runs entirely offline: no WiFi, no captive portal, no PyPI roundtrip. `firstrun.sh` copies the staged firmware into `/home/pi/better-robotics/firmware/pi_robot/`, creates a venv with `--system-site-packages` (so it picks up `python3-lgpio` from the base Pi OS image), installs with `pip install --no-index --find-links=/boot/firmware/wheels`, unblocks Bluetooth via rfkill, enables BlueZ's experimental advertising API, and starts `pi-robot.service` as root. Progress is appended to `/boot/firmware/firstrun.status` as an offline breadcrumb.

After that, the Pi runs BLE-only. WiFi is onboarded from the dashboard via the `wifi-scan` + `wifi-join` characteristics whenever a network is wanted. The SD card holds no credentials.

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

## Troubleshooting

Hard-won gotchas from getting first boot to actually work on Pi OS Trixie. Check these first if something fails.

- **Green LED blinks briefly then goes dark, nothing else happens.** Pi isn't completing boot. Most common cause is under-voltage — Pi 4 wants 5V/3A; phone chargers rated 2A often brown out. Less common: ext4 root corrupted from an earlier bad boot (re-flash Raspberry Pi OS). HDMI monitor is the fastest diagnostic.
- **`firstrun.status` exists but `pi-robot.service` isn't advertising.** Check `pi-robot-journal.log`. If you see `dbus_next.errors.DBusError: Failed to register advertisement`, Bluetooth is rfkill-blocked. Pi OS Trixie ships with `hci0` soft-blocked by default. `firstrun.sh` handles this, but if you're running manually, `sudo rfkill unblock bluetooth` first.
- **`pip install` fails with `No matching distribution found` for a wheel that exists.** Python version mismatch. Pi OS Bookworm ships Python 3.11, Trixie ships 3.13. `sd-prep` bundles wheels for both; if you're staging manually, target `--python-version 313` for current images.
- **`bless` install fails with "no dbus-next / typing-extensions".** Don't use pip's resolver across platforms — enumerate the Linux dep chain explicitly: `bless bleak dbus-fast dbus-next typing-extensions`. bless needs `dbus-next` on Linux; `bleak` separately needs `dbus-fast` + `typing-extensions` (on Python<3.12).
- **Browser SD-prep page can't fetch wheels.** `files.pythonhosted.org` has no CORS headers. Host the wheels on the same origin as the dashboard (we do, under `public/firmware/pi_robot/wheels/` with a `manifest.json`).
- **`sudo: unable to resolve host <name>` warning in `firstrun.status`.** Benign — the hostname changed mid-session and `/etc/hosts` hasn't caught up. sudo continues normally. Not a failure.
- **`prepare-sd.py` throws `FileNotFoundError` iterating `._*.whl`.** macOS creates AppleDouble companion files on FAT32; deleting the primary auto-deletes the companion, so the glob can return a file that's already gone. Skip names starting with `._` during iteration.
