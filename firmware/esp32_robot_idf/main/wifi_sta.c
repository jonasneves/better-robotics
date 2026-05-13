#include "wifi_sta.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_net_stack.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "lwip/dhcp6.h"
#include "lwip/netif.h"
#include "nvs.h"

#include "gatt_svr.h"

static const char *TAG = "wifi_sta";

#define SCAN_MAX            10
// 45s, not 20s. Apartment-WiFi-as-a-service (WhiteSky-Beckon and similar)
// regularly takes 25-35s to associate + DHCP — 20s would mark a successful
// join as failed before the AP finishes handshaking. Cost is at most 25s
// of extra "Joining…" UX on a wrong-password attempt.
#define JOIN_TIMEOUT_MS     45000
#define STATUS_BUF_SIZE     192
#define SCAN_BUF_SIZE       1280

static bool s_has_ip = false;
static bool s_attempting_join = false;
static esp_netif_t *s_sta_netif = NULL;
// Set right before we call esp_wifi_disconnect() ourselves (network
// switch). The next STA_DISCONNECTED event is ours, not a real failure
// — without this flag the handler reads it as "join failed" and bails,
// even though the new association completes ~50ms later.
static bool s_self_disconnect = false;
// Tracks whether STA_CONNECTED has fired during the current join attempt.
// Lets the timeout handler distinguish "couldn't associate" (auth/SSID
// problem) from "associated but never got an IP" (typically beacon loss
// on a flaky AP — network problem, not credential problem). Reset on
// each fresh join.
static bool s_associated = false;
static bool s_scan_in_flight = false;
static char s_pending_ssid[33];
static char s_pending_pass[65];
static esp_timer_handle_t s_join_timeout_timer;

static char s_status_json[STATUS_BUF_SIZE] = "{\"st\":\"idle\"}";
static char s_scan_json[SCAN_BUF_SIZE]     = "[]";

bool wifi_sta_has_ip(void) { return s_has_ip; }
const char *wifi_sta_status_json(void) { return s_status_json; }
const char *wifi_sta_scan_json(void) { return s_scan_json; }

// JSON string escape: quote / backslash / newline / carriage return —
// drop other control chars so stray bytes from a misbehaving AP can't
// break the dashboard's parser.
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

// Map -100..-50 dBm → 0..100 strength.
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
    // "associated, no IP" → DHCP issue, almost always a flaky AP / weak
    // signal. "never associated" → auth/SSID problem. Distinct messages
    // help the user pick between "fix the network" and "fix the password".
    const char *reason = s_associated ? "no IP — AP unstable" : "no association";
    publish_status("failed", s_pending_ssid, reason, NULL);
    s_associated = false;
}

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        // Association succeeded (auth + 4-way handshake done). DHCP /
        // GOT_IP may still be pending. Used by the join-timeout handler
        // to differentiate "couldn't associate" from "associated but no IP".
        s_associated = true;
        // Kick IPv6 link-local + DHCPv6 stateless. Apple devices on this
        // apartment WiFi get global v6 via DHCPv6, not SLAAC RAs, so
        // CONFIG_LWIP_IPV6_AUTOCONFIG alone leaves us link-local only.
        // dhcp6_enable_stateless asks the network's DHCPv6 server for a
        // global lease; if no server, it just times out silently.
        if (s_sta_netif) {
            esp_netif_create_ip6_linklocal(s_sta_netif);
            struct netif *lwip_netif = esp_netif_get_netif_impl(s_sta_netif);
            if (lwip_netif) dhcp6_enable_stateless(lwip_netif);
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_associated = false;
        s_has_ip = false;
        wifi_event_sta_disconnected_t *ev = (wifi_event_sta_disconnected_t *)data;
        if (s_self_disconnect) {
            // We initiated this disconnect to switch networks. The new
            // STA_CONNECTED for the target SSID will follow shortly;
            // don't surface it as "join failed".
            s_self_disconnect = false;
            return;
        }
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
        s_scan_in_flight = false;
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
            // Persist only AFTER the join succeeded. Avoids saving a bad
            // password that would loop on next boot.
            persist_creds(s_pending_ssid, s_pending_pass);
        }
        publish_status("joined", s_pending_ssid, NULL, ip);
    } else if (base == IP_EVENT && id == IP_EVENT_GOT_IP6) {
        ip_event_got_ip6_t *ev = (ip_event_got_ip6_t *)data;
        ESP_LOGI(TAG, "got ipv6 " IPV6STR, IPV62STR(ev->ip6_info.ip));
    }
}

