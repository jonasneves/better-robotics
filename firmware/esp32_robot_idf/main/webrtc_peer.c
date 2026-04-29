#include "webrtc_peer.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "peer.h"
#include "peer_connection.h"

static const char *TAG = "rtc";

#define SIGNAL_HOST "signal.neevs.io"

static char s_my_peer_id[16];
static char s_room_id[64];
static esp_websocket_client_handle_t s_ws;
static PeerConnection *s_pc;

// Loop task drains events from the websocket handler and pumps libpeer.
// Single-threaded ownership of s_pc avoids a mutex around every state-
// machine tick — websocket events post here and unblock immediately.
typedef enum {
    EV_OFFER,
    EV_ICE,
} event_type_t;

typedef struct {
    event_type_t type;
    char *payload;   // malloc'd; freed by handler
} event_t;

static QueueHandle_t s_events;
static TaskHandle_t s_loop_task;

// ── outbound signaling ───────────────────────────────────────────────────

static void send_signal_data(cJSON *data) {
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "signal");
    cJSON_AddStringToObject(root, "peer", s_my_peer_id);
    cJSON_AddItemToObject(root, "data", data);   // takes ownership
    char *json = cJSON_PrintUnformatted(root);
    if (json && esp_websocket_client_is_connected(s_ws)) {
        esp_websocket_client_send_text(s_ws, json, strlen(json), portMAX_DELAY);
    }
    free(json);
    cJSON_Delete(root);
}

static void send_answer(const char *sdp) {
    cJSON *data = cJSON_CreateObject();
    cJSON *answer = cJSON_AddObjectToObject(data, "answer");
    cJSON_AddStringToObject(answer, "sdp", sdp);
    cJSON_AddStringToObject(answer, "type", "answer");
    send_signal_data(data);
}

// ── peer connection lifecycle ────────────────────────────────────────────

static void on_state_change(PeerConnectionState state, void *ud) {
    ESP_LOGI(TAG, "pc state: %s", peer_connection_state_to_string(state));
}

static void handle_offer(const char *sdp) {
    if (s_pc) {
        peer_connection_close(s_pc);
        peer_connection_destroy(s_pc);
        s_pc = NULL;
    }

    PeerConfiguration cfg = {
        .ice_servers = {
            { .urls = "stun:stun.l.google.com:19302" },
        },
        .video_codec = CODEC_NONE,    // 2.D.3 routes frames as binary on a data channel
        .audio_codec = CODEC_NONE,
        .datachannel = DATA_CHANNEL_BINARY,
    };
    s_pc = peer_connection_create(&cfg);
    if (!s_pc) {
        ESP_LOGE(TAG, "peer_connection_create failed");
        return;
    }
    peer_connection_oniceconnectionstatechange(s_pc, on_state_change);

    peer_connection_set_remote_description(s_pc, sdp, SDP_TYPE_OFFER);
    const char *answer = peer_connection_create_answer(s_pc);
    if (!answer || !answer[0]) {
        ESP_LOGE(TAG, "create_answer empty");
        return;
    }
    send_answer(answer);
}

static void handle_ice(const char *candidate) {
    if (!s_pc || !candidate || !candidate[0]) return;
    // libpeer takes a non-const char *; the API doesn't mutate but we
    // need a writable copy.
    char *copy = strdup(candidate);
    if (!copy) return;
    peer_connection_add_ice_candidate(s_pc, copy);
    free(copy);
}

// ── inbound dispatcher ───────────────────────────────────────────────────

static void post_event(event_type_t t, const char *str) {
    if (!str) return;
    char *copy = strdup(str);
    if (!copy) return;
    event_t ev = { .type = t, .payload = copy };
    if (xQueueSend(s_events, &ev, 0) != pdTRUE) {
        free(copy);
    }
}

// Filter peers per the Pi-side rules: ignore self, accept only dashboard
// (and phone- for the eventual phone-control flow). Anything else gets
// dropped — the same role gate every node in the rendezvous applies.
static bool peer_accepted(const char *peer_id) {
    if (strcmp(peer_id, s_my_peer_id) == 0) return false;
    return strncmp(peer_id, "dashboard-", 10) == 0
        || strncmp(peer_id, "phone-",      6) == 0;
}

