#include "sdkconfig.h"
#ifdef CONFIG_BR_WEBRTC_ESP_PEER

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
// Forward decl: dtls_srtp.h lives under esp_peer/src and isn't on the
// public include path. We only need this one entry point (called once
// per browser-supplied cert push), so a local extern is cleaner than
// promoting the whole header to public.
extern int dtls_srtp_supply_cert(const unsigned char *cert_pem, size_t cert_len,
                                 const unsigned char *key_pem,  size_t key_len);

#include "esp_camera.h"

#include "camera.h"
#include "gatt_svr.h"
#include "ota.h"
#include "wifi_sta.h"

static const char *TAG = "rtc";

static esp_peer_handle_t s_peer;
static uint16_t s_active_offer_conn = 0;
// SDP MID matching: the dashboard pins MID="0" in its offer
// (offerStripTcpAndPinMid in webrtc-robot.js) so libpeer's hardcoded
// "0" in the answer matches without any chip-side rewrite. Same place
// also pre-strips TCP candidates (chip is UDP-only) and the dashboard
// flips setup:passive→active on the incoming answer
// (answerSetupActive in webrtc-robot.js). Centralizing all chip-quirk
// SDP knowledge in the dashboard removes ~140 LOC of string-walking
// from this TU.

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
//
// Three chunked transfers cross the signal char before the SDP answer goes
// back: the dashboard pushes (a) an ECDSA P-256 cert+key it generated in
// WebCrypto, (b) ICE servers (TURN creds + STUN/TURN URLs as IP literals),
// then (c) the SDP offer. Each transfer uses a 3-opcode flow
// (begin/chunk/commit). The cert push is OPTIONAL — when omitted, dtls_srtp
// falls back to chip-generated self-signed (~100-200 ms ECDSA gen at init).
//
// Wire format:
//   0x01 [u16 BE total]                        offer begin
//   0x02 [bytes]                               offer chunk
//   0x03                                       offer commit
//   0x04 [u16 BE total]                        ice-servers begin
//   0x05 [bytes]                               ice-servers chunk
//   0x06                                       ice-servers commit
//   0x07 [u16 BE cert_len] [u16 BE key_len]   cert+key begin (5 bytes)
//   0x08 [bytes]                               cert+key chunk
//   0x09                                       cert+key commit
//   0xFF [utf8 msg]                            error (notify-only, chip → dashboard)
//
// Cert+key wire layout: cert_pem bytes immediately followed by key_pem
// bytes, totaling cert_len + key_len. Both PEM, NUL-terminated when each
// is parsed (chip writes the NUL after copy). cert_len + key_len capped
// at BLE_SIG_MAX_CERT to keep chunk-state bounded.

#define BLE_SIG_MAX_OFFER  8192
#define BLE_SIG_MAX_ICE    1024
#define BLE_SIG_MAX_CERT   4096
#define BLE_SIG_CHUNK      100

static char *s_ble_offer_buf = NULL;
static size_t s_ble_offer_total = 0;
static size_t s_ble_offer_received = 0;

static char  s_ice_buf[BLE_SIG_MAX_ICE + 1];
static size_t s_ice_total = 0;
static size_t s_ice_received = 0;
static bool   s_ice_ready = false;

