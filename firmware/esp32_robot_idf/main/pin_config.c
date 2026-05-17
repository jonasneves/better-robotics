#include "pin_config.h"

#include <stdlib.h>
#include <string.h>

#include "sdkconfig.h"
#include "esp_log.h"
#include "nvs.h"

#include "restart_util.h"

static const char *TAG = "pin_config";

bool pin_valid(int pin) { return pin >= 0; }

bool pin_motors_configured(const pin_config_t *cfg) {
    return pin_valid(cfg->motor_l_fwd) && pin_valid(cfg->motor_l_bwd)
        && pin_valid(cfg->motor_r_fwd) && pin_valid(cfg->motor_r_bwd);
}

static int nvs_get_int_default(nvs_handle_t h, const char *key, int dflt) {
    int32_t v;
    return nvs_get_i32(h, key, &v) == ESP_OK ? (int)v : dflt;
}

void pin_config_load(pin_config_t *out) {
#if CONFIG_BR_BOARD_AITHINKER_CAM
    // ESP32-CAM has ~8 user-assignable GPIOs (most SD- or PSRAM-shared)
    // — these four are the only set that doesn't collide with the camera
    // signal lines.
    out->led         = 33;
    out->flash       = 4;
    out->motor_l_fwd = 14;
    out->motor_l_bwd = 15;
    out->motor_r_fwd = 13;
    out->motor_r_bwd = 12;
#elif CONFIG_BR_BOARD_DEVKIT
    // DevKitV1: onboard LED on GPIO 2, no flash LED. Motors picked from
    // four contiguous general-purpose pins between IO4 and IO22 on the
    // left header edge. The 16/17/18/19 numerical order also matches
    // the header's physical top-to-bottom layout for these four, so
    // the pinout dashboard's IN1..IN4 wires run parallel.
    out->led         = 2;
    out->flash       = -1;
    out->motor_l_fwd = 16;
    out->motor_l_bwd = 17;
    out->motor_r_fwd = 18;
    out->motor_r_bwd = 19;
#elif CONFIG_BR_BOARD_C3_SUPERMINI
    // SuperMini onboard LED on GPIO 8 (also a strapping pin, but its
    // purpose on this board is the LED — leaving the LED unwired won't
    // affect boot). Motors from the clean general-purpose set.
    out->led         = 8;
    out->flash       = -1;
    out->motor_l_fwd = 3;
    out->motor_l_bwd = 4;
    out->motor_r_fwd = 5;
    out->motor_r_bwd = 6;
#else
#error "pin_config: no BR_BOARD_* defined — check Kconfig.projbuild"
#endif
    // ENA/ENB default to -1 on every board: firmware drives PWM on the
    // direction pins (legacy mode, what AI-Thinker with factory jumpers
    // wants). User sets these via the dashboard pinout editor to switch
    // to PWM-on-enable mode (matches Pi side's Motor(enable=) behavior).
    out->motor_ena = -1;
    out->motor_enb = -1;
    // Encoders default disabled — picking sensible defaults requires
    // knowing the user's motor driver wiring (encoder OUT pins land
    // wherever the driver leaves them). User picks via dashboard.
    out->enc_l = -1;
    out->enc_r = -1;

    nvs_handle_t h;
    if (nvs_open("pins", NVS_READONLY, &h) != ESP_OK) return;
    out->led         = nvs_get_int_default(h, "led",     out->led);
    out->flash       = nvs_get_int_default(h, "flash",   out->flash);
    out->motor_l_fwd = nvs_get_int_default(h, "m_l_fwd", out->motor_l_fwd);
    out->motor_l_bwd = nvs_get_int_default(h, "m_l_bwd", out->motor_l_bwd);
    out->motor_r_fwd = nvs_get_int_default(h, "m_r_fwd", out->motor_r_fwd);
    out->motor_r_bwd = nvs_get_int_default(h, "m_r_bwd", out->motor_r_bwd);
    out->motor_ena   = nvs_get_int_default(h, "m_ena",   out->motor_ena);
    out->motor_enb   = nvs_get_int_default(h, "m_enb",   out->motor_enb);
    out->enc_l       = nvs_get_int_default(h, "enc_l",   out->enc_l);
    out->enc_r       = nvs_get_int_default(h, "enc_r",   out->enc_r);
    nvs_close(h);
}

