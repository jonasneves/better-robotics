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

`sd-prep` stages aarch64 Python wheels (`bless`, `bleak`, `dbus-fast`, `async-timeout`, `gpiozero`) into `/boot/firmware/wheels/` and the pi_robot source into `/boot/firmware/betterpi/`, then renders `firstrun.sh` with your values and patches `cmdline.txt`.

First boot runs entirely offline: no WiFi, no captive portal, no PyPI roundtrip. `firstrun.sh` copies the staged firmware into `/home/pi/better-robotics/firmware/pi_robot/`, creates a venv with `--system-site-packages` (so it picks up `python3-lgpio` from the Bookworm image), `pip install --no-index --find-links=/boot/firmware/wheels`, enables the systemd service, and reboots. Progress is appended to `/boot/firmware/firstrun.status` as an offline breadcrumb; if the Pi happens to already have internet (e.g. from a previous session), the same events also stream to [signal.neevs.io](https://signal.neevs.io) for live dashboard status.

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

BLE peripheral mode on Linux talks to `bluetoothd` over D-Bus. On most Pi OS installs this works without `sudo`, but if you see `org.bluez.Error.NotPermitted` or `Rejected send message`, either run with `sudo` or grant the user access:

```bash
sudo usermod -aG bluetooth $USER
# then log out and back in
```

## Auto-start on boot

The SD-card first-boot flow installs `pi-robot.service` automatically. For manual install on an existing Pi:

```bash
sudo install -m 644 pi-robot.service /etc/systemd/system/pi-robot.service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-robot
```

## Adding capabilities

Same pattern as the ESP32 variant: add new characteristics inside the existing service. Motors, sensors, and encoders become additional characteristics that the dashboard discovers on connect. The service UUID stays the same, so a Pi robot and an ESP32 robot look identical to users.