static uint8_t *s_cert_buf = NULL;
static size_t s_cert_total = 0;     // cert_len + key_len from begin opcode
static size_t s_cert_cert_len = 0;  // boundary inside s_cert_buf
static size_t s_cert_received = 0;

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
    } else if (op == 0x07) {
        // cert+key begin — payload = u16 BE cert_len, u16 BE key_len.
        if (len < 5) { send_ble_signal_error("bad cert begin"); return; }
        size_t cert_len = ((size_t)buf[1] << 8) | buf[2];
        size_t key_len  = ((size_t)buf[3] << 8) | buf[4];
        size_t total = cert_len + key_len;
        if (cert_len == 0 || key_len == 0 || total > BLE_SIG_MAX_CERT) {
            send_ble_signal_error("cert size out of range");
            return;
        }
        free(s_cert_buf);
        s_cert_buf = malloc(total);
        if (!s_cert_buf) { send_ble_signal_error("oom"); s_cert_total = 0; return; }
        s_cert_total    = total;
        s_cert_cert_len = cert_len;
        s_cert_received = 0;
    } else if (op == 0x08) {
        if (!s_cert_buf) return;
        size_t add = len - 1;
        if (s_cert_received + add > s_cert_total) {
            free(s_cert_buf); s_cert_buf = NULL;
            send_ble_signal_error("cert chunk overflow");
            return;
        }
        memcpy(s_cert_buf + s_cert_received, buf + 1, add);
        s_cert_received += add;
    } else if (op == 0x09) {
        if (!s_cert_buf || s_cert_received != s_cert_total) {
            free(s_cert_buf); s_cert_buf = NULL;
            send_ble_signal_error("cert incomplete");
            return;
        }
        // PEM is text — dtls_srtp_supply_cert treats the buffer as a string
        // and writes its own trailing NUL. mbedtls_*_parse functions take an
        // explicit length anyway; passing buflen+1 lets the trailing NUL
        // fit the cached PEM slot.
        int rc = dtls_srtp_supply_cert(s_cert_buf, s_cert_cert_len,
                                       s_cert_buf + s_cert_cert_len,
                                       s_cert_total - s_cert_cert_len);
        if (rc != 0) {
            send_ble_signal_error("cert reject");
        } else {
            ESP_LOGI(TAG, "ble signal: cert+key handed to dtls (%u + %u B)",
                     (unsigned)s_cert_cert_len,
                     (unsigned)(s_cert_total - s_cert_cert_len));
        }
        free(s_cert_buf);
        s_cert_buf = NULL;
        s_cert_total = 0;
        s_cert_cert_len = 0;
        s_cert_received = 0;
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

// Route by DC frame type, not first-byte heuristic — a binary chunk whose
// first byte happens to be '{' (0x7B) would otherwise be misparsed as JSON
// and silently dropped from the OTA bin. Roughly 1 in 256 chunk offsets
// in a real firmware image hit that byte, so the old heuristic was a
// time-bomb waiting for the wrong bin.
static void handle_ota_dc(const char *msg, size_t len, esp_peer_data_channel_type_t type) {
    if (len == 0) return;
    if (type == ESP_PEER_DATA_CHANNEL_STRING) {
        cJSON *root = cJSON_ParseWithLength(msg, len);
        if (!root) return;
        cJSON *cmd_type = cJSON_GetObjectItem(root, "type");
        if (cJSON_IsString(cmd_type)) {
            const char *t = cmd_type->valuestring;
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
// libpeer has an undocumented per-message ceiling — empirically 4096 breaks
// the stream outright, 2048 slows it below baseline (WOULD_BLOCK retries +
// partial-frame drops). 1200 is the largest known-good value. Attack frame
// size (sensor JPEG QF) or the inter-chunk vTaskDelay below if more headroom
// is needed; chunk size is a dead lever.
#define VIDEO_CHUNK_PAYLOAD  1200
#define VIDEO_CHUNK_HEADER   4

static volatile bool s_video_active = false;
static int     s_video_fps = 10;
static int64_t s_video_last_frame_us = 0;
static uint16_t s_video_frame_id = 0;
static int     s_video_frame_count = 0;
// Static-storage (BSS) so larger chunk payloads don't blow the pump task's
// stack. Single-writer (video_pump_tick is the only caller path).
static uint8_t s_video_chunk_buf[VIDEO_CHUNK_HEADER + VIDEO_CHUNK_PAYLOAD];

static void video_pump_tick(void) {
    // s_video_active is set true by start_video_streaming AFTER a
    // successful camera_acquire, so the camera is guaranteed live here.
    if (!s_video_active || !s_peer || !s_video_sid_known) return;
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
    bool full_send = true;
    for (size_t chunk = 0; chunk < total_chunks; chunk++) {
        size_t off  = chunk * VIDEO_CHUNK_PAYLOAD;
        size_t plen = fb->len - off;
        if (plen > VIDEO_CHUNK_PAYLOAD) plen = VIDEO_CHUNK_PAYLOAD;
        s_video_chunk_buf[0] = (s_video_frame_id >> 8) & 0xff;
        s_video_chunk_buf[1] =  s_video_frame_id       & 0xff;
        s_video_chunk_buf[2] = (uint8_t)chunk;
        s_video_chunk_buf[3] = (uint8_t)total_chunks;
        memcpy(s_video_chunk_buf + VIDEO_CHUNK_HEADER, fb->buf + off, plen);
        esp_peer_data_frame_t df = {
            .type = ESP_PEER_DATA_CHANNEL_DATA,
            .stream_id = s_video_sid,
            .data = s_video_chunk_buf,
            .size = VIDEO_CHUNK_HEADER + plen,
        };
        int rc = esp_peer_send_data(s_peer, &df);
        int retries = 0;
        while (rc == ESP_PEER_ERR_WOULD_BLOCK && retries++ < 5) {
            vTaskDelay(pdMS_TO_TICKS(2));
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

bool webrtc_peer_video_active(void) { return s_video_active; }

static void start_video_streaming(int fps) {
    if (s_video_active) return;  // already streaming; ignore duplicate start
    if (!camera_acquire()) {
        ESP_LOGW(TAG, "video stream start: camera_acquire failed (largest internal=%u)",
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
        return;
    }
    s_video_fps = (fps > 0 && fps <= 30) ? fps : 10;
    s_video_active = true;
    s_video_last_frame_us = 0;
    ESP_LOGI(TAG, "video stream started, fps=%d", s_video_fps);
}

static void stop_video_streaming(void) {
    if (!s_video_active) return;
    s_video_active = false;
    camera_release();
    ESP_LOGI(TAG, "video stream stopped");
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
// Log m=, a=group:, a=mid:, and a=candidate: lines from an SDP. The
// m=/group:/mid: lines diagnose Chrome's strict m-line and MID ordering
// (Chrome rejects answers with mismatched MIDs). The a=candidate: lines
// surface what ICE will actually pair against — load-bearing when one
// side is policy-restricted (relay-only) and we need to confirm the
// other side's candidate set includes a compatible type.
static void log_sdp_mlines(const char *tag, const char *sdp) {
    const char *p = sdp;
    int n = 0;
    const char *prefixes[] = { "\nm=", "\na=group:", "\na=mid:", "\na=candidate:" };
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
        if (len > 140) len = 140;  // candidate lines run long
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
        handle_ota_dc((const char *)frame->data, frame->size, frame->type);
    }
    return 0;
}

// ── peer connection lifecycle ────────────────────────────────────────────

static void handle_offer(const char *sdp) {
    ESP_LOGI(TAG, "handle_offer: sdp len=%u", (unsigned)strlen(sdp));
    log_sdp_mlines("offer", sdp);
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

    // ipv6_support ON — gather IPv6 host candidates alongside IPv4. The
    // Pi (aiortc) just did sustained DTLS-protected video over T-Mobile
    // cellular v6 host-host on this same hotspot, so v6 is a real path
    // when both peers have it. Earlier disable in 658eb90 attributed
    // libpeer-on-ESP32 DTLS timeouts to "cellular v6 traps DTLS"; that
    // attribution was wrong (Pi proves the network is fine). If libpeer
    // still locks up here, the bug is in libpeer, not the network — and
    // the right fix is upstream, not more SDP filtering.
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

    // libpeer needs ~50-80 KB of contiguous internal RAM for DTLS + agent
    // + SRTP/SCTP allocations; PSRAM is irrelevant (crypto can't run from
    // it). The camera DMA buffer (~32 KB, internal-only on classic ESP32)
    // used to be the bottleneck — it was kept allocated at boot regardless
    // of consumer activity, leaving ~21 KB contiguous and tripping
    // esp_peer_open with NO_MEM (-2). Now camera_probe()/acquire()/release()
    // bound the camera lifecycle to consumers (this file's video pump,
    // http_stream, snapshot), so by the time we get here the camera is
    // off and contiguous heap is plentiful. Heap log kept as a diagnostic
    // anchor for future regressions.
    ESP_LOGI(TAG, "pre-open heap: internal_free=%u largest=%u",
             (unsigned)esp_get_free_internal_heap_size(),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));

    int rc = esp_peer_open(&cfg, esp_peer_get_default_impl(), &s_peer);

    if (rc != ESP_PEER_ERR_NONE || !s_peer) {
        ESP_LOGE(TAG, "esp_peer_open failed: %d", rc);
        // Surface rc to the dashboard. esp_peer_types.h: -1 INVALID_ARG,
        // -2 NO_MEM, -3 WRONG_STATE, -4 NOT_SUPPORT, -6 FAIL.
        char err_buf[48];
        snprintf(err_buf, sizeof(err_buf), "esp_peer_open failed: %d", rc);
        send_ble_signal_error(err_buf);
        return;
    }

    // Inject the remote offer. esp_peer will gather candidates and emit
    // the local SDP via on_peer_msg → send_answer_via_ble (async). The
    // offer arrives pre-filtered from the dashboard (TCP candidates
    // already stripped, MID pinned to "0").
    esp_peer_msg_t msg = {
        .type = ESP_PEER_MSG_TYPE_SDP,
        .data = (uint8_t *)sdp,
        .size = (int)strlen(sdp),
    };
    rc = esp_peer_send_msg(s_peer, &msg);
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
        // 10ms was a 100 Hz cap on pump_tick, which (combined with the
        // esp_peer_main_loop time ahead of it) capped video at ~10-14 fps.
        // 2ms keeps the task yielding to WiFi/BLE between iterations but
        // lets the pump fire often enough to actually reach the requested
        // fps. esp_peer_main_loop yields internally so other tasks still
        // breathe.
        vTaskDelay(pdMS_TO_TICKS(2));
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
    // TEMP: DTLS at ERROR (was NONE) so handshake error codes are visible
    // while diagnosing why DTLS times out even with patched ECDSA cert.
    esp_log_level_set("DTLS", ESP_LOG_ERROR);
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
    //
    // Pinned to APP_CPU (1) — NimBLE host (CONFIG_BT_NIMBLE_PINNED_TO_CORE=0)
    // and WiFi (CONFIG_ESP_WIFI_TASK_PINNED_TO_CORE_0) both live on PRO_CPU.
    // Unpinned, rtc_loop floats onto PRO_CPU during the CPU-bound DTLS
    // handshake / SCTP packing bursts and competes with the BLE host for
    // scheduler slots — peer eventually terminates the link with reason
    // 520 (BLE_HS_HCI_BASE + BLE_ERR_CONN_TMO). Same shape as snapshot.c's
    // transfer task, which has the same constraint.
    xTaskCreatePinnedToCore(loop_task_fn, "rtc_loop", 12288, NULL, 5, &s_loop_task, 1);
    ESP_LOGI(TAG, "rtc init: BLE-signaled WebRTC ready (esp_peer)");
}

#endif // CONFIG_BR_WEBRTC_ESP_PEER
