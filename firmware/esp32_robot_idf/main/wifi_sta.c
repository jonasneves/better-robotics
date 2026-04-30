#include "wifi_sta.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs.h"

#include "gatt_svr.h"

static const char *TAG = "wifi_sta";

#define SCAN_MAX            10
#define JOIN_TIMEOUT_MS     20000
#define STATUS_BUF_SIZE     192
#define SCAN_BUF_SIZE       1280

static bool s_has_ip = false;
static bool s_attempting_join = false;
static char s_pending_ssid[33];
static char s_pending_pass[65];
static esp_timer_handle_t s_join_timeout_timer;

static char s_status_json[STATUS_BUF_SIZE] = "{\"st\":\"idle\"}";
static char s_scan_json[SCAN_BUF_SIZE]     = "[]";

bool wifi_sta_has_ip(void) { return s_has_ip; }
const char *wifi_sta_status_json(void) { return s_status_json; }
const char *wifi_sta_scan_json(void) { return s_scan_json; }

// JSON string escape — matches the .ino's jsonEscape: handle quote +
// backslash + newline + carriage return; drop other control chars so
// stray bytes from a misbehaving AP can't break the dashboard's parser.
static size_t json_escape(char *out, size_t out_size, const char *s) {
    size_t o = 0;
    for (size_t i = 0; s[i] && o + 3 < out_size; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == '"' || c == '\\') { out[o++] = '\\'; out[o++] = c; }
        else if (c == '\n')        { out[o++] = '\\'; out[o++] = 'n'; }
        else if (c == '\r')        { out[o++] = '\\'; out[o++] = 'r'; }
        else if (c < 0x20)         { /* drop */ }
        else                       { out[o++] = c; }
    }
    out[o] = 0;
    return o;
}

// Map -100..-50 dBm → 0..100 strength (matches .ino's rssiToStrength).
static int rssi_to_strength(int rssi) {
    int s = (rssi + 100) * 2;
    if (s < 0) return 0;
    if (s > 100) return 100;
    return s;
}

static void publish_status(const char *st, const char *ssid, const char *err, const char *ip) {
    char esc_ssid[80] = {0};
    char esc_err[80] = {0};
    if (ssid) json_escape(esc_ssid, sizeof(esc_ssid), ssid);
    if (err)  json_escape(esc_err,  sizeof(esc_err),  err);

    int n = snprintf(s_status_json, STATUS_BUF_SIZE, "{\"st\":\"%s\"", st);
    if (ssid && esc_ssid[0]) n += snprintf(s_status_json + n, STATUS_BUF_SIZE - n, ",\"ssid\":\"%s\"", esc_ssid);
    if (err  && esc_err[0])  n += snprintf(s_status_json + n, STATUS_BUF_SIZE - n, ",\"err\":\"%s\"", esc_err);
    if (ip   && ip[0])       n += snprintf(s_status_json + n, STATUS_BUF_SIZE - n, ",\"ip\":\"%s\"", ip);
    snprintf(s_status_json + n, STATUS_BUF_SIZE - n, "}");

    ESP_LOGI(TAG, "status → %s", s_status_json);
    gatt_svr_notify_wifi_status();
}

// Sort-then-dedupe scan records by RSSI, format up to SCAN_MAX into JSON.
static int cmp_rssi_desc(const void *a, const void *b) {
    int ra = ((const wifi_ap_record_t *)a)->rssi;
    int rb = ((const wifi_ap_record_t *)b)->rssi;
    return rb - ra;
}

static void publish_scan(void) {
    uint16_t n = 0;
    esp_wifi_scan_get_ap_num(&n);
    if (n == 0) {
        snprintf(s_scan_json, SCAN_BUF_SIZE, "[]");
        gatt_svr_notify_wifi_scan();
        return;
    }
    if (n > 32) n = 32;
    wifi_ap_record_t *records = calloc(n, sizeof(*records));
    if (!records) {
        ESP_LOGE(TAG, "scan calloc failed");
        return;
    }
    esp_wifi_scan_get_ap_records(&n, records);
    qsort(records, n, sizeof(*records), cmp_rssi_desc);

    int o = snprintf(s_scan_json, SCAN_BUF_SIZE, "[");
    int emitted = 0;
    for (int i = 0; i < n && emitted < SCAN_MAX; i++) {
        const char *ssid = (const char *)records[i].ssid;
        if (ssid[0] == 0) continue;
        // Dedupe by SSID against already-emitted entries — APs with
        // multiple radios show up twice in the scan otherwise.
        bool dup = false;
        for (int j = 0; j < i; j++) {
            if (strncmp(ssid, (const char *)records[j].ssid, 33) == 0) { dup = true; break; }
        }
        if (dup) continue;
        char esc[80];
        json_escape(esc, sizeof(esc), ssid);
        int strength = rssi_to_strength(records[i].rssi);
        int secured = (records[i].authmode == WIFI_AUTH_OPEN) ? 0 : 1;
        o += snprintf(s_scan_json + o, SCAN_BUF_SIZE - o,
                      "%s{\"s\":\"%s\",\"r\":%d,\"p\":%d}",
                      emitted ? "," : "", esc, strength, secured);
        emitted++;
    }
    snprintf(s_scan_json + o, SCAN_BUF_SIZE - o, "]");
    free(records);
    ESP_LOGI(TAG, "scan complete: %d entries", emitted);
    gatt_svr_notify_wifi_scan();
}

