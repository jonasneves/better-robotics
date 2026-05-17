#include "fw_info.h"

#include <stdio.h>

#include "sdkconfig.h"
#include "esp_app_desc.h"
#include "esp_log.h"

#include "camera.h"
#include "encoders.h"
#include "flash.h"
#include "led.h"
#include "motors.h"

static const char *TAG = "fw_info";

// Three identifiers reported to the dashboard:
//   chip    — IDF target. Binary-compat constraint; what esptool checks.
//   board   — hardware variant. Pin-map constraint; drives the visual
//             pin editor and the dashboard's board-aware UI.
//   variant — board + feature toggle. Disambiguates the OTA bundle so
//             self-OTA preserves the user's WebRTC choice.
#if CONFIG_IDF_TARGET_ESP32
#  define BR_CHIP_STR "esp32"
#elif CONFIG_IDF_TARGET_ESP32C3
#  define BR_CHIP_STR "esp32c3"
#else
#  error "fw_info: unknown IDF target"
#endif

#if CONFIG_BR_BOARD_AITHINKER_CAM
#  define BR_BOARD_STR "aithinker_cam"
#  if CONFIG_BR_WEBRTC_ESP_PEER
#    define BR_VARIANT_STR "aithinker_cam_webrtc"
#  else
#    define BR_VARIANT_STR "aithinker_cam"
#  endif
#elif CONFIG_BR_BOARD_DEVKIT
#  define BR_BOARD_STR   "devkit"
#  define BR_VARIANT_STR "devkit"
#elif CONFIG_BR_BOARD_C3_SUPERMINI
#  define BR_BOARD_STR   "c3_supermini"
#  define BR_VARIANT_STR "c3_supermini"
#else
#  error "fw_info: no BR_BOARD_* defined"
#endif

#define FW_INFO_BUF_SIZE 768
static char s_buf[FW_INFO_BUF_SIZE];

void fw_info_init(const pin_config_t *pins) {
    int o = 0;
    // esp_app_desc is populated by IDF from `git describe --always`
    // (with `-dirty` suffix on uncommitted changes) at every build,
    // so local flashes report an accurate SHA without a CI stamp step.
    const char *version = esp_app_get_description()->version;
    o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
        "{\"type\":\"esp32\","                  // hardware-class id, stable across chip families
        "\"chip\":\"" BR_CHIP_STR "\","         // esptool-visible identity (binary-compat)
        "\"board\":\"" BR_BOARD_STR "\","       // pin-map identity (UI editor)
        // webrtc: build-time toggle for the libpeer + DTLS-SRTP path.
        // Dashboard reads this to gate its transport selector; MJPEG-only
        // builds shouldn't offer a WebRTC option that will fail at the
        // signal-characteristic probe.
#if CONFIG_BR_WEBRTC_ESP_PEER
        "\"webrtc\":true,"
#else
        "\"webrtc\":false,"
#endif
        "\"url\":\"firmware/bins/" BR_VARIANT_STR "/firmware.bin\","
        "\"version\":\"%s\",\"caps\":[", version);

    bool first = true;
    if (led_enabled()) {
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            "%s{\"name\":\"led\",\"type\":\"toggle\",\"pin\":%d}",
            first ? "" : ",", pins->led);
        first = false;
    }
    if (flash_enabled()) {
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            "%s{\"name\":\"flash\",\"type\":\"level\",\"range\":[0,100],\"pin\":%d}",
            first ? "" : ",", pins->flash);
        first = false;
    }
    // WiFi has no pin config and stays unconditional.
    o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
        "%s{\"name\":\"wifi\",\"type\":\"wifi-scan\"}", first ? "" : ",");
    first = false;

    if (motors_enabled()) {
        // Schema matches gpiozero Motor() on the Pi side — `enable` is
        // optional and only present when wired. When omitted the chip is
        // running in PWM-on-direction mode (ENA/ENB tied HIGH externally,
        // factory jumpers on the L298N). Present means PWM-on-enable
        // mode with the chip driving speed via the enable line.
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            ",{\"name\":\"motors\",\"type\":\"signed-pair\",\"range\":[-100,100],"
            "\"pins\":{\"left\":{\"forward\":%d,\"backward\":%d",
            pins->motor_l_fwd, pins->motor_l_bwd);
        if (pins->motor_ena >= 0)
            o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o, ",\"enable\":%d", pins->motor_ena);
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            "},\"right\":{\"forward\":%d,\"backward\":%d",
            pins->motor_r_fwd, pins->motor_r_bwd);
        if (pins->motor_enb >= 0)
            o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o, ",\"enable\":%d", pins->motor_enb);
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o, "}}}");
    }
    // tick-count cap has no dashboard runtime (yet) — RUNTIMES[type]
    // falls through to no-op; claimsFromEntry still picks up `pins` for
    // the pinout view. Ticks reach the dashboard via telemetry.
    if (encoders_enabled()) {
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            ",{\"name\":\"encoders\",\"type\":\"tick-count\","
            "\"pins\":{\"left\":%d,\"right\":%d}}",
            pins->enc_l, pins->enc_r);
    }
    if (camera_present()) {
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            ",{\"name\":\"camera\",\"type\":\"mjpeg-stream\"}");
        // Snapshot is BLE-only and works without WiFi — distinct cap so the
        // dashboard renders it independently of the live-stream card.
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            ",{\"name\":\"snapshot\",\"type\":\"ble-snapshot\"}");
    }
    o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o, "]");
    if (!camera_present() && camera_init_error() != 0) {
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            ",\"camera_err\":%d", camera_init_error());
    }
    snprintf(s_buf + o, FW_INFO_BUF_SIZE - o, "}");
    ESP_LOGI(TAG, "%s", s_buf);
}

const char *fw_info_json(void) { return s_buf; }
