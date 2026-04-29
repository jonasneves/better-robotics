#include <stdio.h>

#include "esp_log.h"
#include "esp_mac.h"
#include "nvs_flash.h"

#include "ble_host.h"
#include "flash.h"
#include "led.h"
#include "mdns_advertise.h"
#include "motors.h"
#include "pin_config.h"
#include "wifi_sta.h"

static const char *TAG = "esp32_robot";

// Init order tracks the .ino's allocation rationale (CLAUDE.md
// "connection-first init"): NVS → WiFi → caps → BLE → mDNS. Camera +
// HTTP server come in 2.C.4; WebRTC peer in 2.D.
//
// On classic ESP32-CAM, BLE+WiFi+camera compete for ~250 KB DRAM. The
// .ino bound camera before BLE so its DMA buffer lands in fresh internal
// heap. Once camera_init joins (2.C.4), this order moves it ahead of
// BLE here too.

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
    // the .ino so paired robots in localStorage keep matching after the
    // cutover. BLE name uppercases; the mDNS / hostname form lowercases
    // for `<name>.local` lookups.
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    char ble_name[16];
    char hostname[32];
    snprintf(ble_name, sizeof(ble_name), "BR-%02X%02X", mac[4], mac[5]);
    snprintf(hostname, sizeof(hostname), "br-%02x%02x", mac[4], mac[5]);
    ESP_LOGI(TAG, "robot id: ble=%s host=%s", ble_name, hostname);

    wifi_sta_init(hostname);

    // Capability hardware init — gated on pin validity. Each module
    // tolerates -1 by skipping hardware setup, so a chassis with no
    // motors / no flash boots clean.
    led_init(pins.led);
    flash_init(pins.flash);
    motors_init(&pins);

    // BLE last among the radios so the GATT service table is registered
    // and ready before any central can connect. gatt_svr_init runs inside
    // ble_host_init in the right order relative to the host stack.
    ble_host_init(ble_name);
    mdns_advertise_init(hostname);
}
