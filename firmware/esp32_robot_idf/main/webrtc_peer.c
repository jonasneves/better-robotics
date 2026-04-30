#include "webrtc_peer.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "peer.h"
#include "peer_connection.h"

#include "esp_camera.h"

#include "camera.h"
#include "gatt_svr.h"
#include "ota.h"

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
    EV_OFFER_WS,
    EV_OFFER_BLE,
    EV_ICE,
} event_type_t;

typedef enum {
    OFFER_SRC_WS,
    OFFER_SRC_BLE,
} offer_src_t;

// Tracked across handle_offer → create_answer so the answer routes back
// through the same transport the offer came in on.
static offer_src_t s_active_offer_src = OFFER_SRC_WS;
// BLE-only: the conn handle of the central that wrote the offer. The
// answer notify routes here, not to ble_host_active_conn() (which is
// the most-recent connection — wrong when two browsers are both
// connected, since 2.F.2 raised MAX_CONNECTIONS to 4).
static uint16_t s_active_offer_conn = 0;

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

static void send_answer_via_ws(const char *sdp) {
    cJSON *data = cJSON_CreateObject();
    cJSON *answer = cJSON_AddObjectToObject(data, "answer");
    cJSON_AddStringToObject(answer, "sdp", sdp);
    cJSON_AddStringToObject(answer, "type", "answer");
    send_signal_data(data);
}

// ── BLE signaling ────────────────────────────────────────────────────────

#define BLE_SIG_MAX_OFFER 8192    // SDP rarely exceeds 5 KB; cap defends RAM
#define BLE_SIG_CHUNK     100     // small enough to fit any plausible MTU

// Reassembly buffer for incoming chunked offer. Owned by the BLE host
// task between begin and commit; ownership transfers to the loop task on
// commit (queued via EV_OFFER_BLE).
static char *s_ble_offer_buf = NULL;
static size_t s_ble_offer_total = 0;
static size_t s_ble_offer_received = 0;

static void send_ble_signal_error(const char *msg) {
    uint8_t buf[1 + 64];
    buf[0] = 0xFF;
    size_t n = strnlen(msg, sizeof(buf) - 1);
    memcpy(buf + 1, msg, n);
    gatt_svr_signal_send(s_active_offer_conn, buf, 1 + n);
}

