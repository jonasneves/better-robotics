#include "pair_mailbox.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "host/ble_hs.h"

#include "ble_host.h"
#include "gatt_svr.h"

static const char *TAG = "mailbox";

// Ring buffer depth. 8 ads cover desktop's offer + phone's answer +
// trickle ICE on each side with margin. Each slot is a fixed 384 B
// upper bound — covers the signed-ad envelope (peer-key.js Ed25519
// pubkey + sig + JSON payload of room id / role / timestamp).
#define MAILBOX_DEPTH    8
// Sized for the largest signed envelope we send: pair-request carries
// target pubkey (88 B base64) + nonce (UUID 36 B) + label + _pubkey
// (88 B) + _sig (88 B) + JSON overhead ≈ 480 B. 768 leaves headroom
// for future fields without forcing a firmware bump every time the
// signed-ad shape grows by a key.
#define MAILBOX_AD_MAX   768

// Wire envelope on the mailbox char (matches SIGNAL_CHAR / OPS):
//   0x01 [u16 BE total]   begin
//   0x02 [bytes]          chunk
//   0x03                  commit
// Chunk size kept under the safe ATT MTU on macOS/Chrome (~185 B
// negotiated). Notify frames go out the same shape.
#define MBX_OP_BEGIN  0x01
#define MBX_OP_CHUNK  0x02
#define MBX_OP_COMMIT 0x03
#define MBX_NOTIFY_CHUNK 100

typedef struct {
    uint16_t len;
    uint8_t  bytes[MAILBOX_AD_MAX];
} mailbox_ad_t;

// Per-source-conn reassembly. A concurrent writer (phone + desktop both
// posting ads simultaneously) needs distinct rx slots so their chunks
// don't get spliced into the same buffer.
typedef struct {
    uint16_t conn;       // BLE_HS_CONN_HANDLE_NONE when slot free
    uint16_t expected;
    uint16_t got;
    uint8_t  buf[MAILBOX_AD_MAX];
} mailbox_rx_t;

static mailbox_ad_t s_ring[MAILBOX_DEPTH];
static int s_count = 0;       // valid slots, clamped to MAILBOX_DEPTH
static int s_next  = 0;       // next slot to overwrite (oldest)
static SemaphoreHandle_t s_mutex;
static mailbox_rx_t s_rx[BLE_HOST_MAX_CONNS];

void pair_mailbox_init(void) {
    s_mutex = xSemaphoreCreateMutex();
    for (int i = 0; i < BLE_HOST_MAX_CONNS; i++) s_rx[i].conn = BLE_HS_CONN_HANDLE_NONE;
}

static mailbox_rx_t *rx_for(uint16_t conn, bool create) {
    for (int i = 0; i < BLE_HOST_MAX_CONNS; i++) {
        if (s_rx[i].conn == conn) return &s_rx[i];
    }
    if (!create) return NULL;
    for (int i = 0; i < BLE_HOST_MAX_CONNS; i++) {
        if (s_rx[i].conn == BLE_HS_CONN_HANDLE_NONE) {
            s_rx[i].conn = conn;
            s_rx[i].expected = 0;
            s_rx[i].got = 0;
            return &s_rx[i];
        }
    }
    return NULL;
}

static void rx_release(mailbox_rx_t *rx) {
    rx->conn = BLE_HS_CONN_HANDLE_NONE;
    rx->expected = 0;
    rx->got = 0;
}

static void store_ad(const uint8_t *buf, size_t len) {
    if (len == 0 || len > MAILBOX_AD_MAX) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_ring[s_next].len = (uint16_t)len;
    memcpy(s_ring[s_next].bytes, buf, len);
    s_next = (s_next + 1) % MAILBOX_DEPTH;
    if (s_count < MAILBOX_DEPTH) s_count++;
    xSemaphoreGive(s_mutex);
}

