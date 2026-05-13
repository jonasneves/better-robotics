#include "webrtc_peer.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_heap_caps.h"
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
#include "wifi_sta.h"

static const char *TAG = "rtc";

static esp_peer_handle_t s_peer;
static uint16_t s_active_offer_conn = 0;
// MID captured from the offer's a=group:BUNDLE line. esp_peer's answer
// hardcodes mid="0" / BUNDLE "0" but Chrome strictly requires the
// answer's BUNDLE/mid values to match the offer's (e.g. "datachannel").
// We rewrite the answer SDP in on_peer_msg before forwarding over BLE.
static char s_offer_mid[32] = "0";

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
static char *rewrite_answer_mid(const char *answer, const char *target_mid);

// ── BLE signaling ────────────────────────────────────────────────────────
//
// Two chunked transfers cross the signal char before the SDP answer goes
// back: the dashboard pushes ICE servers (TURN creds + STUN/TURN URLs as
// IP literals — DNS + HTTPS happen on the browser, not the chip), then
// the SDP offer. Each transfer uses a 3-opcode flow (begin/chunk/commit).
//
// Wire format:
//   0x01 [u16 BE total]  offer begin
//   0x02 [bytes]         offer chunk
//   0x03                 offer commit
//   0x04 [u16 BE total]  ice-servers begin
//   0x05 [bytes]         ice-servers chunk
//   0x06                 ice-servers commit
//   0xFF [utf8 msg]      error (notify-only, chip → dashboard)

#define BLE_SIG_MAX_OFFER  8192
#define BLE_SIG_MAX_ICE    1024
#define BLE_SIG_CHUNK      100

static char *s_ble_offer_buf = NULL;
static size_t s_ble_offer_total = 0;
static size_t s_ble_offer_received = 0;

