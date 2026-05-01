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
        "turn_creds.c"
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
        # turn_creds — HTTPS POST to proxy.neevs.io for Cloudflare TURN creds
        esp_http_client
        # Capabilities
        driver
        esp_timer
        # WebRTC signaling — JSON over wss:// to signal.neevs.io.
        json
        esp-tls
)
