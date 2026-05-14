#pragma once

#include <stddef.h>
#include <stdint.h>

#include "host/ble_uuid.h"

// Service table for the project's main_service. Owned by gatt_svr.c —
// caps call notify_X() after applying state to push the new value to
// any subscribed dashboard.
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

#if CONFIG_BALANCE_BOT_ENABLED
void gatt_svr_notify_balance_pid(void);
void gatt_svr_notify_balance_state(void);
#endif

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
