#include "logs.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "host/ble_hs.h"

#include "ble_host.h"
#include "gatt_svr.h"

// Ring buffer big enough for ~30 s of moderate logging. Bumping this is
// cheap RAM-wise (it's all uint8_t) but eats from the post-camera DRAM
// pool, so 8 KB is the budget.
#define LOG_RING_BYTES   8192
// Largest single log line we'll buffer. ESP_LOG output rarely exceeds
// 200 B; the cap mostly defends against an accidental %s on an enormous
// string. Lines longer than this are truncated.
#define LOG_LINE_MAX     384
// Drain cadence. Logs aren't realtime, so 200 ms keeps notify rate sane
// even during boot when output is dense.
#define LOG_DRAIN_MS     200
// Notify chunk size — same as snapshot/signal. Safe under any plausible
// ATT MTU.
#define LOG_CHUNK_BYTES  100
// Per-notify cap so a 30s burst doesn't queue dozens of mbufs in NimBLE
// at once. 1024 B per ad covers most natural batches; the rest waits
// for the next drain tick.
#define LOG_BATCH_MAX    1024

static SemaphoreHandle_t s_mutex;
// Ring buffer in PSRAM — 8 KB on top of camera + WiFi DMA + NimBLE
// pools would exhaust internal DRAM. PSRAM access is slower than DRAM
// but the worker reads in big batches at 200 ms cadence so the
// throughput overhead is invisible. Allocated at init since PSRAM
// isn't ready as a BSS target on classic ESP32.
static uint8_t *s_ring = NULL;
static size_t s_head = 0;       // next byte to write
static size_t s_tail = 0;       // next byte to read
static size_t s_used = 0;       // bytes available to read
// Saved by the original vprintf so we can chain — the default writes to
// the UART, which we want to keep so the serial console still works.
static vprintf_like_t s_orig_vprintf = NULL;
// Marker so vprintf doesn't recurse if we ever ESP_LOG from the drain
// task. Set per-task; covers the simple case where logs_drain_task itself
// emits a log line.
static __thread bool s_in_log_hook = false;

static void ring_push(const uint8_t *buf, size_t len) {
    if (len == 0 || !s_ring) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    // Drop oldest on overflow. The alternative (drop new) hides the most
    // recent — and current — issue, which is exactly what we don't want.
    if (len >= LOG_RING_BYTES) {
        // Single line bigger than the ring. Keep the tail of it.
        buf += (len - LOG_RING_BYTES);
        len = LOG_RING_BYTES;
        s_head = s_tail = s_used = 0;
    } else if (s_used + len > LOG_RING_BYTES) {
        size_t drop = s_used + len - LOG_RING_BYTES;
        s_tail = (s_tail + drop) % LOG_RING_BYTES;
        s_used -= drop;
    }
    size_t first = LOG_RING_BYTES - s_head;
    if (len <= first) {
        memcpy(&s_ring[s_head], buf, len);
    } else {
        memcpy(&s_ring[s_head], buf, first);
        memcpy(&s_ring[0], buf + first, len - first);
    }
    s_head = (s_head + len) % LOG_RING_BYTES;
    s_used += len;
    xSemaphoreGive(s_mutex);
}

static size_t ring_pop(uint8_t *out, size_t cap) {
    if (!s_ring) return 0;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    size_t take = s_used < cap ? s_used : cap;
    size_t first = LOG_RING_BYTES - s_tail;
    if (take <= first) {
        memcpy(out, &s_ring[s_tail], take);
    } else {
        memcpy(out, &s_ring[s_tail], first);
        memcpy(out + first, &s_ring[0], take - first);
    }
    s_tail = (s_tail + take) % LOG_RING_BYTES;
    s_used -= take;
    xSemaphoreGive(s_mutex);
    return take;
}

