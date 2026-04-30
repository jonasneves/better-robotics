#include "turn_creds.h"

#include <stdarg.h>
#include <string.h>
#include <netdb.h>
#include <arpa/inet.h>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "wifi_sta.h"

static const char *TAG = "turn_creds";

#define TURN_URL       "https://proxy.neevs.io/cloudflare/turn"
#define USER_BUF_SIZE  160
#define CRED_BUF_SIZE  160
#define HTTP_BUF_SIZE  2048
#define REFRESH_HOURS  23   // Re-fetch 1h before Cloudflare's 24h default expiry.

static char s_username[USER_BUF_SIZE];
static char s_credential[CRED_BUF_SIZE];
static char s_turn_url[64];   // "turn:<IPv4>:3478?transport=udp"
static char s_last_error[96];
static int64_t s_expires_at_us = 0;

static char s_response[HTTP_BUF_SIZE];
static size_t s_response_len = 0;

const char *turn_creds_username(void)   { return s_username[0]   ? s_username   : NULL; }
const char *turn_creds_credential(void) { return s_credential[0] ? s_credential : NULL; }
const char *turn_creds_url(void)        { return s_turn_url[0]   ? s_turn_url   : NULL; }
const char *turn_creds_last_error(void) { return s_last_error;                          }

static void set_err(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(s_last_error, sizeof(s_last_error), fmt, ap);
    va_end(ap);
}

static bool resolve_turn_host(void) {
    struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_DGRAM };
    struct addrinfo *res = NULL;
    int64_t t0 = esp_timer_get_time();
    int rc = getaddrinfo("turn.cloudflare.com", NULL, &hints, &res);
    int64_t dt_ms = (esp_timer_get_time() - t0) / 1000;
    if (rc != 0 || !res) {
        ESP_LOGE(TAG, "resolve turn.cloudflare.com failed rc=%d (%lldms)", rc, dt_ms);
        set_err("resolve_failed rc=%d", rc);
        if (res) freeaddrinfo(res);
        return false;
    }
    char ip[INET_ADDRSTRLEN];
    struct sockaddr_in *sa = (struct sockaddr_in *)res->ai_addr;
    inet_ntop(AF_INET, &sa->sin_addr, ip, sizeof(ip));
    freeaddrinfo(res);
    snprintf(s_turn_url, sizeof(s_turn_url), "turn:%s:3478?transport=udp", ip);
    ESP_LOGI(TAG, "resolved turn.cloudflare.com → %s (%lldms)", ip, dt_ms);
    return true;
}

static esp_err_t http_event_handler(esp_http_client_event_t *evt) {
    if (evt->event_id == HTTP_EVENT_ON_DATA && evt->data && evt->data_len > 0) {
        if (s_response_len + evt->data_len < HTTP_BUF_SIZE - 1) {
            memcpy(s_response + s_response_len, evt->data, evt->data_len);
            s_response_len += evt->data_len;
            s_response[s_response_len] = 0;
        }
    }
    return ESP_OK;
}

static bool fetch_once(void) {
    s_response_len = 0;
    s_response[0] = 0;

    esp_http_client_config_t cfg = {
        .url = TURN_URL,
        .method = HTTP_METHOD_POST,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .event_handler = http_event_handler,
        .timeout_ms = 10000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) { ESP_LOGE(TAG, "client init failed"); set_err("client_init_failed"); return false; }

    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, "{}", 2);

    esp_err_t err = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "perform: %s", esp_err_to_name(err));
        set_err("perform: %s", esp_err_to_name(err));
        return false;
    }
    if (status != 200) {
        ESP_LOGE(TAG, "status %d body=%s", status, s_response);
        set_err("http %d", status);
        return false;
    }

    cJSON *root = cJSON_Parse(s_response);
    if (!root) { ESP_LOGE(TAG, "json parse failed"); set_err("json_parse_failed"); return false; }

    bool ok = false;
    cJSON *servers = cJSON_GetObjectItem(root, "iceServers");
    if (cJSON_IsArray(servers)) {
        cJSON *server = NULL;
        cJSON_ArrayForEach(server, servers) {
            cJSON *u = cJSON_GetObjectItem(server, "username");
            cJSON *c = cJSON_GetObjectItem(server, "credential");
            if (cJSON_IsString(u) && cJSON_IsString(c)) {
                strlcpy(s_username,   u->valuestring, USER_BUF_SIZE);
                strlcpy(s_credential, c->valuestring, CRED_BUF_SIZE);
                ok = true;
                break;
            }
        }
    }
    cJSON_Delete(root);

    if (ok) {
        s_expires_at_us = esp_timer_get_time() + (int64_t)REFRESH_HOURS * 3600 * 1000 * 1000;
        s_last_error[0] = 0;
        ESP_LOGI(TAG, "fetched TURN creds (user=%.8s..., refresh in %dh)",
                 s_username, REFRESH_HOURS);
        // Pre-resolve turn.cloudflare.com so libpeer's create_answer
        // doesn't synchronously getaddrinfo() inside the BLE 30s window.
        // Best-effort: failure leaves s_turn_url empty and webrtc_peer
        // falls back to STUN-only.
        resolve_turn_host();
    } else {
        set_err("creds_missing_in_response");
    }
    return ok;
}

static void fetch_task(void *arg) {
    while (1) {
        while (!wifi_sta_has_ip()) vTaskDelay(pdMS_TO_TICKS(1000));
        // Brief grace for DNS / route table to settle after GOT_IP.
        vTaskDelay(pdMS_TO_TICKS(2000));

        // Retry on transient HTTPS / DNS failures with backoff. Five
        // attempts ≈ 25s, after which we give up until the next expiry
        // window (24h) — at which point WiFi has hopefully recovered.
        int delay_s = 5;
        for (int i = 0; i < 5 && !fetch_once(); i++) {
            vTaskDelay(pdMS_TO_TICKS(delay_s * 1000));
            if (delay_s < 60) delay_s *= 2;
        }

        if (s_expires_at_us == 0) {
            // Never succeeded. Sleep an hour and retry.
            vTaskDelay(pdMS_TO_TICKS(3600 * 1000));
            continue;
        }

        // Sleep until expiry, then loop and re-fetch.
        int64_t now = esp_timer_get_time();
        int64_t delta_us = s_expires_at_us - now;
        if (delta_us > 0) vTaskDelay(pdMS_TO_TICKS(delta_us / 1000));
    }
}

void turn_creds_init(void) {
    // 8192 is the sweet spot: enough for esp_http_client + mbedTLS
    // handshake + cJSON parse (6144 panicked), small enough not to
    // squeeze internal DRAM (12288 broke websocket_client + BLE on
    // the ESP32-CAM's already-tight DRAM budget).
    xTaskCreate(fetch_task, "turn_creds", 8192, NULL, 5, NULL);
}