// PIN_ABSENT distinguishes "key missing in JSON" from "key explicitly -1".
// Lets the dashboard PATCH a single pin without re-sending the whole map.
static const int PIN_ABSENT = -32768;

// Tiny extractor — no JSON library so we don't pay for cJSON on a
// one-off write surface.
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

// Forbidden set: pins where wiring something else physically prevents
// the firmware from running (camera signal lines on AI-Thinker, SPI
// flash pins on all boards). Strapping pins, UART, USB pins are
// recoverable — they live in a dashboard-side warning tier, not here.
// See CLAUDE.md's panda pattern: firmware enforces the irreversible
// floor, dashboard handles the educational layer.
#if CONFIG_BR_BOARD_AITHINKER_CAM
static const int PINS_FORBIDDEN[] = { 0, 5, 18, 19, 21, 22, 23, 25, 26, 27, 32, 34, 35, 36, 39 };
#elif CONFIG_BR_BOARD_DEVKIT
static const int PINS_FORBIDDEN[] = { 6, 7, 8, 9, 10, 11 };
#elif CONFIG_BR_BOARD_C3_SUPERMINI
static const int PINS_FORBIDDEN[] = { 11, 12, 13, 14, 15, 16, 17 };
#endif

#if CONFIG_IDF_TARGET_ESP32
#define PIN_MAX 39
#elif CONFIG_IDF_TARGET_ESP32C3
#define PIN_MAX 21
#else
#error "pin_config: unknown IDF target — add PIN_MAX"
#endif

static bool pin_is_forbidden(int p) {
    for (size_t i = 0; i < sizeof(PINS_FORBIDDEN) / sizeof(PINS_FORBIDDEN[0]); i++) {
        if (p == PINS_FORBIDDEN[i]) return true;
    }
    return false;
}

void pin_config_handle_write(const uint8_t *json_bytes, size_t len) {
    const char *json = (const char *)json_bytes;
    int led    = extract_int_key(json, len, "led");
    int flash  = extract_int_key(json, len, "flash");
    int l_fwd  = extract_int_key(json, len, "m_l_fwd");
    int l_bwd  = extract_int_key(json, len, "m_l_bwd");
    int r_fwd  = extract_int_key(json, len, "m_r_fwd");
    int r_bwd  = extract_int_key(json, len, "m_r_bwd");
    int m_ena  = extract_int_key(json, len, "m_ena");
    int m_enb  = extract_int_key(json, len, "m_enb");
    int enc_l  = extract_int_key(json, len, "enc_l");
    int enc_r  = extract_int_key(json, len, "enc_r");

    int candidates[10] = { led, flash, l_fwd, l_bwd, r_fwd, r_bwd, m_ena, m_enb, enc_l, enc_r };
    for (int i = 0; i < 10; i++) {
        int p = candidates[i];
        if (p == PIN_ABSENT || p == -1) continue;
        if (p < 0 || p > PIN_MAX) {
            ESP_LOGW(TAG, "pin %d out of range, ignored", p);
            return;
        }
        if (pin_is_forbidden(p)) {
            ESP_LOGW(TAG, "GPIO %d is board-forbidden, ignored", p);
            return;
        }
        for (int j = i + 1; j < 10; j++) {
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
    if (l_fwd  != PIN_ABSENT) nvs_set_i32(h, "m_l_fwd", l_fwd);
    if (l_bwd  != PIN_ABSENT) nvs_set_i32(h, "m_l_bwd", l_bwd);
    if (r_fwd  != PIN_ABSENT) nvs_set_i32(h, "m_r_fwd", r_fwd);
    if (r_bwd  != PIN_ABSENT) nvs_set_i32(h, "m_r_bwd", r_bwd);
    if (m_ena  != PIN_ABSENT) nvs_set_i32(h, "m_ena",   m_ena);
    if (m_enb  != PIN_ABSENT) nvs_set_i32(h, "m_enb",   m_enb);
    if (enc_l  != PIN_ABSENT) nvs_set_i32(h, "enc_l",   enc_l);
    if (enc_r  != PIN_ABSENT) nvs_set_i32(h, "enc_r",   enc_r);
    nvs_commit(h);
    nvs_close(h);

    ESP_LOGI(TAG, "saved (led=%d flash=%d L=%d/%d R=%d/%d ena=%d enb=%d enc=%d/%d)",
             led, flash, l_fwd, l_bwd, r_fwd, r_bwd, m_ena, m_enb, enc_l, enc_r);
    schedule_restart(500);
}
