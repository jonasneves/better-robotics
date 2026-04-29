# Component sources — keep flat for now; promote subsystems to subdirs as
# they grow past ~3 files (mirrors the public/ subsystem-promotion rule).
#
# uuids.h is generated from protocol/uuids.json by tools/gen-uuids.py.
# version.h is stamped by `make publish-firmware` with the git short SHA.

idf_component_register(
    SRCS
        "app_main.c"
        "wifi_sta.c"
        "ble_host.c"
        "gatt_svr.c"
        "mdns_advertise.c"
        "pin_config.c"
        "led.c"
        "flash.c"
        "motors.c"
        "ota.c"
        "http_server.c"
        "camera.c"
        "snapshot.c"
        "restart_util.c"
        "fw_info.c"
        "telemetry.c"
        "webrtc_peer.c"
    INCLUDE_DIRS
        "."
    PRIV_REQUIRES
        # Connectivity
        nvs_flash
        esp_wifi
        esp_event
        esp_netif
        mdns
        # BLE — NimBLE matches the Arduino-side stack
        bt
        # Camera (managed component esp32-camera)
        esp32-camera
        # WebRTC (managed component libpeer)
        libpeer
        # OTA
        app_update
        esp_https_ota
        # HTTP (existing :81 server: MJPEG, /ota, /health)
        esp_http_server
        # Capabilities
        driver
        esp_timer
        # WebRTC signaling — JSON over wss:// to signal.neevs.io.
        json
        esp-tls
)