static char  s_ice_buf[BLE_SIG_MAX_ICE + 1];
static size_t s_ice_total = 0;
static size_t s_ice_received = 0;
static bool   s_ice_ready = false;

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
    } else if (op == 0x04) {
        if (len < 3) { send_ble_signal_error("bad ice begin"); return; }
        size_t total = ((size_t)buf[1] << 8) | buf[2];
        if (total == 0 || total > BLE_SIG_MAX_ICE) {
            send_ble_signal_error("ice size out of range");
            return;
        }
        s_ice_total = total;
        s_ice_received = 0;
        s_ice_ready = false;
    } else if (op == 0x05) {
        size_t add = len - 1;
        if (s_ice_received + add > s_ice_total) {
            send_ble_signal_error("ice chunk overflow");
            s_ice_total = 0;
            return;
        }
        memcpy(s_ice_buf + s_ice_received, buf + 1, add);
        s_ice_received += add;
    } else if (op == 0x06) {
        if (s_ice_total == 0 || s_ice_received != s_ice_total) {
            send_ble_signal_error("ice incomplete");
            s_ice_total = 0;
            return;
        }
        s_ice_buf[s_ice_total] = 0;
        s_ice_ready = true;
        ESP_LOGI(TAG, "ble signal: ice servers received, %u B", (unsigned)s_ice_total);
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
// JPEG chunked into ≤1200 B pieces with framing header so the browser
// reassembles by frame_id. Channel is unreliable + unordered (dashboard
// opens it that way) so dropped chunks aren't retransmitted — the chip
// just sends a fresh frame. The RTP path (esp_peer_send_video MJPEG)
// triggered TWDT on classic ESP32 — esp_peer's binary lib blocks too
// long inside packetization. Chunked DC stays the working path.
//
// Wire format per chunk (binary on data channel):
//   [0..1] frame_id u16 BE
//   [2]    chunk_idx u8
//   [3]    total_chunks u8
//   [4..]  jpeg payload (≤ VIDEO_CHUNK_PAYLOAD bytes)
#define VIDEO_CHUNK_PAYLOAD  1200
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
        int retries = 0;
        while (rc == ESP_PEER_ERR_WOULD_BLOCK && retries++ < 5) {
            vTaskDelay(pdMS_TO_TICKS(2));
            rc = esp_peer_send_data(s_peer, &df);
        }
        if (rc != ESP_PEER_ERR_NONE) full_send = false;
        // 2 ms inter-chunk pacing — was 5 ms when WIFI_PS_MIN_MODEM was the
        // default and the radio needed wake-up time. With PS_NONE restored,
        // most of that delay is dead weight.
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

bool webrtc_peer_video_active(void) { return s_video_active; }

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

// Set in handle_video_dc when the dashboard says "stop". The loop task
// closes the peer after esp_peer_main_loop returns — closing from inside
// a callback (we'd be on the lib's stack) is unsafe.
static volatile bool s_close_requested = false;

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
            // Tear down the peer — SCTP keepalives + ICE consent +
            // DTLS heartbeats keep nibbling radio time even when no
            // frames flow. Dashboard re-issues an offer on next start.
            s_close_requested = true;
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
// Log m=, a=group:, a=mid: lines from an SDP for diagnosing m-line and
// MID mismatch between offer and answer (Chrome rejects answers whose
// m-lines or MIDs don't match the offer's order).
static void log_sdp_mlines(const char *tag, const char *sdp) {
    const char *p = sdp;
    int n = 0;
    const char *prefixes[] = { "\nm=", "\na=group:", "\na=mid:" };
    while (*p) {
        const char *next = NULL;
        for (size_t i = 0; i < sizeof(prefixes)/sizeof(prefixes[0]); i++) {
            const char *q = strstr(p, prefixes[i]);
            if (q && (!next || q < next)) next = q;
        }
        if (!next) break;
        p = next + 1;  // skip the \n
        const char *eol = strchr(p, '\r');
        if (!eol) eol = strchr(p, '\n');
        size_t len = eol ? (size_t)(eol - p) : strlen(p);
        if (len > 100) len = 100;
        ESP_LOGI(TAG, "  %s[%d]: %.*s", tag, n++, (int)len, p);
        p = eol ? eol : p + len;
    }
}

static int on_peer_msg(esp_peer_msg_t *msg, void *ctx) {
    if (!msg || !msg->data || msg->size <= 0) return 0;
    if (msg->type == ESP_PEER_MSG_TYPE_SDP) {
        ESP_LOGI(TAG, "esp_peer emitted SDP, %u B", (unsigned)msg->size);
        char *sdp = malloc(msg->size + 1);
        if (!sdp) return -1;
        memcpy(sdp, msg->data, msg->size);
        sdp[msg->size] = 0;
        log_sdp_mlines("answer", sdp);
        char *fixed = rewrite_answer_mid(sdp, s_offer_mid);
        if (fixed) {
            log_sdp_mlines("answer-fixed", fixed);
            send_answer_via_ble(fixed);
            free(fixed);
        } else {
            send_answer_via_ble(sdp);  // fallback if alloc failed
        }
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

// Strip TCP candidates from the offer SDP — chip can only use UDP for ICE.
// IPv6 stays: lwIP IPv6 is enabled, and v6 host↔host is the fast path on
// apartment networks where the v4 path goes through a slow centralized NAT.
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
            }
        }
        if (drop) dropped++;
        else { memcpy(out + o, p, line_len); o += line_len; }
        if (!eol) break;
        p = eol + 1;
    }
    out[o] = 0;
    if (dropped) ESP_LOGI(TAG, "filtered SDP: dropped %d TCP candidate(s)", dropped);
    return out;
}

// Pull the first MID out of "a=group:BUNDLE <mid>[ <mid>...]" so we can
// substitute it into esp_peer's answer (which always uses "0").
static void capture_offer_mid(const char *sdp) {
    const char *gb = strstr(sdp, "a=group:BUNDLE ");
    if (!gb) return;
    gb += 15;
    const char *eol = strchr(gb, '\r');
    if (!eol) eol = strchr(gb, '\n');
    if (!eol || eol <= gb) return;
    size_t len = (size_t)(eol - gb);
    const char *space = memchr(gb, ' ', len);
    if (space) len = (size_t)(space - gb);
    if (len == 0 || len >= sizeof(s_offer_mid)) return;
    memcpy(s_offer_mid, gb, len);
    s_offer_mid[len] = 0;
    ESP_LOGI(TAG, "captured offer MID: %s", s_offer_mid);
}

