# Component sources — keep flat for now; promote subsystems to subdirs as
# they grow past ~3 files (mirrors the public/ subsystem-promotion rule).
#
# uuids.h is generated from protocol/uuids.json by tools/gen-uuids.py.
# Firmware version comes from esp_app_get_description()->version, which
# IDF derives from `git describe --always` at build time.

idf_component_register(
    SRCS
        "app_main.c"
        "wifi_sta.c"
        "ble_host.c"
        "gatt_svr.c"
        "pin_config.c"
        "led.c"
        "flash.c"
        "motors.c"
        "ota.c"
        "camera.c"
        "snapshot.c"
        "restart_util.c"
        "fw_info.c"
        "telemetry.c"
        "webrtc_peer.c"
        "http_stream.c"
    INCLUDE_DIRS
        "."
    PRIV_REQUIRES
        # Connectivity
        nvs_flash
        esp_wifi
        esp_event
        esp_netif
        # BLE — NimBLE matches the Arduino-side stack
        bt
        # Camera (managed component esp32-camera)
        esp32-camera
        # WebRTC (managed component esp_peer — Espressif's libpeer fork)
        espressif__esp_peer
        # OTA
        app_update
        esp_https_ota
        # HTTP MJPEG streamer (port 81/stream) — comparison path for WebRTC
        esp_http_server
        # Capabilities
        driver
        esp_timer
        # JSON parsing (cJSON via ESP-IDF's json component)
        json
)
