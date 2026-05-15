#include "telemetry.h"

#include <stdio.h>

#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"

#include "host/ble_hs.h"

#include "ble_host.h"
#include "gatt_svr.h"
#include "webrtc_peer.h"

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
    // Skip notifies while video is streaming. Each telemetry notify
    // bursts ~250 B over BLE, and during active streaming it competes
    // with WiFi for radio time — observed as "wifi:m f null" mgmt-frame
    // drops. Resume cadence resumes the moment video stops.
    if (webrtc_peer_video_active()) return;
    char ip[16] = {0};
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif) {
        esp_netif_ip_info_t info;
        if (esp_netif_get_ip_info(netif, &info) == ESP_OK && info.ip.addr != 0) {
            snprintf(ip, sizeof(ip), IPSTR, IP2STR(&info.ip));
        }
    }
    // free_heap_internal / min_free_heap_internal split out internal SRAM
    // from the SPIRAM-augmented total. WebRTC esp_peer_open and DTLS/SCTP
    // buffers allocate from internal heap only; if the chip shows 4 MB free
    // overall but internal-min has hit ~20 KB, esp_peer_open returns
    // ESP_PEER_ERR_NO_MEM and the total number is misleading.
    int o = snprintf(s_buf, TELEMETRY_BUF_SIZE,
        "{\"uptime_ms\":%llu,\"free_heap\":%u,\"min_free_heap\":%u,"
        "\"free_heap_internal\":%u,\"min_free_heap_internal\":%u,"
        "\"free_psram\":%u,\"reset_reason\":\"%s\",\"sha\":\"%s\"",
        esp_timer_get_time() / 1000ULL,
        (unsigned)esp_get_free_heap_size(),
        (unsigned)esp_get_minimum_free_heap_size(),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
        reset_reason_label(esp_reset_reason()),
        esp_app_get_description()->version);
    if (ip[0]) o += snprintf(s_buf + o, TELEMETRY_BUF_SIZE - o, ",\"ip\":\"%s\"", ip);
    // RSSI of the currently-bonded central. Dashboard's primary-row chip
    // surfaces a "Weak signal" warning when this dips below -75 dBm.
    uint16_t conn = ble_host_active_conn();
    int8_t rssi;
    if (conn != BLE_HS_CONN_HANDLE_NONE && ble_gap_conn_rssi(conn, &rssi) == 0) {
        o += snprintf(s_buf + o, TELEMETRY_BUF_SIZE - o, ",\"rssi_dbm\":%d", (int)rssi);
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