// Rewrite "a=group:BUNDLE 0" and "a=mid:0" in esp_peer's answer to use
// the offer's MID. Returns malloc'd buffer; caller frees. NULL on OOM.
static char *rewrite_answer_mid(const char *answer, const char *target_mid) {
    size_t old_len = strlen(answer);
    size_t target_len = strlen(target_mid);
    char *out = malloc(old_len + 64);
    if (!out) return NULL;
    size_t o = 0;
    const char *p = answer;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t line_len = eol ? (size_t)(eol - p + 1) : strlen(p);
        const char *prefix = NULL;
        size_t prefix_len = 0;
        if (strncmp(p, "a=group:BUNDLE ", 15) == 0) { prefix = "a=group:BUNDLE "; prefix_len = 15; }
        else if (strncmp(p, "a=mid:", 6) == 0)       { prefix = "a=mid:";          prefix_len = 6;  }
        if (prefix) {
            memcpy(out + o, prefix, prefix_len);  o += prefix_len;
            memcpy(out + o, target_mid, target_len); o += target_len;
            if (eol && eol > p && *(eol - 1) == '\r') out[o++] = '\r';
            out[o++] = '\n';
        } else {
            memcpy(out + o, p, line_len);
            o += line_len;
        }
        if (!eol) break;
        p = eol + 1;
    }
    out[o] = 0;
    return out;
}