static void persist_creds(const char *ssid, const char *pass) {
    nvs_handle_t h;
    if (nvs_open("wifi", NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_str(h, "ssid", ssid);
    nvs_set_str(h, "pass", pass);
    nvs_commit(h);
    nvs_close(h);
}

static const char *disconnect_reason_label(uint8_t r) {
    switch (r) {
        case WIFI_REASON_NO_AP_FOUND:        return "ssid not found";
        case WIFI_REASON_AUTH_FAIL:
        case WIFI_REASON_AUTH_EXPIRE:
        case WIFI_REASON_HANDSHAKE_TIMEOUT:  return "auth failed";
        case WIFI_REASON_ASSOC_FAIL:         return "assoc failed";
        default:                             return "connect failed";
    }
}

static void on_join_timeout(void *arg) {
    if (!s_attempting_join) return;
    s_attempting_join = false;
    esp_wifi_disconnect();
    publish_status("failed", s_pending_ssid, "timeout", NULL);
}

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_has_ip = false;
        wifi_event_sta_disconnected_t *ev = (wifi_event_sta_disconnected_t *)data;
        if (s_attempting_join) {
            s_attempting_join = false;
            esp_timer_stop(s_join_timeout_timer);
            publish_status("failed", s_pending_ssid, disconnect_reason_label(ev->reason), NULL);
            // Don't auto-reconnect after a failed fresh join — wait for
            // the dashboard to issue a new join. Otherwise we'd loop on
            // bad creds and keep pumping "reconnecting" notifications.
            return;
        }
        ESP_LOGW(TAG, "disconnected reason=%d, retrying", ev->reason);
        publish_status("reconnecting", s_pending_ssid, NULL, NULL);
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        publish_scan();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *ev = (ip_event_got_ip_t *)data;
        s_has_ip = true;
        char ip[16];
        snprintf(ip, sizeof(ip), IPSTR, IP2STR(&ev->ip_info.ip));
        ESP_LOGI(TAG, "got ip %s", ip);
        if (s_attempting_join) {
            s_attempting_join = false;
            esp_timer_stop(s_join_timeout_timer);
            // Persist only AFTER the join succeeded — same shape as the
            // .ino's PHASE_JOINING success path. Avoids saving a bad
            // password that would loop on next boot.
            persist_creds(s_pending_ssid, s_pending_pass);
        }
        publish_status("joined", s_pending_ssid, NULL, ip);
    }
}

void wifi_sta_scan_start(void) {
    // Stop any in-flight scan first. Without this a re-entrant scan_start
    // returns ESP_ERR_WIFI_STATE and silently fails — dashboard waits the
    // full 30s timeout for a notify that never comes. Stop is a no-op if
    // nothing is running.
    esp_wifi_scan_stop();

    wifi_scan_config_t cfg = {
        .ssid = NULL,
        .bssid = NULL,
        .channel = 0,
        .show_hidden = false,
        // Passive scan with a longer dwell — same reasoning as the .ino:
        // BLE coex aggressively drops active probe responses on classic
        // ESP32, so beacon-only listening is more reliable.
        .scan_type = WIFI_SCAN_TYPE_PASSIVE,
        .scan_time = { .passive = 500 },
    };
    esp_err_t rc = esp_wifi_scan_start(&cfg, false);
    if (rc != ESP_OK) {
        ESP_LOGW(TAG, "scan_start rc=0x%x; publishing empty so dashboard breaks out of spinner", rc);
        // Surface the failure as an empty list. The dashboard's auto-retry
        // will trigger another scan after a short delay, by which point
        // the radio has usually settled (common after a failed join).
        snprintf(s_scan_json, SCAN_BUF_SIZE, "[]");
        gatt_svr_notify_wifi_scan();
    }
}