static void send_answer_via_ble(const char *sdp) {
    size_t total = strlen(sdp);
    ESP_LOGI(TAG, "send_answer_via_ble: total=%u conn=%u",
             (unsigned)total, (unsigned)s_active_offer_conn);
    if (total == 0 || total > 0xFFFF) {
        send_ble_signal_error("answer size out of range");
        return;
    }
    uint8_t begin[3] = { 0x01, (uint8_t)(total >> 8), (uint8_t)(total & 0xff) };
    gatt_svr_signal_send(s_active_offer_conn, begin, 3);

    uint8_t chunk[1 + BLE_SIG_CHUNK];
    chunk[0] = 0x02;
    size_t offset = 0;
    while (offset < total) {
        size_t take = total - offset > BLE_SIG_CHUNK ? BLE_SIG_CHUNK : total - offset;
        memcpy(chunk + 1, sdp + offset, take);
        gatt_svr_signal_send(s_active_offer_conn, chunk, 1 + take);
        offset += take;
        // Pace notifies — same reasoning as snapshot's 40 ms gap, but our
        // chunk size is much smaller so 5 ms is enough for the BLE tx
        // queue to drain between sends.
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    uint8_t commit[1] = { 0x03 };
    gatt_svr_signal_send(s_active_offer_conn, commit, 1);
    ESP_LOGI(TAG, "send_answer_via_ble: done (%u chunks)",
             (unsigned)((total + BLE_SIG_CHUNK - 1) / BLE_SIG_CHUNK));
}

void webrtc_peer_handle_ble_signal_write(uint16_t from_conn, const uint8_t *buf, size_t len) {
    if (len == 0) return;
    uint8_t op = buf[0];
    if (op == 0x01) {
        if (len < 3) { send_ble_signal_error("bad begin"); return; }
        // Bind the answer to this writer's conn for the rest of the
        // handshake. Captured here (not at op==0x03) so error frames
        // sent during reassembly route to the right central.
        s_active_offer_conn = from_conn;
        size_t total = ((size_t)buf[1] << 8) | buf[2];
        ESP_LOGI(TAG, "ble signal: begin total=%u conn=%u",
                 (unsigned)total, (unsigned)from_conn);
        if (total == 0 || total > BLE_SIG_MAX_OFFER) {
            send_ble_signal_error("offer size out of range");
            return;
        }
        free(s_ble_offer_buf);
        s_ble_offer_buf = malloc(total + 1);
        if (!s_ble_offer_buf) {
            send_ble_signal_error("oom");
            s_ble_offer_total = 0;
            return;
        }
        s_ble_offer_total = total;
        s_ble_offer_received = 0;
    } else if (op == 0x02) {
        if (!s_ble_offer_buf) return;
        size_t add = len - 1;
        if (s_ble_offer_received + add > s_ble_offer_total) {
            free(s_ble_offer_buf);
            s_ble_offer_buf = NULL;
            send_ble_signal_error("chunk overflow");
            return;
        }
        memcpy(s_ble_offer_buf + s_ble_offer_received, buf + 1, add);
        s_ble_offer_received += add;
    } else if (op == 0x03) {
        if (!s_ble_offer_buf || s_ble_offer_received != s_ble_offer_total) {
            free(s_ble_offer_buf);
            s_ble_offer_buf = NULL;
            send_ble_signal_error("offer incomplete");
            return;
        }
        ESP_LOGI(TAG, "ble signal: commit, offer assembled %u B",
                 (unsigned)s_ble_offer_total);
        s_ble_offer_buf[s_ble_offer_total] = 0;
        // Hand ownership to the loop task via the event queue. If queue
        // send fails, free here; otherwise the loop task frees after
        // handling.
        event_t ev = { .type = EV_OFFER_BLE, .payload = s_ble_offer_buf };
        if (xQueueSend(s_events, &ev, 0) != pdTRUE) {
            ESP_LOGW(TAG, "event queue full; dropping BLE offer");
            free(s_ble_offer_buf);
        }
        s_ble_offer_buf = NULL;
        s_ble_offer_total = 0;
        s_ble_offer_received = 0;
    }
}

// ── peer connection lifecycle ────────────────────────────────────────────

static void stop_video_streaming(void);

static void on_state_change(PeerConnectionState state, void *ud) {
    ESP_LOGI(TAG, "pc state: %s", peer_connection_state_to_string(state));
    if (state == PEER_CONNECTION_DISCONNECTED
        || state == PEER_CONNECTION_FAILED
        || state == PEER_CONNECTION_CLOSED) {
        stop_video_streaming();
    }
}

// ── data channels ────────────────────────────────────────────────────────
//
// libpeer's onmessage callback drops the SCTP PPID (text vs binary) before
// invoking us — peer_connection.h's signature has no type field. We
// disambiguate by content: control frames are JSON starting with `{`,
// payload chunks are arbitrary bytes. ESP32 firmware bins start with the
// 0xE9 magic; JPEG frames start with 0xFFD8; neither collides with `{`
// (0x7B). Same heuristic as several other libpeer ESP32 integrations.

static void send_dc_text(const char *label, const char *text) {
    if (!s_pc) return;
    uint16_t sid;
    if (peer_connection_lookup_sid(s_pc, (char *)label, &sid) != 0) return;
    peer_connection_datachannel_send_sid(s_pc, (char *)text, strlen(text), sid);
}

static void handle_ota_dc(const char *msg, size_t len) {
    if (len == 0) return;
    if (msg[0] == '{') {
        cJSON *root = cJSON_ParseWithLength(msg, len);
        if (!root) return;
        cJSON *type = cJSON_GetObjectItem(root, "type");
        if (cJSON_IsString(type)) {
            const char *t = type->valuestring;
            if (strcmp(t, "begin") == 0) {
                cJSON *size = cJSON_GetObjectItem(root, "size");
                size_t total = cJSON_IsNumber(size) ? (size_t)size->valuedouble : 0;
                if (ota_http_begin(total) != ESP_OK) {
                    send_dc_text("ota", "{\"type\":\"error\",\"error\":\"ota_begin failed\"}");
                }
            } else if (strcmp(t, "commit") == 0) {
                if (ota_http_commit() == ESP_OK) {
                    // Match the Pi's reply shape so dashboard parsing
                    // doesn't need a per-platform branch. The follow-up
                    // BLE apply-staged-ota verb won't reach us before
                    // schedule_restart fires (500 ms) — chip reboots
                    // straight into the new firmware. Dashboard sees a
                    // BLE write fail; the next reconnect shows the new
                    // version. Acceptable until the dashboard branches
                    // on fwType to skip the apply step for ESP32.
                    send_dc_text("ota", "{\"type\":\"staged\"}");
                } else {
                    send_dc_text("ota", "{\"type\":\"error\",\"error\":\"ota_commit failed\"}");
                }
            } else if (strcmp(t, "abort") == 0) {
                ota_http_abort();
            }
        }
        cJSON_Delete(root);
    } else {
        // Binary chunk — append to OTA partition.
        if (ota_http_write((const uint8_t *)msg, len) != ESP_OK) {
            send_dc_text("ota", "{\"type\":\"error\",\"error\":\"ota_write failed\"}");
        }
    }
}

// ── video over data channel ──────────────────────────────────────────────
//
// Browsers can't decode MJPEG WebRTC video tracks (only VP8/VP9/H.264/AV1
// are negotiable codecs), so we route JPEG frames as binary on a data
// channel instead. Dashboard receives ArrayBuffers and renders via
// URL.createObjectURL or a 2D canvas. Same end-to-end behavior as
// /stream over HTTP, but P2P + no Mixed Content / PNA fragility.
//
// Single SCTP message per frame; SCTP's universal floor is 16 KB, so the
// camera profile must stay at compact (QVGA q=15, ~5-10 KB) for reliable
// delivery. Standard/full can exceed the limit and fragment unreliably.
//
// The frame pump runs INSIDE rtc_loop_task instead of its own task — by
// the time a video session starts, internal DRAM is fragmented enough
// that no contiguous 4 KB block remains for a fresh task stack, and an
// SPIRAM-stacked task panics during DTLS/SRTP encrypt (cache-coherence
// quirks on classic ESP32). Pacing by esp_timer_get_time() keeps it
// independent of vTaskDelay quantization.

static volatile bool s_video_active = false;
static int s_video_fps = 10;
static int64_t s_video_last_frame_us = 0;

static int s_video_frame_count = 0;
static void video_pump_tick(void) {
    if (!s_video_active || !camera_ready() || !s_pc) return;
    int64_t now = esp_timer_get_time();
    int64_t period_us = (int64_t)1000000 / (s_video_fps > 0 ? s_video_fps : 10);
    if (now - s_video_last_frame_us < period_us) return;
    s_video_last_frame_us = now;

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        ESP_LOGW(TAG, "video pump: fb_get failed");
        return;
    }
    uint16_t sid = 0;
    int rc = peer_connection_lookup_sid(s_pc, "video", &sid);
    if (rc != 0) {
        ESP_LOGW(TAG, "video pump: lookup_sid rc=%d", rc);
        esp_camera_fb_return(fb);
        return;
    }
    int sent = peer_connection_datachannel_send_sid(s_pc, (char *)fb->buf, fb->len, sid);
    if ((s_video_frame_count++ % 10) == 0) {
        ESP_LOGI(TAG, "video pump: sent frame #%d, %u B → sid=%u rc=%d",
                 s_video_frame_count, (unsigned)fb->len, sid, sent);
    }
    esp_camera_fb_return(fb);
}