static void handle_offer(const char *sdp) {
    ESP_LOGI(TAG, "handle_offer: sdp len=%u", (unsigned)strlen(sdp));
    log_sdp_mlines("offer", sdp);
    capture_offer_mid(sdp);
    if (s_peer) {
        stop_video_streaming();
        esp_peer_close(s_peer);
        s_peer = NULL;
        s_video_sid_known = false;
        s_ota_sid_known   = false;
        vTaskDelay(pdMS_TO_TICKS(500));
    }

    // ICE servers come pre-resolved from the dashboard via BLE opcode 0x04.
    // Browser already has working DNS + HTTPS, so it fetches Cloudflare
    // TURN creds and resolves hostnames before sending us IP literals;
    // chip skips DNS resolution and avoids the mbedTLS-over-PSRAM
    // handshake that used to add 5-30s of "perform: ESP_ERR_HTTP_CONNECT"
    // latency. Format (chunked utf-8 JSON):
    //   {"ice":[{"url":"turn:1.2.3.4:3478?transport=udp","user":"u","pass":"p"}, ...]}
    #define MAX_ICE_SERVERS 4
    static esp_peer_ice_server_cfg_t servers[MAX_ICE_SERVERS];
    static char server_url_storage[MAX_ICE_SERVERS][96];
    static char server_user_storage[MAX_ICE_SERVERS][160];
    static char server_pass_storage[MAX_ICE_SERVERS][160];
    int n_servers = 0;
    if (s_ice_ready) {
        cJSON *root = cJSON_ParseWithLength(s_ice_buf, s_ice_total);
        cJSON *arr = root ? cJSON_GetObjectItem(root, "ice") : NULL;
        if (cJSON_IsArray(arr)) {
            cJSON *item = NULL;
            cJSON_ArrayForEach(item, arr) {
                if (n_servers >= MAX_ICE_SERVERS) break;
                cJSON *url  = cJSON_GetObjectItem(item, "url");
                cJSON *user = cJSON_GetObjectItem(item, "user");
                cJSON *pass = cJSON_GetObjectItem(item, "pass");
                if (!cJSON_IsString(url)) continue;
                strlcpy(server_url_storage[n_servers], url->valuestring, sizeof(server_url_storage[n_servers]));
                servers[n_servers].stun_url = server_url_storage[n_servers];
                if (cJSON_IsString(user) && cJSON_IsString(pass)) {
                    strlcpy(server_user_storage[n_servers], user->valuestring, sizeof(server_user_storage[n_servers]));
                    strlcpy(server_pass_storage[n_servers], pass->valuestring, sizeof(server_pass_storage[n_servers]));
                    servers[n_servers].user = server_user_storage[n_servers];
                    servers[n_servers].psw  = server_pass_storage[n_servers];
                } else {
                    servers[n_servers].user = NULL;
                    servers[n_servers].psw  = NULL;
                }
                ESP_LOGI(TAG, "ice_servers[%d]: %s%s",
                         n_servers, server_url_storage[n_servers],
                         servers[n_servers].user ? " (auth)" : "");
                n_servers++;
            }
        }
        if (root) cJSON_Delete(root);
    }
    if (n_servers == 0) {
        ESP_LOGW(TAG, "ice_servers: none — host candidates only");
    }

    // Default-impl config — ipv6_support tells the agent to gather IPv6
    // host candidates alongside IPv4. Without this flag esp_peer 1.3.0
    // only binds AF_INET sockets, so the dashboard's IPv6 host can't
    // pair and ICE falls back to the slow IPv4 path.
    static esp_peer_default_cfg_t default_cfg = {
        .ipv6_support = true,
    };

    esp_peer_cfg_t cfg = {
        .extra_cfg           = &default_cfg,
        .extra_size          = sizeof(default_cfg),
        .role                = ESP_PEER_ROLE_CONTROLLED,    // we're the answerer
        .audio_dir           = ESP_PEER_MEDIA_DIR_NONE,
        // video_dir = NONE: RTP MJPEG path triggered TG1WDT_SYS_RESET
        // on the first esp_peer_send_video call. The binary lib's
        // packetizer was built for ESP32-S3 + hardware AES/SHA + Octal
        // PSRAM (esp_peer's example, esp-webrtc-solution demos, KVS
        // port — all S3). On classic ESP32 it disables interrupts long
        // enough to trip the system watchdog. ICE / DTLS / SCTP /
        // data-channel paths are fine on classic — we keep video on a
        // chunked binary data channel (3-5 fps verified). Revisit when
        // we move to ESP32-S3: flip video_dir to SEND_ONLY, set
        // video_info, drop chunking. One-flag change.
        .video_dir           = ESP_PEER_MEDIA_DIR_NONE,
        .enable_data_channel = true,
        .server_lists        = servers,
        .server_num          = n_servers,
        .on_state            = on_peer_state,
        .on_msg              = on_peer_msg,
        .on_data             = on_peer_data,
        .on_channel_open     = on_peer_channel_open,
        .on_channel_close    = on_peer_channel_close,
    };

    // libpeer needs ~50-80 KB of CONTIGUOUS internal RAM for DTLS + agent
    // + SRTP/SCTP allocations. The classic ESP32's ~280 KB internal heap
    // is shared with WiFi STA (~50 KB), BLE NimBLE, and camera reservations,
    // and fragments enough that esp_peer_open returns ESP_PEER_ERR_NO_MEM
    // (-2) even with multi-MB PSRAM free. Mirror the OTA pattern:
    // pause WiFi for the open call, resume after — same intervention used
    // for BLE OTA's NimBLE-ATT-drop pattern (see ota.c). After resume we
    // wait briefly for the STA to reassociate + DHCP so ICE gathering in
    // esp_peer_new_connection can collect host candidates; missing them
    // forces fallback to TURN-relay which adds 100-300 ms.
    size_t pre_internal = esp_get_free_internal_heap_size();
    size_t pre_largest = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
    ESP_LOGI(TAG, "pre-open heap: internal_free=%u largest=%u",
             (unsigned)pre_internal, (unsigned)pre_largest);
    wifi_sta_pause();
    size_t paused_largest = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
    ESP_LOGI(TAG, "wifi paused: internal_free=%u largest=%u",
             (unsigned)esp_get_free_internal_heap_size(), (unsigned)paused_largest);

    int rc = esp_peer_open(&cfg, esp_peer_get_default_impl(), &s_peer);

    wifi_sta_resume();
    // Block briefly for IP — without it, esp_peer_new_connection below
    // gathers no host candidates and ICE only succeeds via the TURN
    // relay. 3 s is generous on a previously-joined AP; falls through
    // if the AP is slow so we still attempt the connection.
    int ip_wait_ms = 0;
    while (!wifi_sta_has_ip() && ip_wait_ms < 3000) {
        vTaskDelay(pdMS_TO_TICKS(100));
        ip_wait_ms += 100;
    }
    ESP_LOGI(TAG, "wifi resumed: has_ip=%d after %d ms",
             (int)wifi_sta_has_ip(), ip_wait_ms);

    if (rc != ESP_PEER_ERR_NONE || !s_peer) {
        ESP_LOGE(TAG, "esp_peer_open failed: %d (largest internal block before/paused: %u/%u)",
                 rc, (unsigned)pre_largest, (unsigned)paused_largest);
        // Surface rc to the dashboard — heap-pressure failures look the
        // same as configuration errors without it. Error codes from
        // esp_peer_types.h: -1 INVALID_ARG, -2 NO_MEM, -3 WRONG_STATE,
        // -4 NOT_SUPPORT, -6 FAIL.
        char err_buf[48];
        snprintf(err_buf, sizeof(err_buf), "esp_peer_open failed: %d", rc);
        send_ble_signal_error(err_buf);
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
        if (s_close_requested && s_peer) {
            ESP_LOGI(TAG, "closing peer (video stopped, freeing radio)");
            esp_peer_close(s_peer);
            s_peer = NULL;
            s_video_sid_known = false;
            s_ota_sid_known   = false;
        }
        s_close_requested = false;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

// ── init ─────────────────────────────────────────────────────────────────

void webrtc_peer_init(const char *robot_name) {
    (void)robot_name;
    // esp_peer_pre_generate_cert() intentionally NOT called: when called
    // here at boot it monopolized the CPU long enough that NimBLE's host
    // task got starved during the dashboard's post-connect GATT discovery
    // — only attr=8 subscribed before Chrome timed out (reason 531). The
    // cert will generate on first handle_offer instead; that's fine since
    // BLE signaling already takes a few seconds.

    // Silence the chatty internal tags from esp_peer's binary lib once the
    // session is up. DTLS spams ERROR-level mbedtls_ssl_read=-26752 (which
    // is just "no UDP data right now," not a real failure). SCTP logs every
    // chunk receive. Keep PEER_DEF and AGENT (state transitions are useful).
    esp_log_level_set("DTLS", ESP_LOG_NONE);
    esp_log_level_set("SCTP", ESP_LOG_WARN);
    // "wifi:m f null" floods at WARN whenever radio coex drops a management
    // frame — happens continuously during WebRTC video on classic ESP32
    // (single radio shared with BLE + SCTP). Not actionable, just noise.
    esp_log_level_set("wifi", ESP_LOG_ERROR);
    // OV3660 emits "NO-SOI - JPEG start marker missing" on the first 1-2
    // frames after sensor init while AGC/AEC settle. Self-corrects;
    // suppress to keep the camera tag's actual errors visible.
    esp_log_level_set("cam_hal", ESP_LOG_ERROR);

    s_events = xQueueCreate(8, sizeof(event_t));
    if (!s_events) { ESP_LOGE(TAG, "queue create failed"); return; }

    // 12 KB stack — esp_peer's main_loop pulls in srtp + jitter buffer
    // beyond what libpeer needed. Bump if DTLS handshake stack-overflows.
    xTaskCreate(loop_task_fn, "rtc_loop", 12288, NULL, 5, &s_loop_task);
    ESP_LOGI(TAG, "rtc init: BLE-signaled WebRTC ready (esp_peer)");
}