// vprintf hook: format into a stack buffer, push to ring, also chain to
// the original (UART) printer so serial console keeps working.
static int log_vprintf_hook(const char *fmt, va_list args) {
    if (s_in_log_hook) {
        // Recursive call from inside the hook (very rare; handler in the
        // drain task logs an error). Forward to original and exit.
        if (s_orig_vprintf) return s_orig_vprintf(fmt, args);
        return 0;
    }

    // Don't capture logs from the NimBLE host task or our own drain
    // task. NimBLE logs every ATT op, including the notifies we issue
    // for log delivery — capturing those would spin a feedback loop
    // that fills the ring, floods the link, and starved the host
    // task to the point of disconnect during connect setup. Both
    // still hit UART via the chained vprintf below.
    bool capture = true;
    const char *tname = pcTaskGetName(NULL);
    if (tname && (strcmp(tname, "ble") == 0
               || strcmp(tname, "BLE Host") == 0
               || strcmp(tname, "logs") == 0
               || strcmp(tname, "btController") == 0)) {
        capture = false;
    }

    s_in_log_hook = true;

    if (capture) {
        // vsnprintf consumes the va_list; copy so we can chain to UART
        // afterward with the original args still intact.
        va_list args_copy;
        va_copy(args_copy, args);
        char buf[LOG_LINE_MAX];
        int n = vsnprintf(buf, sizeof(buf), fmt, args_copy);
        va_end(args_copy);
        if (n > 0) {
            size_t take = (n < (int)sizeof(buf)) ? (size_t)n : sizeof(buf) - 1;
            ring_push((const uint8_t *)buf, take);
        }
    }

    int r = 0;
    if (s_orig_vprintf) r = s_orig_vprintf(fmt, args);
    s_in_log_hook = false;
    return r;
}

static void send_chunked(uint16_t conn, const uint8_t *buf, size_t len) {
    if (len == 0 || conn == BLE_HS_CONN_HANDLE_NONE) return;
    uint8_t hdr[3] = { 0x01, (uint8_t)(len >> 8), (uint8_t)(len & 0xff) };
    gatt_svr_logs_send(conn, hdr, sizeof(hdr));
    uint8_t frame[1 + LOG_CHUNK_BYTES];
    frame[0] = 0x02;
    for (size_t off = 0; off < len; off += LOG_CHUNK_BYTES) {
        size_t take = len - off > LOG_CHUNK_BYTES ? LOG_CHUNK_BYTES : (len - off);
        memcpy(&frame[1], &buf[off], take);
        gatt_svr_logs_send(conn, frame, 1 + take);
        // Pace notifies — same 5 ms gap as signal char's chunked answer.
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    uint8_t commit = 0x03;
    gatt_svr_logs_send(conn, &commit, 1);
}

static void drain_task(void *arg) {
    uint8_t batch[LOG_BATCH_MAX];
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(LOG_DRAIN_MS));
        if (!gatt_svr_logs_handle()) continue;
        uint16_t conn = ble_host_active_conn();
        if (conn == BLE_HS_CONN_HANDLE_NONE) continue;
        size_t n = ring_pop(batch, sizeof(batch));
        if (n == 0) continue;
        send_chunked(conn, batch, n);
    }
}

void logs_init(void) {
    s_mutex = xSemaphoreCreateMutex();
    // Ring lives in PSRAM. If PSRAM is unavailable we fall back to
    // DRAM at half size; a missing buffer would lose all logs forever
    // which defeats the point.
    s_ring = heap_caps_malloc(LOG_RING_BYTES, MALLOC_CAP_SPIRAM);
    if (!s_ring) s_ring = malloc(LOG_RING_BYTES / 2);
    s_orig_vprintf = esp_log_set_vprintf(log_vprintf_hook);
    // Drain task is deferred to logs_start() — it would otherwise grab
    // its DRAM stack before the websocket task that webrtc_peer_init
    // creates later, leading to "Error create websocket task" on
    // classic ESP32 where DRAM is tight.
}

void logs_start(void) {
    // 2 KB DRAM stack — drain_task only memcpys + calls notify
    // wrappers; nothing here needs vsnprintf or DTLS frames. Tasks
    // with SPIRAM stacks panicked at boot on classic ESP32, even
    // for this lightweight loop, so we pay the DRAM tax.
    xTaskCreate(drain_task, "logs", 2048, NULL, 1, NULL);
}

void logs_replay_to(uint16_t conn_handle) {
    if (conn_handle == BLE_HS_CONN_HANDLE_NONE) return;
    uint8_t batch[LOG_BATCH_MAX];
    size_t n = ring_pop(batch, sizeof(batch));
    if (n == 0) return;
    send_chunked(conn_handle, batch, n);
}