static void start_video_streaming(int fps) {
    s_video_fps = (fps > 0 && fps <= 30) ? fps : 10;
    s_video_active = true;
    s_video_last_frame_us = 0;  // fire on the next loop tick
    ESP_LOGI(TAG, "video stream started, fps=%d", s_video_fps);
}

static void stop_video_streaming(void) {
    if (s_video_active) ESP_LOGI(TAG, "video stream stopped");
    s_video_active = false;
}

static void handle_video_dc(const char *msg, size_t len) {
    ESP_LOGI(TAG, "video dc msg: %.*s", (int)(len > 80 ? 80 : len), msg);
    if (len == 0 || msg[0] != '{') return;
    cJSON *root = cJSON_ParseWithLength(msg, len);
    if (!root) {
        ESP_LOGW(TAG, "video dc: bad json");
        return;
    }
    cJSON *type = cJSON_GetObjectItem(root, "type");
    if (cJSON_IsString(type)) {
        const char *t = type->valuestring;
        ESP_LOGI(TAG, "video dc type=%s", t);
        if (strcmp(t, "start") == 0) {
            cJSON *fps = cJSON_GetObjectItem(root, "fps");
            int f = cJSON_IsNumber(fps) ? (int)fps->valuedouble : 10;
            start_video_streaming(f);
        } else if (strcmp(t, "stop") == 0) {
            stop_video_streaming();
        }
    }
    cJSON_Delete(root);
}

