#include "fw_info.h"

#include <stdio.h>

#include "esp_app_desc.h"
#include "esp_log.h"

#include "camera.h"
#include "flash.h"
#include "led.h"
#include "motors.h"

static const char *TAG = "fw_info";

#define FW_INFO_BUF_SIZE 768
static char s_buf[FW_INFO_BUF_SIZE];

void fw_info_init(const pin_config_t *pins) {
    int o = 0;
    // Pull from esp_app_desc — populated by IDF's build system from
    // `git describe --always` (with `-dirty` suffix on uncommitted
    // changes). Was reading version.h's GIT_SHA macro which only got
    // stamped by CI's `make publish-firmware`, so local flashes always
    // reported a stale SHA to the dashboard.
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

    if (motors_enabled()) {
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            ",{\"name\":\"motors\",\"type\":\"signed-pair\",\"range\":[-100,100],"
            "\"pins\":{\"left\":{\"in1\":%d,\"in2\":%d},"
            "\"right\":{\"in1\":%d,\"in2\":%d}}}",
            pins->motor_l_in1, pins->motor_l_in2,
            pins->motor_r_in1, pins->motor_r_in2);
    }
    if (camera_ready()) {
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            ",{\"name\":\"camera\",\"type\":\"mjpeg-stream\"}");
        // Snapshot is BLE-only and works without WiFi — distinct cap so the
        // dashboard renders it independently of the live-stream card.
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            ",{\"name\":\"snapshot\",\"type\":\"ble-snapshot\"}");
    }
    o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o, "]");
    if (!camera_ready() && camera_init_error() != 0) {
        o += snprintf(s_buf + o, FW_INFO_BUF_SIZE - o,
            ",\"camera_err\":%d", camera_init_error());
    }
    snprintf(s_buf + o, FW_INFO_BUF_SIZE - o, "}");
    ESP_LOGI(TAG, "%s", s_buf);
}

const char *fw_info_json(void) { return s_buf; }