// Emit a fully-assembled ad to one subscriber as a chunked envelope.
// Each notify is one frame (begin / chunk / commit) — receivers reassemble.
static void send_chunked(uint16_t conn, const uint8_t *buf, size_t len) {
    uint8_t hdr[3] = { MBX_OP_BEGIN, (uint8_t)(len >> 8), (uint8_t)(len & 0xff) };
    gatt_svr_pair_mailbox_send(conn, hdr, sizeof(hdr));
    uint8_t frame[1 + MBX_NOTIFY_CHUNK];
    frame[0] = MBX_OP_CHUNK;
    for (size_t off = 0; off < len; off += MBX_NOTIFY_CHUNK) {
        size_t take = len - off > MBX_NOTIFY_CHUNK ? MBX_NOTIFY_CHUNK : (len - off);
        memcpy(&frame[1], &buf[off], take);
        gatt_svr_pair_mailbox_send(conn, frame, 1 + take);
    }
    uint8_t commit = MBX_OP_COMMIT;
    gatt_svr_pair_mailbox_send(conn, &commit, 1);
}

static void broadcast_ad(uint16_t skip_conn, const uint8_t *buf, size_t len) {
    (void)skip_conn;  // see below
    uint16_t conns[BLE_HOST_MAX_CONNS];
    size_t n = ble_host_active_conns(conns, BLE_HOST_MAX_CONNS);
    for (size_t i = 0; i < n; i++) {
        // Send to every subscriber, INCLUDING the writer. Two browser
        // windows on the same macOS profile share one underlying GATT
        // connection through CoreBluetooth; skipping the writer's conn
        // would skip every receiver too. Each peer dedupes by ad id
        // on its side, so echoing the writer's own ad back is harmless
        // (their _ads cache just updates with itself).
        send_chunked(conns[i], buf, len);
    }
}

// Called per write frame on the mailbox char. Walks the chunked envelope
// per source conn; commits store the assembled ad and broadcast it.
void pair_mailbox_handle_write(uint16_t from_conn, const uint8_t *buf, size_t len) {
    if (len == 0) return;
    uint8_t op = buf[0];
    if (op == MBX_OP_BEGIN) {
        if (len < 3) return;
        uint16_t total = ((uint16_t)buf[1] << 8) | buf[2];
        if (total == 0 || total > MAILBOX_AD_MAX) {
            ESP_LOGW(TAG, "begin oversized total=%u from conn=%u", total, from_conn);
            return;
        }
        mailbox_rx_t *rx = rx_for(from_conn, true);
        if (!rx) { ESP_LOGW(TAG, "rx slots full"); return; }
        rx->expected = total;
        rx->got = 0;
        return;
    }
    if (op == MBX_OP_CHUNK) {
        mailbox_rx_t *rx = rx_for(from_conn, false);
        if (!rx || rx->expected == 0) return;
        size_t payload = len - 1;
        if (rx->got + payload > rx->expected) { rx_release(rx); return; }
        memcpy(&rx->buf[rx->got], &buf[1], payload);
        rx->got += payload;
        return;
    }
    if (op == MBX_OP_COMMIT) {
        mailbox_rx_t *rx = rx_for(from_conn, false);
        if (!rx || rx->got != rx->expected || rx->got == 0) {
            if (rx) rx_release(rx);
            return;
        }
        ESP_LOGI(TAG, "ad in: %u B from conn=%u", rx->got, from_conn);
        store_ad(rx->buf, rx->got);
        broadcast_ad(from_conn, rx->buf, rx->got);
        rx_release(rx);
        return;
    }
}

void pair_mailbox_replay_to(uint16_t conn_handle) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    int sent = 0;
    int start = (s_count < MAILBOX_DEPTH) ? 0 : s_next;
    for (int i = 0; i < s_count; i++) {
        int idx = (start + i) % MAILBOX_DEPTH;
        const mailbox_ad_t *ad = &s_ring[idx];
        if (ad->len == 0) continue;
        send_chunked(conn_handle, ad->bytes, ad->len);
        sent++;
    }
    xSemaphoreGive(s_mutex);
    if (sent) ESP_LOGI(TAG, "replayed %d ad(s) to conn=%u", sent, (unsigned)conn_handle);
}
