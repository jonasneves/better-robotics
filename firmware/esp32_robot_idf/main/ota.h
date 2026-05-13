#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

// Wire protocol for the BLE ota-data char (must match
// firmware/pi_robot/pi_robot.py):
//   0x00                   abort
//   0x01 [size:u32 BE]     begin-stream — reset, expect `size` bytes over BLE
//   0x02 [payload]         chunk — append to flash
//   0x03                   commit — finalize + restart
//   0x04 [json]            fetch-url — replies "failed" in this build
//
// ota-status (READ + NOTIFY) carries: {"st":...,"n":...,"total":...,"err":...}.

void ota_init(void);
void ota_handle_data_write(const uint8_t *buf, size_t len);
const char *ota_status_json(void);

// HTTP /ota path. Drives the same underlying esp_ota_* state but skips
// the BLE chunk-paced status notifications.
esp_err_t ota_http_begin(size_t total);
esp_err_t ota_http_write(const uint8_t *buf, size_t len);
esp_err_t ota_http_commit(void);
void ota_http_abort(void);
