# Hardware guide

## Current: ESP32-CAM-MB

The kit ships with the **ESP32-CAM-MB**: AI Thinker ESP32-CAM module mounted on a programmer carrier with a USB micro-B port. Plug in, flash from the dashboard, done. The published binaries in `public/firmware/bins/` target this board; nothing else has prebuilt artifacts yet.

**Bare ESP32-CAM ≠ ESP32-CAM-MB.** Two SKUs ship under the same "ESP32-CAM" name. The bare module has no USB at all; flashing requires an external FTDI/CP2102 adapter wired to U0R/U0T/GND with IO0 grounded for boot. The MB carrier *is* the USB-to-serial bridge. Look for a separate small PCB with a USB micro-B port: that's the MB. Buy the kit version unless you specifically want the wiring exercise.

USB-UART chip on the MB carrier is CP2102 on most units, FT232R on some (silkscreened). macOS has the FTDI driver built in; CP2102 needs a [one-time kernel extension install from Silicon Labs](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers).

Buy: AI Thinker ESP32-CAM-MB sells widely on Amazon and AliExpress. Gotcha: confirm the listing includes the MB programmer carrier, not just the bare camera module.

### Camera on the CAM-MB

The 24-pin socket on the AI-Thinker board accepts OV2640, OV3660, and OV5640 modules — Espressif's `esp_camera` driver auto-detects the sensor. Firmware uses the stock AI-Thinker pin map (XCLK 0, SIOD 26, SIOC 27, data 5/18/19/21/36/39/34/35, VSYNC 25, HREF 23, PCLK 22, PWDN 32). VGA (640×480) JPEG, framebuffers in PSRAM, ~15 fps. Once WiFi is joined the firmware starts an MJPEG HTTP server on `:81/stream`, broadcasts its LAN IP on `wifi-status`, and advertises a `camera` capability of type `mjpeg-stream` in fw-info. The dashboard opens the stream as a plain `<img>` once both pieces are present. Dashboard browser must share a network with the robot — this is the WiFi data plane, not BLE.

### Motor wiring (L298N)

Default firmware pins: left `IN1=14, IN2=15`, right `IN1=13, IN2=4`. Tradeoffs are spelled out in the firmware comments above the declarations; the short version: those four are the only safe combination on this chip. Camera + PSRAM consume 15 GPIOs; the remaining survivors are 13/14/15/4 (and GPIO 4 doubles as the white flash LED, so it'll flicker visibly when the right motor is driven — cosmetic only).

**Leave the L298N's ENA/ENB jumpers ON.** The 5V tie-up keeps the H-bridge always enabled and lets PWM ride the IN pins themselves. Forward = `IN1=PWM, IN2=LOW`; reverse = swap. Same 2-pin-per-motor pattern the Pi uses with gpiozero. Trying to do separate IN + ENA/ENB control needs 6 GPIOs we don't have.

GPIO 15 is a strap pin (must be HIGH at boot for normal serial output). L298N's IN pins are high-impedance CMOS, but if your specific board has a weak pull-down on IN that fights the strap, add a 10k pull-up from GPIO 15 to 3.3V. Symptom: garbled serial during the first second of boot. Functionally harmless if you don't need that bootloader log.

### Optional hardware mods (for stability under load)

The AI-Thinker module's onboard AMS1117 LDO sags hard when WiFi TX bursts coincide with camera DMA + BLE radio activity. The firmware disables the brownout detector to survive this (otherwise the chip would reset mid-stream every few seconds), but the proper hardware fix is two capacitors:

- **470 µF electrolytic + 0.1 µF ceramic across the AMS1117 3.3V output.** Solder between the 3V3 and GND pins on the back of the AI-Thinker module. Absorbs camera-flash and WiFi TX transients. Single biggest reliability mod for ESP32-CAM.
- **100 µF on the 5V rail near the AI-Thinker 5V pin** (after the CAM-MB's LDO). Mostly relevant when battery-powered through the MB's 5V pin where there's no big bulk cap upstream — USB from a Mac is generally fine without it.

Both are well-documented and any electrolytic + ceramic of that order works. The brownout-disabled firmware works without these, but you're trading "auto-protect on real undervolt" for "doesn't reset on transient dips."

## Forward path: ESP32-C6 and ESP32-S3

Source compiles for both. **CI doesn't publish prebuilt binaries yet.** Flashing means cloning the repo and running `make flash` locally. Once a board is in hand to validate, CI can add targets and the dashboard's Flash button will route via `manifest.json`.

**ESP32-C6** is the natural BLE-first match: native USB CDC (no drivers), Bluetooth 5.3 LE, materially better RAM headroom than S3 when TLS shares memory with BLE during OTA, matches "BLE is the control plane" without dragging WiFi-radio cost. DevKitC-1 or any WROOM-based C6 board.

**ESP32-S3** is the path if you need dual-core or a camera. ESP32-S3-CAM, Freenove ESP32-S3-WROOM, or any DevKitC-S3. Native USB CDC, larger BLE/WiFi memory footprint than C6.

Buy in US: [Adafruit](https://www.adafruit.com/?q=ESP32-C6) (C6, S3), DigiKey, Mouser. Espressif's official store ships globally. Freenove kit ships from Amazon.

## Raspberry Pi

Tested on **Pi 4 Model B**. Bluetooth radio built in. Pi OS Bookworm (Python 3.11) or Trixie (Python 3.13) — the dashboard's Customize-card flow stages wheels for both.

Buy in US: [Adafruit](https://www.adafruit.com/?q=raspberry+pi+4), CanaKit, PiShop.us. Outside US: [official reseller list](https://www.raspberrypi.com/products/raspberry-pi-4-model-b/).

### Recovery plane (USB-C)

The Pi boots with a **composite USB gadget** (ECM ethernet + ACM serial) under `usb-gadget.service`, independent of the main firmware service. Plug USB-C from the Pi into your laptop:

- **ECM ethernet** — Pi appears at `10.55.0.1`; `ssh pi@10.55.0.1` works with the sudo password you set in Customize card.
- **ACM serial** — Pi appears as `/dev/cu.usbmodem*`; the dashboard's ⋯ → **Recovery console** menu item opens a full xterm.js terminal over this. Works even when BLE and WiFi are both dead, because the gadget is a kernel-level service that runs before `pi-robot` and doesn't depend on it.

Requires a USB-C **data** cable (not charge-only) — Anker or Cable Matters USB-C-to-USB-C marked "data" or "sync" works. The gotcha is power-only variants that look identical and ship in the box with most chargers. The Pi 4's USB-C port is the only gadget-capable port; USB-A ports on the top edge are hosts and won't work for this.

## Board-specific knobs

Two variables need to match your ESP32 board:

- **target** for `idf.py set-target` — `esp32` for CAM-MB; `esp32s3` for S3 boards. The IDF tree carries per-target sdkconfig defaults (`sdkconfig.defaults.esp32`, `sdkconfig.defaults.esp32s3`).
- **`LED_PIN`** default in `firmware/esp32_robot_idf/main/pin_config.c` — GPIO 33 active-low on CAM-MB. S3 boards vary; many use a WS2812 neopixel (GPIO 48 on DevKitC-S3) which needs a different driver entirely. The dashboard's Pinout editor can override this at runtime via NVS without a rebuild.

The IDF partition layout (1.9 MB OTA slots, otadata at 0xE000) matches arduino-esp32's `min_spiffs` so a fielded ESP32 originally flashed with the .ino can OTA into this firmware without bricking.

After changing either, push to `main` — CI rebuilds and publishes the new binary automatically. Run `make publish-firmware` locally only to preview before pushing.
