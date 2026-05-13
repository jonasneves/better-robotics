#include <stdio.h>

#include "esp_log.h"
#include "esp_mac.h"
#include "nvs_flash.h"

#include "ble_host.h"
#include "camera.h"
#include "flash.h"
#include "fw_info.h"
#include "http_stream.h"
#include "led.h"
#include "motors.h"
#include "ota.h"
#include "pin_config.h"
#include "telemetry.h"
#include "webrtc_peer.h"
#include "wifi_sta.h"

static const char *TAG = "esp32_robot";

// Connection-first init (CLAUDE.md), but on classic ESP32-CAM the camera
// must allocate its 32 KB DMA buffer in fresh internal heap (PSRAM isn't
// DMA-coherent on this chip). Allocation order:
//
//   1. NVS              (per-key persistence for pin / wifi / cam)
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

void app_main(void) {
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    pin_config_t pins;
    pin_config_load(&pins);

    // Stable per-chip suffix — low 16 bits of the WiFi MAC. Identity must
    // not change across reflashes or paired robots in localStorage break.
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    char ble_name[16];
    char hostname[32];
    snprintf(ble_name, sizeof(ble_name), "BR-%02X%02X", mac[4], mac[5]);
    snprintf(hostname, sizeof(hostname), "br-%02x%02x", mac[4], mac[5]);
    ESP_LOGI(TAG, "robot id: ble=%s host=%s", ble_name, hostname);

    camera_probe();

    led_init(pins.led);
    flash_init(pins.flash);
    motors_init(&pins);

    // fw-info reflects the cap surface; built once after caps are up.
    // Changes (camera profile, pin config) reboot, so a fresh boot
    // rebuilds it.
    fw_info_init(&pins);

    ble_host_init(ble_name);
    ota_init();
    telemetry_init();
    wifi_sta_init(hostname);
    // ICE servers (TURN creds + STUN/TURN URLs) come pre-resolved from the
    // dashboard via BLE — chip no longer fetches proxy.neevs.io itself,
    // freeing flash + dropping the multi-second mbedTLS-during-coex stall.
    webrtc_peer_init(ble_name);
    // Side-by-side HTTP MJPEG for benchmarking against WebRTC. Always-on
    // (one listen socket idle cost); dashboard "Try HTTP" opens
    // http://<ip>:81/stream.
    http_stream_init();
}