// Tiny string-key extractor — matches the .ino's pattern. Returns true
// if the key was found and copied into out. JSON values must be
// double-quoted; embedded backslash-escapes are handled minimally
// (\\ and \" stay as one char in the value).
static bool extract_str_key(const char *json, size_t len, const char *key,
                             char *out, size_t out_size) {
    char needle[16];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    size_t nlen = strlen(needle);
    const char *p = NULL;
    for (size_t i = 0; i + nlen <= len; i++) {
        if (memcmp(json + i, needle, nlen) == 0) { p = json + i + nlen; break; }
    }
    if (!p) return false;
    while (p < json + len && (*p == ' ' || *p == '\t' || *p == ':')) p++;
    if (p >= json + len || *p != '"') return false;
    p++;
    size_t o = 0;
    while (p < json + len && *p != '"' && o + 1 < out_size) {
        if (*p == '\\' && p + 1 < json + len) {
            char c = p[1];
            out[o++] = (c == 'n') ? '\n' : (c == 'r') ? '\r' : c;
            p += 2;
        } else {
            out[o++] = *p++;
        }
    }
    out[o] = 0;
    return true;
}

void wifi_sta_handle_join_write(const uint8_t *json, size_t len) {
    char ssid[33] = {0};
    char pass[65] = {0};
    if (!extract_str_key((const char *)json, len, "s", ssid, sizeof(ssid))) {
        ESP_LOGW(TAG, "join: no ssid");
        return;
    }
    extract_str_key((const char *)json, len, "p", pass, sizeof(pass));

    strlcpy(s_pending_ssid, ssid, sizeof(s_pending_ssid));
    strlcpy(s_pending_pass, pass, sizeof(s_pending_pass));
    s_attempting_join = true;

    wifi_config_t wc = {0};
    strlcpy((char *)wc.sta.ssid, ssid, sizeof(wc.sta.ssid));
    strlcpy((char *)wc.sta.password, pass, sizeof(wc.sta.password));
    esp_wifi_set_config(WIFI_IF_STA, &wc);
    esp_wifi_disconnect();      // event handler will reconnect with new creds
    esp_wifi_connect();

    esp_timer_stop(s_join_timeout_timer);
    esp_timer_start_once(s_join_timeout_timer, (uint64_t)JOIN_TIMEOUT_MS * 1000);
    publish_status("joining", ssid, NULL, NULL);
}

static bool load_saved_creds(char *ssid, size_t ssid_len, char *pass, size_t pass_len) {
    nvs_handle_t h;
    if (nvs_open("wifi", NVS_READONLY, &h) != ESP_OK) return false;
    size_t sl = ssid_len, pl = pass_len;
    bool ok = nvs_get_str(h, "ssid", ssid, &sl) == ESP_OK
           && nvs_get_str(h, "pass", pass, &pl) == ESP_OK
           && sl > 0;
    nvs_close(h);
    return ok;
}

void wifi_sta_init(const char *hostname) {
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_t *sta_netif = esp_netif_create_default_wifi_sta();
    esp_netif_set_hostname(sta_netif, hostname);

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi_event, NULL, NULL));

    esp_timer_create_args_t targs = { .callback = on_join_timeout, .name = "wifi_join_to" };
    esp_timer_create(&targs, &s_join_timeout_timer);

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));

    char ssid[33] = {0}, pass[65] = {0};
    bool have_creds = load_saved_creds(ssid, sizeof(ssid), pass, sizeof(pass));
    if (have_creds) {
        wifi_config_t wc = {0};
        strlcpy((char *)wc.sta.ssid, ssid, sizeof(wc.sta.ssid));
        strlcpy((char *)wc.sta.password, pass, sizeof(wc.sta.password));
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
        strlcpy(s_pending_ssid, ssid, sizeof(s_pending_ssid));
        strlcpy(s_pending_pass, pass, sizeof(s_pending_pass));
        s_attempting_join = true;
        esp_timer_start_once(s_join_timeout_timer, (uint64_t)JOIN_TIMEOUT_MS * 1000);
        snprintf(s_status_json, STATUS_BUF_SIZE, "{\"st\":\"joining\",\"ssid\":\"%s\"}", ssid);
        ESP_LOGI(TAG, "joining saved network ssid=%s", ssid);
    } else {
        ESP_LOGI(TAG, "no saved creds — STA up, idle");
    }

    ESP_ERROR_CHECK(esp_wifi_start());
    esp_wifi_set_ps(WIFI_PS_NONE);
    esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);
}
