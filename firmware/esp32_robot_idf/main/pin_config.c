#include "pin_config.h"

#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "nvs.h"

static const char *TAG = "pin_config";

bool pin_valid(int pin) { return pin >= 0; }

bool pin_motors_configured(const pin_config_t *cfg) {
    return pin_valid(cfg->motor_l_in1) && pin_valid(cfg->motor_l_in2)
        && pin_valid(cfg->motor_r_in1) && pin_valid(cfg->motor_r_in2);
}

static int nvs_get_int_default(nvs_handle_t h, const char *key, int dflt) {
    int32_t v;
    return nvs_get_i32(h, key, &v) == ESP_OK ? (int)v : dflt;
}

void pin_config_load(pin_config_t *out) {
    out->led         = 33;
    out->flash       = 4;
    out->motor_l_in1 = 14;
    out->motor_l_in2 = 15;
    out->motor_r_in1 = 13;
    out->motor_r_in2 = 12;

    nvs_handle_t h;
    if (nvs_open("pins", NVS_READONLY, &h) != ESP_OK) return;
    out->led         = nvs_get_int_default(h, "led",     out->led);
    out->flash       = nvs_get_int_default(h, "flash",   out->flash);
    out->motor_l_in1 = nvs_get_int_default(h, "m_l_in1", out->motor_l_in1);
    out->motor_l_in2 = nvs_get_int_default(h, "m_l_in2", out->motor_l_in2);
    out->motor_r_in1 = nvs_get_int_default(h, "m_r_in1", out->motor_r_in1);
    out->motor_r_in2 = nvs_get_int_default(h, "m_r_in2", out->motor_r_in2);
    nvs_close(h);
}

// PIN_ABSENT distinguishes "key missing in JSON" from "key explicitly -1".
// Lets the dashboard PATCH a single pin without re-sending the whole map.
static const int PIN_ABSENT = -32768;

// Tiny extractor — same logic as the .ino's extractIntKey, no JSON
// library so we don't pay for cJSON on a one-off write surface.
static int extract_int_key(const char *json, size_t len, const char *key) {
    char needle[32];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char *p = NULL;
    for (size_t i = 0; i + strlen(needle) <= len; i++) {
        if (memcmp(json + i, needle, strlen(needle)) == 0) { p = json + i; break; }
    }
    if (!p) return PIN_ABSENT;
    p = memchr(p, ':', len - (p - json));
    if (!p) return PIN_ABSENT;
    p++;
    while (p < json + len && (*p == ' ' || *p == '\t')) p++;
    bool neg = false;
    if (p < json + len && *p == '-') { neg = true; p++; }
    int v = 0;
    bool any = false;
    while (p < json + len && *p >= '0' && *p <= '9') {
        v = v * 10 + (*p - '0');
        p++;
        any = true;
    }
    if (!any) return PIN_ABSENT;
    return neg ? -v : v;
}

// AI-Thinker fixed camera pin map. Changing camera pins requires a code
// change, not a config change, so baking the reserved set in is fine.
static const int CAMERA_RESERVED[] = { 0, 5, 18, 19, 21, 22, 23, 25, 26, 27, 32, 34, 35, 36, 39 };

static bool pin_in_reserved(int p) {
    for (size_t i = 0; i < sizeof(CAMERA_RESERVED) / sizeof(CAMERA_RESERVED[0]); i++) {
        if (p == CAMERA_RESERVED[i]) return true;
    }
    return false;
}

static void deferred_restart(void *arg) {
    ESP_LOGI(TAG, "applying new pin config — restart");
    esp_restart();
}

void pin_config_handle_write(const uint8_t *json_bytes, size_t len) {
    const char *json = (const char *)json_bytes;
    int led    = extract_int_key(json, len, "led");
    int flash  = extract_int_key(json, len, "flash");
    int l_in1  = extract_int_key(json, len, "m_l_in1");
    int l_in2  = extract_int_key(json, len, "m_l_in2");
    int r_in1  = extract_int_key(json, len, "m_r_in1");
    int r_in2  = extract_int_key(json, len, "m_r_in2");

    int candidates[6] = { led, flash, l_in1, l_in2, r_in1, r_in2 };
    for (int i = 0; i < 6; i++) {
        int p = candidates[i];
        if (p == PIN_ABSENT || p == -1) continue;
        if (p < 0 || p > 39) {
            ESP_LOGW(TAG, "pin %d out of range, ignored", p);
            return;
        }
        if (pin_in_reserved(p)) {
            ESP_LOGW(TAG, "GPIO %d is camera-reserved, ignored", p);
            return;
        }
        for (int j = i + 1; j < 6; j++) {
            if (candidates[j] == p) {
                ESP_LOGW(TAG, "GPIO %d assigned twice, ignored", p);
                return;
            }
        }
    }

    nvs_handle_t h;
    if (nvs_open("pins", NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open failed");
        return;
    }
    if (led    != PIN_ABSENT) nvs_set_i32(h, "led",     led);
    if (flash  != PIN_ABSENT) nvs_set_i32(h, "flash",   flash);
    if (l_in1  != PIN_ABSENT) nvs_set_i32(h, "m_l_in1", l_in1);
    if (l_in2  != PIN_ABSENT) nvs_set_i32(h, "m_l_in2", l_in2);
    if (r_in1  != PIN_ABSENT) nvs_set_i32(h, "m_r_in1", r_in1);
    if (r_in2  != PIN_ABSENT) nvs_set_i32(h, "m_r_in2", r_in2);
    nvs_commit(h);
    nvs_close(h);

    ESP_LOGI(TAG, "saved (led=%d flash=%d L=%d/%d R=%d/%d)",
             led, flash, l_in1, l_in2, r_in1, r_in2);

    // Defer the restart so the BLE ATT response for this write reaches
    // the dashboard before we drop the connection. Same reason the .ino
    // sets pinConfigRestartPending and reboots from loop().
    esp_timer_create_args_t args = {
        .callback = deferred_restart,
        .name = "pin_restart",
    };
    esp_timer_handle_t t;
    esp_timer_create(&args, &t);
    esp_timer_start_once(t, 500 * 1000);
}
