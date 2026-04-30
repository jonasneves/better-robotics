#include "telemetry.h"

#include <stdio.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"

#include "gatt_svr.h"
#include "turn_creds.h"
#include "version.h"

static const char *TAG = "telemetry";

#define TELEMETRY_BUF_SIZE   384
#define INTERVAL_US          (10ULL * 1000 * 1000)

static char s_buf[TELEMETRY_BUF_SIZE] = "{}";
static esp_timer_handle_t s_timer;

const char *telemetry_json(void) { return s_buf; }

static const char *reset_reason_label(esp_reset_reason_t r) {
    switch (r) {
        case ESP_RST_POWERON:   return "poweron";
        case ESP_RST_EXT:       return "ext";
        case ESP_RST_SW:        return "sw";
        case ESP_RST_PANIC:     return "panic";
        case ESP_RST_INT_WDT:   return "int-wdt";
        case ESP_RST_TASK_WDT:  return "task-wdt";
        case ESP_RST_WDT:       return "wdt";
        case ESP_RST_DEEPSLEEP: return "deepsleep";
        case ESP_RST_BROWNOUT:  return "brownout";
        case ESP_RST_SDIO:      return "sdio";
        default:                return "unknown";
    }
}

static void on_tick(void *arg) {
    char ip[16] = {0};
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif) {
        esp_netif_ip_info_t info;
        if (esp_netif_get_ip_info(netif, &info) == ESP_OK && info.ip.addr != 0) {
            snprintf(ip, sizeof(ip), IPSTR, IP2STR(&info.ip));
        }
    }
    int o = snprintf(s_buf, TELEMETRY_BUF_SIZE,
        "{\"uptime_ms\":%llu,\"free_heap\":%u,\"min_free_heap\":%u,"
        "\"free_psram\":%u,\"reset_reason\":\"%s\",\"sha\":\"%s\"",
        esp_timer_get_time() / 1000ULL,
        (unsigned)esp_get_free_heap_size(),
        (unsigned)esp_get_minimum_free_heap_size(),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
        reset_reason_label(esp_reset_reason()),
        GIT_SHA);
    if (ip[0]) o += snprintf(s_buf + o, TELEMETRY_BUF_SIZE - o, ",\"ip\":\"%s\"", ip);
    // TURN status surfaces what turn_creds has cached without needing a serial
    // monitor. "ready" = creds + pre-resolved IP both present; webrtc_peer can
    // populate libpeer's TURN entry. "creds" = creds only, DNS pre-resolve
    // failed. "none" = nothing fetched yet.
    const char *turn_url  = turn_creds_url();
    const char *turn_user = turn_creds_username();
    const char *turn_err  = turn_creds_last_error();
    if (turn_url && turn_user) {
        o += snprintf(s_buf + o, TELEMETRY_BUF_SIZE - o,
                      ",\"turn\":\"ready\",\"turn_url\":\"%s\"", turn_url);
    } else if (turn_user) {
        o += snprintf(s_buf + o, TELEMETRY_BUF_SIZE - o, ",\"turn\":\"creds\"");
    } else {
        o += snprintf(s_buf + o, TELEMETRY_BUF_SIZE - o, ",\"turn\":\"none\"");
    }
    if (turn_err && turn_err[0]) {
        o += snprintf(s_buf + o, TELEMETRY_BUF_SIZE - o, ",\"turn_err\":\"%s\"", turn_err);
    }
    snprintf(s_buf + o, TELEMETRY_BUF_SIZE - o, "}");
    gatt_svr_notify_telemetry();
}

void telemetry_init(void) {
    esp_timer_create_args_t a = { .callback = on_tick, .name = "telemetry" };
    if (esp_timer_create(&a, &s_timer) != ESP_OK) {
        ESP_LOGE(TAG, "timer create failed");
        return;
    }
    on_tick(NULL);  // populate the initial value so first BLE read isn't "{}".
    esp_timer_start_periodic(s_timer, INTERVAL_US);
}
