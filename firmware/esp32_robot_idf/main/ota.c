#include "ota.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_timer.h"

#include "gatt_svr.h"
#include "restart_util.h"

static const char *TAG = "ota";

static bool s_in_progress = false;
static size_t s_expected = 0;
static size_t s_received = 0;
static esp_ota_handle_t s_handle = 0;
static const esp_partition_t *s_partition = NULL;

#define STATUS_BUF_SIZE 192
static char s_status_json[STATUS_BUF_SIZE] = "{\"st\":\"idle\",\"n\":0}";

// Rate-limit chunk notifies. The dashboard uses confirmed_n (this counter)
// as the receive-side cursor for windowed flow control under
// writeWithoutResponse — every 8 KB keeps the window pulling without
// saturating NimBLE's tx queue. 250 ms is a sanity cap for short bursts
// (commit-time tail).
static size_t   s_chunk_last_reported = 0;
static int64_t  s_chunk_last_progress_us = 0;

const char *ota_status_json(void) { return s_status_json; }

static void publish_status(const char *st, size_t n, size_t total, const char *err) {
    int o = snprintf(s_status_json, STATUS_BUF_SIZE, "{\"st\":\"%s\",\"n\":%u", st, (unsigned)n);
    if (total) o += snprintf(s_status_json + o, STATUS_BUF_SIZE - o, ",\"total\":%u", (unsigned)total);
    if (err)   o += snprintf(s_status_json + o, STATUS_BUF_SIZE - o, ",\"err\":\"%s\"", err);
    snprintf(s_status_json + o, STATUS_BUF_SIZE - o, "}");
    ESP_LOGI(TAG, "status → %s", s_status_json);
    gatt_svr_notify_ota_status();
}

void ota_init(void) {
    s_partition = esp_ota_get_next_update_partition(NULL);
    if (!s_partition) {
        ESP_LOGE(TAG, "no OTA partition");
        return;
    }
    ESP_LOGI(TAG, "next OTA partition: %s @ 0x%08x size 0x%08x",
             s_partition->label, (unsigned)s_partition->address, (unsigned)s_partition->size);
}

static esp_err_t do_begin(size_t total) {
    if (!s_partition) return ESP_FAIL;
    if (s_in_progress) {
        esp_ota_abort(s_handle);
        s_in_progress = false;
    }
    esp_err_t err = esp_ota_begin(s_partition, total ? total : OTA_SIZE_UNKNOWN, &s_handle);
    if (err != ESP_OK) return err;
    s_in_progress = true;
    s_expected = total;
    s_received = 0;
    s_chunk_last_reported = 0;
    s_chunk_last_progress_us = 0;
    return ESP_OK;
}

static esp_err_t do_write(const uint8_t *buf, size_t len) {
    if (!s_in_progress) return ESP_ERR_INVALID_STATE;
    esp_err_t err = esp_ota_write(s_handle, buf, len);
    if (err != ESP_OK) {
        esp_ota_abort(s_handle);
        s_in_progress = false;
        return err;
    }
    s_received += len;
    return ESP_OK;
}

static esp_err_t do_commit(void) {
    if (!s_in_progress) return ESP_ERR_INVALID_STATE;
    esp_err_t err = esp_ota_end(s_handle);
    s_in_progress = false;
    if (err != ESP_OK) return err;
    err = esp_ota_set_boot_partition(s_partition);
    if (err != ESP_OK) return err;
    return ESP_OK;
}

static void do_abort(void) {
    if (s_in_progress) {
        esp_ota_abort(s_handle);
        s_in_progress = false;
    }
    s_received = 0;
    s_expected = 0;
}

void ota_handle_data_write(const uint8_t *buf, size_t len) {
    if (len == 0) return;
    uint8_t op = buf[0];
    if (op == 0x00) {
        do_abort();
        publish_status("idle", 0, 0, NULL);
    } else if (op == 0x01) {
        if (len < 5) { publish_status("failed", 0, 0, "bad begin"); return; }
        size_t total = ((uint32_t)buf[1] << 24) | ((uint32_t)buf[2] << 16)
                     | ((uint32_t)buf[3] << 8)  |  (uint32_t)buf[4];
        if (do_begin(total) != ESP_OK) {
            publish_status("failed", 0, total, "ota_begin failed");
            return;
        }
        publish_status("receiving", 0, total, NULL);
    } else if (op == 0x02) {
        if (!s_in_progress) { publish_status("failed", 0, 0, "no active session"); return; }
        if (do_write(buf + 1, len - 1) != ESP_OK) {
            publish_status("failed", s_received, s_expected, "write short");
            return;
        }
        // Throttle: report every 8 KB OR every 250 ms, whichever comes
        // first. The dashboard's WithoutResponse window uses this notify
        // as the receive-side cursor — coarser cadence stalls the stream;
        // finer cadence floods the BLE link.
        int64_t now = esp_timer_get_time();
        if (s_received - s_chunk_last_reported > 8192
            || now - s_chunk_last_progress_us > 250 * 1000) {
            s_chunk_last_reported = s_received;
            s_chunk_last_progress_us = now;
            publish_status("receiving", s_received, s_expected, NULL);
        }
    } else if (op == 0x03) {
        if (!s_in_progress) { publish_status("failed", 0, 0, "no active session"); return; }
        publish_status("committing", s_received, s_expected, NULL);
        if (do_commit() != ESP_OK) {
            publish_status("failed", s_received, s_expected, "commit failed");
            return;
        }
        publish_status("done", s_received, s_expected, NULL);
        // Defer the restart — give the BLE ATT response for this commit
        // write time to land before the radio drops. Same reasoning as
        // pin_config's deferred restart.
        schedule_restart(500);
    } else if (op == 0x04) {
        // URL-trigger isn't implemented — dashboard's grace-window logic
        // sees "failed" and falls back to BLE-stream OTA. Same as the .ino.
        publish_status("failed", 0, 0, "url-trigger unavailable");
    }
}

esp_err_t ota_http_begin(size_t total)            { return do_begin(total); }
esp_err_t ota_http_write(const uint8_t *buf, size_t len) { return do_write(buf, len); }
esp_err_t ota_http_commit(void) {
    esp_err_t err = do_commit();
    if (err == ESP_OK) {
        publish_status("done", s_received, s_expected, NULL);
        schedule_restart(500);
    }
    return err;
}
void ota_http_abort(void) { do_abort(); }
