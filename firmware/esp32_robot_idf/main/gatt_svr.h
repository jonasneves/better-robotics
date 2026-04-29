#pragma once

#include "host/ble_uuid.h"

// Service table for the project's main_service. Owned by gatt_svr.c —
// caps call notify_X() after applying state to push the new value to
// any subscribed dashboard.
//
// Phase 2.C.1 covers: LED, FLASH, MOTOR, PIN_CONFIG. Other characteristics
// (wifi-scan/join/status, OTA, fw-info, telemetry, snapshot, camera-profile,
// ops/ops-response) land in the next 2.C sub-phases.
void gatt_svr_init(void);

// SERVICE_UUID parsed once at init — ble_host borrows this for advertising.
const ble_uuid128_t *gatt_svr_service_uuid(void);

void gatt_svr_notify_led(void);
void gatt_svr_notify_flash(void);
void gatt_svr_notify_motor(void);
