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
WIFI_SSID='YourNet' WIFI_PASS='yourpass' USER_PASS='sudopass' make sd-prep
```

This renders `firstrun.template.sh` into `/Volumes/bootfs/firstrun.sh` with your values baked in, patches `cmdline.txt` to trigger it at first boot, and prints a live-progress URL like `https://neevs.io/better-robotics/?setup=betterpi-abc12345`.

On first boot the Pi joins WiFi **once** (only to `pip install` deps), fetches firmware from [neevs.io/better-robotics/firmware/pi_robot/](https://neevs.io/better-robotics/firmware/pi_robot/), sets up a venv, enables the systemd service, then cleans up and reboots. Each stage emits a progress event to [signal.neevs.io](https://signal.neevs.io) so the dashboard shows live setup status; the same events are appended to `/boot/firmware/firstrun.status` as an offline breadcrumb.

After that, the Pi runs BLE-only by default. New WiFi networks are onboarded from the dashboard via the `wifi-scan` + `wifi-join` characteristics. The SD card holds no credentials after first boot.

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
