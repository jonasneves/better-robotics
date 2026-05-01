#include "webrtc_peer.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "esp_peer.h"
#include "esp_peer_default.h"
#include "esp_peer_types.h"

#include "esp_camera.h"

#include "camera.h"
#include "gatt_svr.h"
#include "ota.h"
#include "turn_creds.h"

static const char *TAG = "rtc";

static esp_peer_handle_t s_peer;
static uint16_t s_active_offer_conn = 0;

// Channel-id cache. esp_peer notifies us via on_channel_open with the
// label and the SCTP stream id; we look up by label later when we
// need to send (e.g. video pump finds "video"'s sid).
static uint16_t s_video_sid = 0;
static bool     s_video_sid_known = false;
static uint16_t s_ota_sid = 0;
static bool     s_ota_sid_known = false;

typedef enum { EV_OFFER_BLE } event_type_t;
typedef struct { event_type_t type; char *payload; } event_t;
static QueueHandle_t s_events;
static TaskHandle_t  s_loop_task;

static void stop_video_streaming(void);

// ── BLE signaling ────────────────────────────────────────────────────────

#define BLE_SIG_MAX_OFFER 8192
#define BLE_SIG_CHUNK     100

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
        if (!s_ble_offer_buf) { send_ble_signal_error("oom"); s_ble_offer_total = 0; return; }
        s_ble_offer_total = total;
        s_ble_offer_received = 0;
    } else if (op == 0x02) {
        if (!s_ble_offer_buf) return;
        size_t add = len - 1;
        if (s_ble_offer_received + add > s_ble_offer_total) {
            free(s_ble_offer_buf); s_ble_offer_buf = NULL;
            send_ble_signal_error("chunk overflow");
            return;
        }
        memcpy(s_ble_offer_buf + s_ble_offer_received, buf + 1, add);
        s_ble_offer_received += add;
    } else if (op == 0x03) {
        if (!s_ble_offer_buf || s_ble_offer_received != s_ble_offer_total) {
            free(s_ble_offer_buf); s_ble_offer_buf = NULL;
            send_ble_signal_error("offer incomplete");
            return;
        }
        ESP_LOGI(TAG, "ble signal: commit, offer assembled %u B",
                 (unsigned)s_ble_offer_total);
        s_ble_offer_buf[s_ble_offer_total] = 0;
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

// ── data channels ────────────────────────────────────────────────────────

static void send_dc_text(uint16_t sid, const char *text) {
    if (!s_peer) return;
    esp_peer_data_frame_t df = {
        .type = ESP_PEER_DATA_CHANNEL_STRING,
        .stream_id = sid,
        .data = (uint8_t *)text,
        .size = strlen(text),
    };
    esp_peer_send_data(s_peer, &df);
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
                if (ota_http_begin(total) != ESP_OK && s_ota_sid_known) {
                    send_dc_text(s_ota_sid, "{\"type\":\"error\",\"error\":\"ota_begin failed\"}");
                }
            } else if (strcmp(t, "commit") == 0) {
                if (s_ota_sid_known) {
                    if (ota_http_commit() == ESP_OK) {
                        send_dc_text(s_ota_sid, "{\"type\":\"staged\"}");
                    } else {
                        send_dc_text(s_ota_sid, "{\"type\":\"error\",\"error\":\"ota_commit failed\"}");
                    }
                }
            } else if (strcmp(t, "abort") == 0) {
                ota_http_abort();
            }
        }
        cJSON_Delete(root);
    } else {
        if (ota_http_write((const uint8_t *)msg, len) != ESP_OK && s_ota_sid_known) {
            send_dc_text(s_ota_sid, "{\"type\":\"error\",\"error\":\"ota_write failed\"}");
        }
    }
}

// ── video over data channel ──────────────────────────────────────────────
//
// Chunked binary blobs on a data channel labeled "video". Browser
// reassembles by frame_id (mjpeg-stream.js). esp_peer's send_data
// returns ESP_PEER_ERR_WOULD_BLOCK on backpressure — we still pace
// chunks with vTaskDelay(2) since the radio is the real bottleneck.
//
// Wire format per chunk:
//   [0..1] frame_id u16 BE   [2] chunk_idx   [3] total_chunks   [4..] payload

#define VIDEO_CHUNK_PAYLOAD  900
#define VIDEO_CHUNK_HEADER   4

static volatile bool s_video_active = false;
static int     s_video_fps = 10;
static int64_t s_video_last_frame_us = 0;
static uint16_t s_video_frame_id = 0;
static int     s_video_frame_count = 0;

