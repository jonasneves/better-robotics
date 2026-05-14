# esp32_robot — ESP-IDF firmware

Firmware for the ESP32-CAM and ESP32-S3 robot tier. ESP-IDF v5.5.4, NimBLE host, esp32-camera, esp_peer for WebRTC.

## Build

```sh
. ~/esp/esp-idf/export.sh   # if not already in this shell
idf.py build
idf.py -p /dev/cu.usbserial-* flash monitor
```

Or from repo root: `make compile`, `make flash`, `make monitor`.

`make publish-firmware` stages build artifacts to `public/firmware/bins/` for the dashboard's web-flasher and OTA paths. CI runs the same target on every push to `firmware/**`.

## Subsystem map

```
main/
  app_main.c        — init order: NVS → camera → caps → BLE → WiFi → HTTP → WebRTC
  pin_config.{c,h}  — NVS-backed pin overrides for LED / flash / motors
  led.{c,h}         — active-low GPIO toggle
  flash.{c,h}       — LEDC PWM (channel 4)
  motors.{c,h}      — H-bridge PWM (channels 0-3) + watchdog + LLM pulse safety
  camera.{c,h}      — esp32-camera w/ AI-Thinker pin map; QVGA q=18, fb_count=2
  http_stream.{c,h} — :81 MJPEG stream (only endpoint; presence depends on transport toggle)
  ota.{c,h}         — esp_ota_* state machine; BLE protocol + HTTP shared
  snapshot.{c,h}    — BLE single-frame transfer (begin/chunk/commit)
  ble_host.{c,h}    — NimBLE init + advertising + active-conn tracking
  gatt_svr.{c,h}    — GATT service table + access callbacks (14 chars)
  wifi_sta.{c,h}    — STA bring-up + scan/join/status (event-driven)
  fw_info.{c,h}     — capability advertisement JSON, built once at boot
  telemetry.{c,h}   — uptime / heap / IP, every 10s
  webrtc_peer.{c,h} — wss signaling, esp_peer, ota + video + control data channels
  restart_util.{c,h} — deferred restart (used by pin/cam/ota commit paths)
  balance.{c,h}      — 100 Hz FreeRTOS balance task (core 1); PID + lean/turn + I-dump timer
  Kconfig.projbuild  — CONFIG_BALANCE_BOT_ENABLED + I2C pin / address / invert flags

packages/ (EXTRA_COMPONENT_DIRS)
  pid/               — generic discrete PID with anti-windup (no platform deps)
  sensors/           — MPU6050 I2C driver, complementary filter → pitch angle
```

## Partition table

Matches arduino-esp32's `min_spiffs` so an OTA from .ino-firmware → IDF-firmware writes to the same slot. Only the app bin gets pushed over BLE OTA; bootloader and partition table stay put.

```
nvs       0x9000   20K
otadata   0xE000    8K
ota_0    0x10000 1920K
ota_1   0x1F0000 1920K
```

## Targets

- **ESP32-CAM-MB** (AI-Thinker, classic ESP32 + 4 MB SPI PSRAM): current dev target. Camera over MJPEG; WebRTC video routed as binary data-channel frames since browsers can't decode MJPEG video tracks.
- **ESP32-S3** (planned): same firmware via build-time target switch. Octal PSRAM + hardware H.264 would let video flow as a real WebRTC video track once libpeer's H.264 path is wired.