void wifi_sta_scan_start(void) {
    // Drop concurrent scan requests instead of stopping the in-flight scan.
    // Stopping mid-scan creates a positive feedback loop with the dashboard's
    // auto-retry: each retry kills the in-progress scan, so the chip never
    // completes a successful one. A passive scan takes 7-12s on classic
    // ESP32; the dashboard's failsafe (30s) gives it room to finish.
    if (s_scan_in_flight) {
        ESP_LOGI(TAG, "scan already in flight, ignoring duplicate");
        return;
    }
    // Block scans during the critical join window (associated but not
    // yet GOT_IP). Each passive scan tunes the radio off-channel for
    // ~5s; the AP's beacons during that window are missed, the chip's
    // TBTT estimate drifts, and the AP eventually disassociates the
    // chip mid-DHCP. Saw this kill jonas/WhiteSky-Beckon joins at
    // RSSI -34 — clearly not signal-related, beacons just weren't
    // being heard. Dashboard's auto-poll keeps requesting scans while
    // the WiFi panel is open; we silently no-op those during a join.
    if (s_attempting_join || (s_associated && !s_has_ip)) {
        ESP_LOGI(TAG, "scan blocked: join in progress");
        snprintf(s_scan_json, SCAN_BUF_SIZE, "[]");
        gatt_svr_notify_wifi_scan();
        return;
    }

    wifi_scan_config_t cfg = {
        .ssid = NULL,
        .bssid = NULL,
        .channel = 0,
        .show_hidden = false,
        // Passive scan + default dwell. BLE coex aggressively drops active
        // probe responses on classic ESP32, so beacon-only listening is
        // more reliable. .scan_time omitted because coex prefers its own
        // dwell when BT is enabled — overriding warns and gets ignored.
        .scan_type = WIFI_SCAN_TYPE_PASSIVE,
    };
    esp_err_t rc = esp_wifi_scan_start(&cfg, false);
    if (rc != ESP_OK) {
        ESP_LOGW(TAG, "scan_start rc=0x%x; publishing empty", rc);
        // Surface the failure as an empty list so the dashboard breaks out
        // of its spinner immediately rather than waiting the full 30s
        // failsafe.
        snprintf(s_scan_json, SCAN_BUF_SIZE, "[]");
        gatt_svr_notify_wifi_scan();
        return;
    }
    s_scan_in_flight = true;
}

// Tiny string-key extractor. Returns true if key was found and copied
// into out. JSON values must be double-quoted; embedded backslash-escapes
// handled minimally (\\ and \" stay as one char in the value).
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
    s_associated = false;

    wifi_config_t wc = {0};
    strlcpy((char *)wc.sta.ssid, ssid, sizeof(wc.sta.ssid));
    strlcpy((char *)wc.sta.password, pass, sizeof(wc.sta.password));
    esp_wifi_set_config(WIFI_IF_STA, &wc);
    s_self_disconnect = true;   // suppress the next STA_DISCONNECTED — it's ours
    esp_wifi_disconnect();
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
    s_sta_netif = esp_netif_create_default_wifi_sta();
    esp_netif_set_hostname(s_sta_netif, hostname);

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_GOT_IP6, on_wifi_event, NULL, NULL));

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
    // PS_NONE: radio always on. PS_MIN_MODEM tanks HTTP MJPEG throughput
    // (http_stream has no hook to wake the radio before sending).
    esp_wifi_set_ps(WIFI_PS_NONE);
    esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);
}

void wifi_sta_pause(void) {
    // s_self_disconnect suppresses the disconnect event handler's
    // "failed" status publish — this is a deliberate stop, not a
    // join failure.
    s_self_disconnect = true;
    esp_err_t err = esp_wifi_stop();
    ESP_LOGI(TAG, "pause: esp_wifi_stop=%d", err);
}

void wifi_sta_resume(void) {
    esp_err_t err = esp_wifi_start();
    ESP_LOGI(TAG, "resume: esp_wifi_start=%d", err);
    // STA_START event handler fires esp_wifi_connect() automatically
    // (line 182 above); no explicit connect needed here.
}
