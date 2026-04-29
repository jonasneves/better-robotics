#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Bring up WiFi STA. Sets hostname, attaches event handlers, and kicks
// off a join attempt with whatever creds live in the "wifi" NVS namespace.
// No-op join if no creds saved — dashboard drives one over BLE later.
void wifi_sta_init(const char *hostname);

bool wifi_sta_has_ip(void);

// Triggered by BLE READ on wifi-scan. Async — completion fires
// gatt_svr_notify_wifi_scan() once the records are formatted.
void wifi_sta_scan_start(void);

// Triggered by BLE WRITE on wifi-join. JSON: {"s":"ssid","p":"pass"}.
// Empty p for open networks. Match firmware/pi_robot/pi_robot.py shape.
void wifi_sta_handle_join_write(const uint8_t *json, size_t len);

// JSON snapshots — gatt_svr returns these as char values on READ.
// Stable pointers (file-static buffers); valid until the next update.
const char *wifi_sta_scan_json(void);
const char *wifi_sta_status_json(void);