static void on_dc_message(char *msg, size_t len, void *ud, uint16_t sid) {
    if (!s_pc) {
        ESP_LOGW(TAG, "dc msg sid=%u len=%u: no PC", (unsigned)sid, (unsigned)len);
        return;
    }
    char *label = peer_connection_lookup_sid_label(s_pc, sid);
    ESP_LOGI(TAG, "dc msg sid=%u len=%u label=%s",
             (unsigned)sid, (unsigned)len, label ? label : "<null>");
    if (!label) return;
    if (strcmp(label, "ota") == 0) {
        handle_ota_dc(msg, len);
    } else if (strcmp(label, "video") == 0) {
        handle_video_dc(msg, len);
    }
    // Other labels (logs, ops) drop here — wire in 2.D.2.x as needed.
}

static void on_dc_open(void *ud)  { ESP_LOGI(TAG, "data channel opened"); }
static void on_dc_close(void *ud) {
    ESP_LOGI(TAG, "data channel closed");
    // Stop video on any close — single-PC model means a closed channel
    // is effectively session end.
    stop_video_streaming();
}

static void handle_offer(const char *sdp, offer_src_t src) {
    ESP_LOGI(TAG, "handle_offer: src=%s, sdp len=%u",
             src == OFFER_SRC_BLE ? "BLE" : "WS", (unsigned)strlen(sdp));
    s_active_offer_src = src;
    if (s_pc) {
        // Last-window-wins: a second browser opening WebRTC kicks the
        // first one's session. The video pump references s_pc on every
        // tick, so stop it BEFORE close/destroy or it'll dereference a
        // freed handle. Brief delay lets libpeer's ICE/DTLS sockets
        // unbind before the new agent gathers candidates on the same
        // ports — without it the new ICE times out (observed on a 2nd
        // incognito window post-2.F.2).
        stop_video_streaming();
        peer_connection_close(s_pc);
        peer_connection_destroy(s_pc);
        s_pc = NULL;
        vTaskDelay(pdMS_TO_TICKS(500));
    }

    // STUN gives us a server-reflexive candidate (chip's public IP through
    // the AP's NAT). TURN gives us a relay candidate that public peers can
    // reach even when the AP blocks LAN UDP (Apple Personal Hotspot,
    // apartment WiFi-as-a-service, guest networks). Without TURN the chip
    // emits only its private host candidate, and ICE has nowhere to meet
    // when the LAN path is blocked — chrome://webrtc-internals confirmed
    // this exact failure mode (2026-04-30).
    //
    // libpeer's create_answer is synchronous over getaddrinfo() per ICE
    // server. On a slow/flaky DNS (iPhone hotspot, captive portals),
    // hostname-based ICE servers stretch create_answer past the BLE
    // signaling timeout and the dashboard never receives an answer. So
    // we bypass DNS for TURN by using a hardcoded IP literal — getaddrinfo
    // returns immediately on those. STUN keeps a hostname (Google's DNS
    // is fast everywhere). Cost: TURN IP rotation breaks until reflashed.
    // Acceptable for personal/dev; swap for a deployment-time endpoint
    // (and proper async resolver) if this ever ships.
    //
    // OpenRelay free TURN — IP from `host openrelay.metered.ca` on
    // 2026-04-30. Single UDP port 80 (most permissive); libpeer is
    // UDP-only so port 443 wouldn't add coverage.
    PeerConfiguration cfg = {
        .ice_servers = {
            { .urls = "stun:stun.l.google.com:19302" },
            { .urls = "turn:15.235.47.158:80",
              .username = "openrelayproject",
              .credential = "openrelayproject" },
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
    peer_connection_ondatachannel(s_pc, on_dc_message, on_dc_open, on_dc_close);

    ESP_LOGI(TAG, "handle_offer: setting remote description");
    peer_connection_set_remote_description(s_pc, sdp, SDP_TYPE_OFFER);
    ESP_LOGI(TAG, "handle_offer: creating answer");
    const char *answer = peer_connection_create_answer(s_pc);
    if (!answer || !answer[0]) {
        ESP_LOGE(TAG, "create_answer empty");
        if (src == OFFER_SRC_BLE) send_ble_signal_error("create_answer failed");
        return;
    }
    ESP_LOGI(TAG, "handle_offer: answer ready, %u B, src=%s",
             (unsigned)strlen(answer), src == OFFER_SRC_BLE ? "BLE" : "WS");
    if (src == OFFER_SRC_BLE) {
        send_answer_via_ble(answer);
    } else {
        send_answer_via_ws(answer);
    }
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
        if (cJSON_IsString(sdp)) post_event(EV_OFFER_WS, sdp->valuestring);
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
                case EV_OFFER_WS:  handle_offer(ev.payload, OFFER_SRC_WS);  break;
                case EV_OFFER_BLE: handle_offer(ev.payload, OFFER_SRC_BLE); break;
                case EV_ICE:       handle_ice(ev.payload);                  break;
            }
            free(ev.payload);
        }
        if (s_pc) peer_connection_loop(s_pc);
        video_pump_tick();
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

    // 8 KB stack — peer_connection_loop dives into mbedTLS / SCTP /
    // SRTP. 16 KB was paranoia; a 16 KB grab here starves the websocket
    // task's xTaskCreate on classic ESP32 because DRAM is fragmented by
    // the time webrtc_peer_init runs (camera + BLE + WiFi already have
    // their pools). 8 KB has been reported sufficient by other libpeer
    // ESP32 integrations; bump back up if the DTLS handshake stack-
    // overflows in practice.
    xTaskCreate(loop_task_fn, "rtc_loop", 8192, NULL, 5, &s_loop_task);

    char url[160];
    snprintf(url, sizeof(url), "wss://%s/%s/ws", SIGNAL_HOST, s_room_id);
    esp_websocket_client_config_t cfg = {
        .uri = url,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .reconnect_timeout_ms = 5000,
        .network_timeout_ms = 10000,
        .buffer_size = 4096,
        // Task creation fails at the default 6 KB stack on classic
        // ESP32-CAM by the time we get here — DRAM is fragmented after
        // camera + BLE + WiFi alloc. 4 KB is enough for the wss frame
        // pump (TLS context lives in mbedTLS heap, not the task stack).
        .task_stack = 4096,
    };
    s_ws = esp_websocket_client_init(&cfg);
    if (!s_ws) { ESP_LOGE(TAG, "ws init failed"); return; }
    esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, on_ws_event, NULL);
    esp_websocket_client_start(s_ws);
    ESP_LOGI(TAG, "rtc init: peer=%s room=%s", s_my_peer_id, s_room_id);
}
