#include "snapshot.h"

#include <string.h>

#include "esp_camera.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "camera.h"
#include "gatt_svr.h"

static const char *TAG = "snapshot";

// Must fit under MTU-3. Matches public/ble.js CHUNK_BYTES (180), which
// is conservative for desktop Chrome's negotiated MTU (~185).
#define CHUNK_BYTES 180

// 40 ms paces both the begin → chunk-0 transition and chunk → next-chunk.
// macOS/Chrome negotiates ~30 ms connection intervals → one notify per
// event. 25 ms would outpace delivery; NimBLE's tx queue (~7 entries)
// drifts full over ~1 s and silently drops the tail. 40 ms keeps a safe
// margin; ~9 KB JPEG = 50 chunks ≈ 2 s total — fine for one snapshot.
#define INTER_CHUNK_DELAY_MS 40

static TaskHandle_t s_task = NULL;

static void send_error(const char *msg) {
    uint8_t buf[1 + 32];
    buf[0] = 0xFF;
    size_t n = strnlen(msg, sizeof(buf) - 1);
    memcpy(buf + 1, msg, n);
    gatt_svr_snapshot_send(buf, 1 + n);
}

static void task_fn(void *arg) {
    if (!camera_acquire()) {
        ESP_LOGW(TAG, "no camera");
        send_error("no-camera");
        s_task = NULL;
        vTaskDelete(NULL);
        return;
    }

    // Discard the stale head buffer first. With grab_mode=GRAB_LATEST and
    // /stream not actively pulling, the driver may be holding a frame
    // captured minutes ago. Returning it forces a fresh DMA capture for
    // the next fb_get — adds ~33 ms (one OV2640 frame period at 30 fps),
    // imperceptible vs. operating on a stale frame.
    camera_fb_t *stale = esp_camera_fb_get();
    if (stale) esp_camera_fb_return(stale);

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        ESP_LOGW(TAG, "fb-get-failed");
        send_error("fb-get-failed");
        camera_release();
        s_task = NULL;
        vTaskDelete(NULL);
        return;
    }
    ESP_LOGI(TAG, "fb captured, %u bytes", (unsigned)fb->len);

    uint8_t begin[5];
    begin[0] = 0x01;
    begin[1] = (fb->len >> 24) & 0xff;
    begin[2] = (fb->len >> 16) & 0xff;
    begin[3] = (fb->len >>  8) & 0xff;
    begin[4] = (fb->len      ) & 0xff;
    gatt_svr_snapshot_send(begin, 5);
    vTaskDelay(pdMS_TO_TICKS(INTER_CHUNK_DELAY_MS));

    uint8_t chunk[1 + CHUNK_BYTES];
    chunk[0] = 0x02;
    size_t sent = 0;
    while (sent < fb->len) {
        size_t take = fb->len - sent;
        if (take > CHUNK_BYTES) take = CHUNK_BYTES;
        memcpy(chunk + 1, fb->buf + sent, take);
        gatt_svr_snapshot_send(chunk, 1 + take);
        sent += take;
        vTaskDelay(pdMS_TO_TICKS(INTER_CHUNK_DELAY_MS));
    }

    uint8_t commit[1] = { 0x03 };
    gatt_svr_snapshot_send(commit, 1);

    esp_camera_fb_return(fb);
    camera_release();
    ESP_LOGI(TAG, "sent %u bytes", (unsigned)sent);
    s_task = NULL;
    vTaskDelete(NULL);
}

void snapshot_request(void) {
    if (s_task) {
        ESP_LOGI(TAG, "ignored — transfer in progress");
        return;
    }
    // 4 KB stack — chunk loop is shallow. Pinned to core 1 so the BLE
    // host task on core 0 doesn't get starved during the 2 s transfer.
    BaseType_t rc = xTaskCreatePinnedToCore(
        task_fn, "snapshot", 4096, NULL, 1, &s_task, 1);
    if (rc != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreate rc=%d", (int)rc);
        send_error("task-create-failed");
        s_task = NULL;
    }
}