static void video_pump_tick(void) {
    if (!s_video_active || !camera_ready() || !s_peer || !s_video_sid_known) return;
    int64_t now = esp_timer_get_time();
    int64_t period_us = (int64_t)1000000 / (s_video_fps > 0 ? s_video_fps : 10);
    if (now - s_video_last_frame_us < period_us) return;
    s_video_last_frame_us = now;

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) { ESP_LOGW(TAG, "video pump: fb_get failed"); return; }

    size_t total_chunks = (fb->len + VIDEO_CHUNK_PAYLOAD - 1) / VIDEO_CHUNK_PAYLOAD;
    if (total_chunks > 255) {
        ESP_LOGW(TAG, "video pump: frame too big (%u B, %u chunks)",
                 (unsigned)fb->len, (unsigned)total_chunks);
        esp_camera_fb_return(fb);
        return;
    }

    s_video_frame_id++;
    uint8_t buf[VIDEO_CHUNK_HEADER + VIDEO_CHUNK_PAYLOAD];
    bool full_send = true;
    for (size_t chunk = 0; chunk < total_chunks; chunk++) {
        size_t off  = chunk * VIDEO_CHUNK_PAYLOAD;
        size_t plen = fb->len - off;
        if (plen > VIDEO_CHUNK_PAYLOAD) plen = VIDEO_CHUNK_PAYLOAD;
        buf[0] = (s_video_frame_id >> 8) & 0xff;
        buf[1] =  s_video_frame_id       & 0xff;
        buf[2] = (uint8_t)chunk;
        buf[3] = (uint8_t)total_chunks;
        memcpy(buf + VIDEO_CHUNK_HEADER, fb->buf + off, plen);
        esp_peer_data_frame_t df = {
            .type = ESP_PEER_DATA_CHANNEL_DATA,
            .stream_id = s_video_sid,
            .data = buf,
            .size = VIDEO_CHUNK_HEADER + plen,
        };
        int rc = esp_peer_send_data(s_peer, &df);
        // WOULD_BLOCK = esp_peer's tx queue full; brief yield + retry.
        // After a few retries, drop the chunk (frame will be incomplete;
        // browser drops by frame_id mismatch on next frame).
        int retries = 0;
        while (rc == ESP_PEER_ERR_WOULD_BLOCK && retries++ < 5) {
            vTaskDelay(pdMS_TO_TICKS(3));
            rc = esp_peer_send_data(s_peer, &df);
        }
        if (rc != ESP_PEER_ERR_NONE) full_send = false;
        if (chunk + 1 < total_chunks) vTaskDelay(pdMS_TO_TICKS(2));
    }

    s_video_frame_count++;
    if ((s_video_frame_count % 10) == 0) {
        ESP_LOGI(TAG, "video pump: frame #%d (id=%u), %u B in %u chunks → sid=%u %s",
                 s_video_frame_count, s_video_frame_id, (unsigned)fb->len,
                 (unsigned)total_chunks, s_video_sid, full_send ? "ok" : "partial");
    }
    esp_camera_fb_return(fb);
}

static void start_video_streaming(int fps) {
    s_video_fps = (fps > 0 && fps <= 30) ? fps : 10;
    s_video_active = true;
    s_video_last_frame_us = 0;
    ESP_LOGI(TAG, "video stream started, fps=%d", s_video_fps);
}

static void stop_video_streaming(void) {
    if (s_video_active) ESP_LOGI(TAG, "video stream stopped");
    s_video_active = false;
}

