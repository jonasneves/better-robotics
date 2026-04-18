# Hardware guide

## Recommended: ESP32-S3 with native USB

For new builds, pick an **ESP32-S3 board with native USB** — ESP32-S3-CAM, Freenove ESP32-S3-WROOM dev kit, or any DevKitC-S3. The S3 exposes USB CDC directly from the chip, so Web Serial talks straight to it on macOS, Windows, and Linux with **no drivers to install**. Same Arduino core, same BLE stack, same firmware with minor board-knob changes below.

## Legacy: ESP32-CAM-MB

The published binaries currently target the **ESP32-CAM-MB** (AI Thinker ESP32-CAM + MB programmer carrier) — the original development hardware. Its USB-UART bridge is CP210x (Silicon Labs) or FT232R (FTDI). macOS has the FTDI driver built in; CP210x requires a [one-time kernel extension install](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers). Works, but the kext is the friction the S3 recommendation is meant to sidestep.

## Raspberry Pi

Tested on **Pi 4 Model B**. Bluetooth radio built in. Pi OS Bookworm (Python 3.11) or Trixie (Python 3.13) — the dashboard's Customize-card flow stages wheels for both.

## Board-specific knobs

Two variables need to match your ESP32 board:

- **`FQBN`** in `Makefile` — `esp32:esp32:esp32cam:PartitionScheme=min_spiffs` for CAM-MB; for S3, something like `esp32:esp32:esp32s3:PartitionScheme=min_spiffs,USBMode=default,CDCOnBoot=cdc` (run `arduino-cli board listall` for exact identifiers on your core version).
- **`LED_PIN`** in `firmware/esp32_robot/esp32_robot.ino` — GPIO 33 active-low on CAM-MB. S3 boards vary; many use a WS2812 neopixel on GPIO 48, which needs a different driver entirely.

`min_spiffs` is load-bearing across both: its dual 1.9 MB app partitions are what OTA needs to stage an update without wiping the running image.

After changing either, push to `main` — CI rebuilds and publishes the new binary automatically. Run `make publish-firmware` locally only to preview before pushing.
