#include "fw_info.h"

#include <stdio.h>

#include "esp_app_desc.h"
#include "esp_log.h"

#include "camera.h"
#include "flash.h"
#include "led.h"
#include "motors.h"
#if CONFIG_BALANCE_BOT_ENABLED
#include "balance.h"
#endif

static const char *TAG = "fw_info";

#define FW_INFO_BUF_SIZE 768
static char s_buf[FW_INFO_BUF_SIZE];

void fw_info_init(const pin_config_t *pins) {
    int o = 0;
    // esp_app_desc is populated by IDF from `git describe --always`
    // (with `-dirty` suffix on uncommitted changes) at every build,
    // so local flashes report an accurate SHA without a CI stamp step.
    const char *version = esp_app_get_description()->version;
    o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
        "{\"type\":\"esp32\",\"url\":\"firmware/bins/esp32_robot.bin\","
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

#if CONFIG_BALANCE_BOT_ENABLED
    if (balance_enabled()) {
        // Balance bot: advertise "balance-bot" instead of raw motor access.
        // The four BALANCE_* characteristics handle control; MOTOR_CHAR
        // stays in the GATT table for status reads but isn't a user-facing cap.
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            ",{\"name\":\"balance-bot\",\"type\":\"balance-bot\"}");
    } else if (motors_enabled()) {
        // IMU init failed — degrade gracefully to plain motor control.
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            ",{\"name\":\"motors\",\"type\":\"signed-pair\",\"range\":[-100,100],"
            "\"pins\":{\"left\":{\"forward\":%d,\"backward\":%d},"
            "\"right\":{\"forward\":%d,\"backward\":%d}}}",
            pins->motor_l_fwd, pins->motor_l_bwd,
            pins->motor_r_fwd, pins->motor_r_bwd);
    }
#else
    if (motors_enabled()) {
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            ",{\"name\":\"motors\",\"type\":\"signed-pair\",\"range\":[-100,100],"
            "\"pins\":{\"left\":{\"forward\":%d,\"backward\":%d},"
            "\"right\":{\"forward\":%d,\"backward\":%d}}}",
            pins->motor_l_fwd, pins->motor_l_bwd,
            pins->motor_r_fwd, pins->motor_r_bwd);
    }
#endif
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