static void handle_video_dc(const char *msg, size_t len) {
    if (len == 0 || msg[0] != '{') return;
    cJSON *root = cJSON_ParseWithLength(msg, len);
    if (!root) return;
    cJSON *type = cJSON_GetObjectItem(root, "type");
    if (cJSON_IsString(type)) {
        const char *t = type->valuestring;
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

// ── esp_peer callbacks ───────────────────────────────────────────────────

static int on_peer_state(esp_peer_state_t state, void *ctx) {
    ESP_LOGI(TAG, "esp_peer state: %d", (int)state);
    if (state == ESP_PEER_STATE_DISCONNECTED ||
        state == ESP_PEER_STATE_CLOSED ||
        state == ESP_PEER_STATE_CONNECT_FAILED ||
        state == ESP_PEER_STATE_DATA_CHANNEL_CLOSED ||
        state == ESP_PEER_STATE_DATA_CHANNEL_DISCONNECTED) {
        stop_video_streaming();
        s_video_sid_known = false;
        s_ota_sid_known   = false;
    }
    return 0;
}

// Outbound message from esp_peer — answer SDP or trickle ICE candidate.
// We ship SDP back over BLE; ignore trickle candidates because the
// answer SDP includes them all by the time esp_peer emits it (with the
// default impl, anyway).
static int on_peer_msg(esp_peer_msg_t *msg, void *ctx) {
    if (!msg || !msg->data || msg->size <= 0) return 0;
    if (msg->type == ESP_PEER_MSG_TYPE_SDP) {
        ESP_LOGI(TAG, "esp_peer emitted SDP, %u B", (unsigned)msg->size);
        // Null-terminate defensively; esp_peer is supposed to but no harm.
        char *sdp = malloc(msg->size + 1);
        if (!sdp) return -1;
        memcpy(sdp, msg->data, msg->size);
        sdp[msg->size] = 0;
        send_answer_via_ble(sdp);
        free(sdp);
    } else if (msg->type == ESP_PEER_MSG_TYPE_CANDIDATE) {
        ESP_LOGD(TAG, "esp_peer emitted ICE candidate (ignored — no trickle over BLE)");
    }
    return 0;
}

static int on_peer_channel_open(esp_peer_data_channel_info_t *ch, void *ctx) {
    if (!ch || !ch->label) return 0;
    ESP_LOGI(TAG, "data channel open: label=%s sid=%u", ch->label, ch->stream_id);
    if (strcmp(ch->label, "video") == 0) {
        s_video_sid = ch->stream_id;
        s_video_sid_known = true;
    } else if (strcmp(ch->label, "ota") == 0) {
        s_ota_sid = ch->stream_id;
        s_ota_sid_known = true;
    }
    return 0;
}

static int on_peer_channel_close(esp_peer_data_channel_info_t *ch, void *ctx) {
    if (ch && ch->label) ESP_LOGI(TAG, "data channel close: label=%s", ch->label);
    stop_video_streaming();
    return 0;
}

static int on_peer_data(esp_peer_data_frame_t *frame, void *ctx) {
    if (!frame || !frame->data) return 0;
    if (s_video_sid_known && frame->stream_id == s_video_sid) {
        handle_video_dc((const char *)frame->data, frame->size);
    } else if (s_ota_sid_known && frame->stream_id == s_ota_sid) {
        handle_ota_dc((const char *)frame->data, frame->size);
    }
    return 0;
}

// ── peer connection lifecycle ────────────────────────────────────────────

// Strip lines libpeer's parser couldn't process from the offer SDP. esp_peer
// is more robust but we keep the filter — TCP candidates and IPv6 candidates
// can't be used by the chip on this network (no v6, libpeer-era TURN client
// was UDP-only). Cheap defensive cleanup.
static char *filter_sdp_for_chip(const char *sdp) {
    size_t in_len = strlen(sdp);
    char *out = malloc(in_len + 1);
    if (!out) return NULL;
    size_t o = 0;
    const char *p = sdp;
    int dropped = 0;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t line_len = eol ? (size_t)(eol - p + 1) : strlen(p);
        bool drop = false;
        if (strncmp(p, "a=candidate:", 12) == 0) {
            const char *q = p + 12;
            int tok = 0;
            while (q < p + line_len && tok < 2) {
                while (q < p + line_len && *q != ' ') q++;
                while (q < p + line_len && *q == ' ') q++;
                tok++;
            }
            if (q < p + line_len && (q[0] == 't' || q[0] == 'T')
                                  && (q[1] == 'c' || q[1] == 'C')
                                  && (q[2] == 'p' || q[2] == 'P')) {
                drop = true;
            } else {
                int adv = 0;
                while (q < p + line_len && adv < 3) {
                    while (q < p + line_len && *q != ' ') q++;
                    while (q < p + line_len && *q == ' ') q++;
                    adv++;
                }
                if (q < p + line_len && memchr(q, ':',
                        (size_t)((p + line_len) - q)) != NULL) {
                    drop = true;
                }
            }
        }
        if (drop) dropped++;
        else { memcpy(out + o, p, line_len); o += line_len; }
        if (!eol) break;
        p = eol + 1;
    }
    out[o] = 0;
    if (dropped) ESP_LOGI(TAG, "filtered SDP: dropped %d candidate line(s)", dropped);
    return out;
}

static void handle_offer(const char *sdp) {
    ESP_LOGI(TAG, "handle_offer: sdp len=%u", (unsigned)strlen(sdp));
    if (s_peer) {
        stop_video_streaming();
        esp_peer_close(s_peer);
        s_peer = NULL;
        s_video_sid_known = false;
        s_ota_sid_known   = false;
        vTaskDelay(pdMS_TO_TICKS(500));
    }

    // ICE servers — STUN baseline + Cloudflare TURN if creds are ready.
    // turn_url is pre-resolved to an IP literal (turn_creds.c) so the
    // peer's gather doesn't synchronously getaddrinfo() in the BLE
    // signaling window.
    static esp_peer_ice_server_cfg_t servers[2];
    int n_servers = 0;
    servers[n_servers++] = (esp_peer_ice_server_cfg_t){
        .stun_url = (char *)"stun:stun.l.google.com:19302",
    };
    const char *turn_user = turn_creds_username();
    const char *turn_pass = turn_creds_credential();
    const char *turn_url  = turn_creds_url();
    if (turn_user && turn_pass && turn_url) {
        servers[n_servers++] = (esp_peer_ice_server_cfg_t){
            .stun_url = (char *)turn_url,
            .user     = (char *)turn_user,
            .psw      = (char *)turn_pass,
        };
        ESP_LOGI(TAG, "ice_servers: STUN + Cloudflare TURN(%s)", turn_url);
    } else {
        ESP_LOGW(TAG, "ice_servers: STUN-only (turn_creds not ready)");
    }

    esp_peer_cfg_t cfg = {
        .role                = ESP_PEER_ROLE_CONTROLLED,    // we're the answerer
        .audio_dir           = ESP_PEER_MEDIA_DIR_NONE,
        .video_dir           = ESP_PEER_MEDIA_DIR_NONE,     // video rides the data channel
        .enable_data_channel = true,
        .server_lists        = servers,
        .server_num          = n_servers,
        .on_state            = on_peer_state,
        .on_msg              = on_peer_msg,
        .on_data             = on_peer_data,
        .on_channel_open     = on_peer_channel_open,
        .on_channel_close    = on_peer_channel_close,
    };

    int rc = esp_peer_open(&cfg, esp_peer_get_default_impl(), &s_peer);
    if (rc != ESP_PEER_ERR_NONE || !s_peer) {
        ESP_LOGE(TAG, "esp_peer_open failed: %d", rc);
        send_ble_signal_error("esp_peer_open failed");
        return;
    }

    // Inject the remote offer. esp_peer will gather candidates and emit
    // the local SDP via on_peer_msg → send_answer_via_ble (async).
    char *filtered = filter_sdp_for_chip(sdp);
    const char *sdp_in = filtered ? filtered : sdp;
    esp_peer_msg_t msg = {
        .type = ESP_PEER_MSG_TYPE_SDP,
        .data = (uint8_t *)sdp_in,
        .size = (int)strlen(sdp_in),
    };
    rc = esp_peer_send_msg(s_peer, &msg);
    free(filtered);
    if (rc != ESP_PEER_ERR_NONE) {
        ESP_LOGE(TAG, "esp_peer_send_msg(SDP) failed: %d", rc);
        send_ble_signal_error("send_msg failed");
        return;
    }

    rc = esp_peer_new_connection(s_peer);
    if (rc != ESP_PEER_ERR_NONE) {
        ESP_LOGE(TAG, "esp_peer_new_connection failed: %d", rc);
        send_ble_signal_error("new_connection failed");
        return;
    }

    ESP_LOGI(TAG, "handle_offer: SDP injected, awaiting on_msg → BLE answer");
}

// ── loop task ────────────────────────────────────────────────────────────

static void loop_task_fn(void *arg) {
    event_t ev;
    while (1) {
        while (xQueueReceive(s_events, &ev, 0) == pdTRUE) {
            if (ev.type == EV_OFFER_BLE) handle_offer(ev.payload);
            free(ev.payload);
        }
        if (s_peer) esp_peer_main_loop(s_peer);
        video_pump_tick();
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

// ── init ─────────────────────────────────────────────────────────────────

void webrtc_peer_init(const char *robot_name) {
    (void)robot_name;
    // Pre-generate DTLS cert at boot — moves the ~800 ms gen out of the
    // 30 s BLE handshake window so the answer comes back fast.
    esp_peer_pre_generate_cert();

    s_events = xQueueCreate(8, sizeof(event_t));
    if (!s_events) { ESP_LOGE(TAG, "queue create failed"); return; }

    // 12 KB stack — esp_peer's main_loop pulls in srtp + jitter buffer
    // beyond what libpeer needed. Bump if DTLS handshake stack-overflows.
    xTaskCreate(loop_task_fn, "rtc_loop", 12288, NULL, 5, &s_loop_task);
    ESP_LOGI(TAG, "rtc init: BLE-signaled WebRTC ready (esp_peer)");
}
