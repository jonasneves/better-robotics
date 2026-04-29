#include <stdio.h>

#include "esp_log.h"
#include "esp_mac.h"
#include "nvs_flash.h"

#include "ble_host.h"
#include "camera.h"
#include "flash.h"
#include "fw_info.h"
#include "http_server.h"
#include "led.h"
#include "mdns_advertise.h"
#include "motors.h"
#include "ota.h"
#include "pin_config.h"
#include "telemetry.h"
#include "webrtc_peer.h"
#include "wifi_sta.h"

static const char *TAG = "esp32_robot";

// Connection-first init (CLAUDE.md), but on classic ESP32-CAM the camera
// must allocate its 32 KB DMA buffer in fresh internal heap (PSRAM isn't
// DMA-coherent on this chip). Allocation order matches the .ino:
//
//   1. NVS              (Preferences-equivalent for pin / wifi / cam)
//   2. pin_config       (load runtime overrides)
//   3. Camera           (esp32-camera; fights for DRAM first, fails
//                        loudly if PSRAM is missing — fw-info hides
//                        the cap so the dashboard adapts)
//   4. LED / Flash / Motors
//   5. NimBLE host      (BLE before WiFi — controller pool fits while
//                        heap is mostly fresh; reverse order panics)
//   6. OTA              (no radio; just esp_partition lookup)
//   7. WiFi STA         (whatever's left — comes up with fewer RX
//                        buffers if needed)
//   8. HTTP server :81  (LWIP up by now)
//   9. mDNS

void app_main(void) {
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    pin_config_t pins;
    pin_config_load(&pins);

    // Stable per-chip suffix — low 16 bits of the WiFi MAC. Same shape as
    // the .ino so paired robots in localStorage keep matching.
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    char ble_name[16];
    char hostname[32];
    snprintf(ble_name, sizeof(ble_name), "BR-%02X%02X", mac[4], mac[5]);
    snprintf(hostname, sizeof(hostname), "br-%02x%02x", mac[4], mac[5]);
    ESP_LOGI(TAG, "robot id: ble=%s host=%s", ble_name, hostname);

    camera_init();

    led_init(pins.led);
    flash_init(pins.flash);
    motors_init(&pins);

    // fw-info reflects the cap surface — built once after caps are up;
    // changes (camera profile, pin config) reboot, so a fresh boot
    // rebuilds it. gatt_svr_init reads fw_info_json() lazily on first
    // BLE read, but having it ready before BLE is up is cleaner.
    fw_info_init(&pins);

    ble_host_init(ble_name);
    ota_init();
    telemetry_init();
    wifi_sta_init(hostname);
    http_server_init(ble_name);
    mdns_advertise_init(hostname);
    // WebRTC peer last — websocket client connects asynchronously when
    // WiFi gets an IP. Safe to start before the first GOT_IP event.
    webrtc_peer_init(ble_name);
}
