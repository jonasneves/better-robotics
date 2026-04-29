#pragma once

#include <stddef.h>
#include <stdint.h>

#include "host/ble_uuid.h"

// Service table for the project's main_service. Owned by gatt_svr.c —
// caps call notify_X() after applying state to push the new value to
// any subscribed dashboard.
//
// Phases 2.C.1 + 2.C.2 cover: LED, FLASH, MOTOR, PIN_CONFIG, WIFI_SCAN,
// WIFI_JOIN, WIFI_STATUS. Remaining (OTA, fw-info, telemetry, snapshot,
// camera-profile, ops/ops-response) land in later 2.C sub-phases.
void gatt_svr_init(void);

// SERVICE_UUID parsed once at init — ble_host borrows this for advertising.
const ble_uuid128_t *gatt_svr_service_uuid(void);

void gatt_svr_notify_led(void);
void gatt_svr_notify_flash(void);
void gatt_svr_notify_motor(void);
void gatt_svr_notify_wifi_scan(void);
void gatt_svr_notify_wifi_status(void);
void gatt_svr_notify_ota_status(void);
void gatt_svr_notify_telemetry(void);
void gatt_svr_notify_fw_info(void);

// Push a snapshot frame to the active central. Custom-payload notify
// (not a stored-value notify) — wraps ble_gatts_notify_custom. No-op if
// no central is connected. The snapshot task drives this directly with
// the begin/chunk/commit/error envelope.
void gatt_svr_snapshot_send(const uint8_t *buf, size_t len);

// Same shape as gatt_svr_snapshot_send but on the SIGNAL char — wraps
// the chunked WebRTC SDP answer (and error frames) on the way back to
// the dashboard during BLE-signaled handshakes. `conn` is the central
// the answer is for; webrtc_peer remembers the conn that wrote the
// offer so the right window receives the response when multiple
// browsers are simultaneously connected.
void gatt_svr_signal_send(uint16_t conn, const uint8_t *buf, size_t len);

// Phase 2.F.2: pair-mailbox notifies. Per-conn target so the mailbox
// can broadcast (skipping the writer) and replay (single subscriber).
// `conn_handle` must be a currently-connected central's handle.
void gatt_svr_pair_mailbox_send(uint16_t conn_handle, const uint8_t *buf, size_t len);

// Returns the pair-mailbox char's val_handle, used by ble_host's
// SUBSCRIBE event hook to discriminate mailbox subscribes from
// snapshot / signal-char subscribes.
uint16_t gatt_svr_pair_mailbox_handle(void);

// Logs streaming (Phase 2.G): chunked log lines pushed via NOTIFY. The
// logs module owns the ring buffer + esp_log vprintf hook and asks
// gatt_svr to emit notifies on its behalf so this header doesn't need
// to leak the val_handle. ble_host's SUBSCRIBE hook calls
// logs_replay_to when a central enables notifications on this char.
void gatt_svr_logs_send(uint16_t conn, const uint8_t *buf, size_t len);
uint16_t gatt_svr_logs_handle(void);
