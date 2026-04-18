# Hardware guide

## Recommended: ESP32-C6 (BLE-first, no camera)

For new builds where BLE is the primary channel and a camera isn't required, pick an **ESP32-C6** — DevKitC-1 or any WROOM-based C6 board. It has native USB CDC (no drivers), Bluetooth 5.3 LE with materially better RAM headroom than S3 when the TLS stack shares memory with BLE during OTA, and matches the "BLE is the control plane" shape of this project better than dual-radio boards. Same Arduino core, same firmware, board knobs below.

## Alternative: ESP32-S3 with native USB

If you need dual-core horsepower or a camera, the **ESP32-S3** remains a strong choice — ESP32-S3-CAM, Freenove ESP32-S3-WROOM dev kit, or any DevKitC-S3. Native USB CDC (no drivers), same firmware. Picks up some headroom over the C6 at the cost of a larger BLE/WiFi memory footprint.

## Legacy: ESP32-CAM-MB

The published binaries currently target the **ESP32-CAM-MB** (AI Thinker ESP32-CAM + MB programmer carrier) — the original development hardware. Its USB-UART bridge is CP210x (Silicon Labs) or FT232R (FTDI). macOS has the FTDI driver built in; CP210x requires a [one-time kernel extension install](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers). Works, but the kext is the friction the S3 recommendation is meant to sidestep.

## Raspberry Pi

Tested on **Pi 4 Model B**. Bluetooth radio built in. Pi OS Bookworm (Python 3.11) or Trixie (Python 3.13) — the dashboard's Customize-card flow stages wheels for both.

## Board-specific knobs

Two variables need to match your ESP32 board:

- **`FQBN`** in `Makefile` — `esp32:esp32:esp32cam:PartitionScheme=min_spiffs` for CAM-MB; for S3, something like `esp32:esp32:esp32s3:PartitionScheme=min_spiffs,USBMode=default,CDCOnBoot=cdc`; for C6, `esp32:esp32:esp32c6:PartitionScheme=min_spiffs,CDCOnBoot=cdc` (run `arduino-cli board listall` for exact identifiers on your core version).
- **`LED_PIN`** in `firmware/esp32_robot/esp32_robot.ino` — GPIO 33 active-low on CAM-MB. S3 and C6 boards vary; many use a WS2812 neopixel (GPIO 48 on DevKitC-S3, GPIO 8 on DevKitC-C6) which needs a different driver entirely.

`min_spiffs` is load-bearing across both: its dual 1.9 MB app partitions are what OTA needs to stage an update without wiping the running image.

After changing either, push to `main` — CI rebuilds and publishes the new binary automatically. Run `make publish-firmware` locally only to preview before pushing.