static void dispatch_signal(const char *peer_id, cJSON *data) {
    if (!peer_accepted(peer_id)) return;
    cJSON *offer = cJSON_GetObjectItem(data, "offer");
    if (cJSON_IsObject(offer)) {
        cJSON *sdp = cJSON_GetObjectItem(offer, "sdp");
        if (cJSON_IsString(sdp)) post_event(EV_OFFER, sdp->valuestring);
    }
    cJSON *ice = cJSON_GetObjectItem(data, "ice");
    if (cJSON_IsObject(ice)) {
        cJSON *cand = cJSON_GetObjectItem(ice, "candidate");
        if (cJSON_IsString(cand)) post_event(EV_ICE, cand->valuestring);
    }
}

static void on_ws_text(const char *data, size_t len) {
    cJSON *root = cJSON_ParseWithLength(data, len);
    if (!root) return;
    cJSON *type = cJSON_GetObjectItem(root, "type");
    if (cJSON_IsString(type)) {
        if (strcmp(type->valuestring, "signal") == 0) {
            cJSON *peer = cJSON_GetObjectItem(root, "peer");
            cJSON *d    = cJSON_GetObjectItem(root, "data");
            if (cJSON_IsString(peer) && cJSON_IsObject(d)) {
                dispatch_signal(peer->valuestring, d);
            }
        } else if (strcmp(type->valuestring, "state") == 0) {
            // The signal server replays cached signaling to peers that
            // join after another peer sent an offer (e.g. dashboard
            // clicked Connect while the ESP32 was momentarily offline).
            cJSON *peers = cJSON_GetObjectItem(root, "peers");
            if (cJSON_IsObject(peers)) {
                cJSON *child;
                cJSON_ArrayForEach(child, peers) {
                    if (child->string && cJSON_IsObject(child)) {
                        dispatch_signal(child->string, child);
                    }
                }
            }
        }
    }
    cJSON_Delete(root);
}

// ── websocket events ─────────────────────────────────────────────────────

static void on_ws_event(void *handler_args, esp_event_base_t base,
                        int32_t event_id, void *event_data) {
    esp_websocket_event_data_t *d = (esp_websocket_event_data_t *)event_data;
    switch (event_id) {
        case WEBSOCKET_EVENT_CONNECTED:
            ESP_LOGI(TAG, "ws connected: %s/%s", SIGNAL_HOST, s_room_id);
            break;
        case WEBSOCKET_EVENT_DISCONNECTED:
            ESP_LOGW(TAG, "ws disconnected");
            break;
        case WEBSOCKET_EVENT_DATA:
            if (d->op_code == 0x01 && d->data_len > 0) {  // text frame
                on_ws_text((const char *)d->data_ptr, d->data_len);
            }
            break;
    }
}

// ── loop task ────────────────────────────────────────────────────────────

static void loop_task_fn(void *arg) {
    event_t ev;
    while (1) {
        while (xQueueReceive(s_events, &ev, 0) == pdTRUE) {
            switch (ev.type) {
                case EV_OFFER: handle_offer(ev.payload); break;
                case EV_ICE:   handle_ice(ev.payload);   break;
            }
            free(ev.payload);
        }
        if (s_pc) peer_connection_loop(s_pc);
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

// ── init ─────────────────────────────────────────────────────────────────

void webrtc_peer_init(const char *robot_name) {
    uint32_t r = esp_random();
    snprintf(s_my_peer_id, sizeof(s_my_peer_id), "esp32-%06lx", (unsigned long)(r & 0xFFFFFF));
    snprintf(s_room_id, sizeof(s_room_id), "esp32-rtc-%s", robot_name);

    if (peer_init() != 0) {
        ESP_LOGE(TAG, "peer_init failed");
        return;
    }

    s_events = xQueueCreate(8, sizeof(event_t));
    if (!s_events) { ESP_LOGE(TAG, "queue create failed"); return; }

    // 16 KB stack — peer_connection_loop dives into mbedTLS / SCTP /
    // SRTP whose call chains aren't shallow. Empirically 8 KB is enough
    // for steady state but cuts close during DTLS handshake.
    xTaskCreate(loop_task_fn, "rtc_loop", 16384, NULL, 5, &s_loop_task);

    char url[160];
    snprintf(url, sizeof(url), "wss://%s/%s/ws", SIGNAL_HOST, s_room_id);
    esp_websocket_client_config_t cfg = {
        .uri = url,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .reconnect_timeout_ms = 5000,
        .network_timeout_ms = 10000,
        .buffer_size = 4096,
    };
    s_ws = esp_websocket_client_init(&cfg);
    if (!s_ws) { ESP_LOGE(TAG, "ws init failed"); return; }
    esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, on_ws_event, NULL);
    esp_websocket_client_start(s_ws);
    ESP_LOGI(TAG, "rtc init: peer=%s room=%s", s_my_peer_id, s_room_id);
}
