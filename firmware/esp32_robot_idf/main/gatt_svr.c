#include "gatt_svr.h"

#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "host/ble_hs.h"
#include "os/os_mbuf.h"

#include "ble_host.h"
#include "camera.h"
#include "flash.h"
#include "fw_info.h"
#include "led.h"
#include "motors.h"
#include "ota.h"
#include "pin_config.h"
#include "snapshot.h"
#include "telemetry.h"
#include "uuids.h"
#include "webrtc_peer.h"
#include "wifi_sta.h"
#if CONFIG_BALANCE_BOT_ENABLED
#include "balance.h"
#endif

static const char *TAG = "gatt_svr";

static ble_uuid128_t s_service_uuid;
static ble_uuid128_t s_led_uuid;
static ble_uuid128_t s_flash_uuid;
static ble_uuid128_t s_motor_uuid;
static ble_uuid128_t s_pin_config_uuid;
static ble_uuid128_t s_wifi_scan_uuid;
static ble_uuid128_t s_wifi_join_uuid;
static ble_uuid128_t s_wifi_status_uuid;
static ble_uuid128_t s_ota_data_uuid;
static ble_uuid128_t s_ota_status_uuid;
static ble_uuid128_t s_snapshot_request_uuid;
static ble_uuid128_t s_snapshot_data_uuid;
static ble_uuid128_t s_telemetry_uuid;
static ble_uuid128_t s_fw_info_uuid;
static ble_uuid128_t s_signal_uuid;
#if CONFIG_BALANCE_BOT_ENABLED
static ble_uuid128_t s_balance_cmd_uuid;
static ble_uuid128_t s_balance_pid_uuid;
static ble_uuid128_t s_balance_state_uuid;
static ble_uuid128_t s_balance_target_uuid;
static uint16_t s_balance_pid_handle;
static uint16_t s_balance_state_handle;
#endif

static uint16_t s_led_handle;
static uint16_t s_flash_handle;
static uint16_t s_motor_handle;
static uint16_t s_wifi_scan_handle;
static uint16_t s_wifi_status_handle;
static uint16_t s_ota_status_handle;
static uint16_t s_snapshot_data_handle;
static uint16_t s_telemetry_handle;
static uint16_t s_fw_info_handle;
static uint16_t s_signal_handle;

const ble_uuid128_t *gatt_svr_service_uuid(void) { return &s_service_uuid; }

// Parse "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d91" into NimBLE little-endian
// bytes. NimBLE stores 128-bit UUIDs LE in `value[16]` — bytes[0] is the
// LSB, so we fill from the right.
static void parse_uuid128(const char *s, ble_uuid128_t *out) {
    out->u.type = BLE_UUID_TYPE_128;
    uint8_t bytes[16] = {0};
    int bi = 15;
    for (size_t i = 0; s[i] && bi >= 0; i++) {
        if (s[i] == '-') continue;
        char buf[3] = { s[i], s[i + 1], 0 };
        bytes[bi--] = (uint8_t)strtoul(buf, NULL, 16);
        i++;
    }
    memcpy(out->value, bytes, 16);
}

static int led_access(uint16_t conn, uint16_t attr,
                      struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint8_t b = 0;
        uint16_t copied = 0;
        ble_hs_mbuf_to_flat(ctxt->om, &b, 1, &copied);
        if (copied >= 1) led_apply(b != 0);
        return 0;
    }
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        uint8_t v = led_state() ? 1 : 0;
        return os_mbuf_append(ctxt->om, &v, 1) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int flash_access(uint16_t conn, uint16_t attr,
                        struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint8_t b = 0;
        uint16_t copied = 0;
        ble_hs_mbuf_to_flat(ctxt->om, &b, 1, &copied);
        if (copied >= 1) flash_apply(b);
        return 0;
    }
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        uint8_t v = flash_level();
        return os_mbuf_append(ctxt->om, &v, 1) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int motor_access(uint16_t conn, uint16_t attr,
                        struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint8_t buf[4] = {0};
        uint16_t copied = 0;
        ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &copied);
        if (copied == 2) {
            motors_apply((int8_t)buf[0], (int8_t)buf[1]);
        } else if (copied == 4) {
            uint16_t dur = ((uint16_t)buf[2] << 8) | buf[3];
            motors_pulse((int8_t)buf[0], (int8_t)buf[1], dur);
        }
        return 0;
    }
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        int8_t l, r;
        motors_get(&l, &r);
        uint8_t v[2] = { (uint8_t)l, (uint8_t)r };
        return os_mbuf_append(ctxt->om, v, 2) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int pin_config_access(uint16_t conn, uint16_t attr,
                             struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint8_t buf[256];
        uint16_t copied = 0;
        ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &copied);
        if (copied > 0) pin_config_handle_write(buf, copied);
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

// Read kicks off a fresh scan AND returns the last cached result. The
// dashboard subscribes NOTIFY for the new list when scan_done fires.
static int wifi_scan_access(uint16_t conn, uint16_t attr,
                            struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        wifi_sta_scan_start();
        const char *json = wifi_sta_scan_json();
        return os_mbuf_append(ctxt->om, json, strlen(json)) == 0
                   ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int wifi_join_access(uint16_t conn, uint16_t attr,
                            struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint8_t buf[160];
        uint16_t copied = 0;
        ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &copied);
        if (copied > 0) wifi_sta_handle_join_write(buf, copied);
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int wifi_status_access(uint16_t conn, uint16_t attr,
                              struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        const char *json = wifi_sta_status_json();
        return os_mbuf_append(ctxt->om, json, strlen(json)) == 0
                   ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

// OTA-data buffer big enough for chunk 0x02 [payload up to MTU-3=244].
static int ota_data_access(uint16_t conn, uint16_t attr,
                           struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint8_t buf[256];
        uint16_t copied = 0;
        ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &copied);
        if (copied > 0) ota_handle_data_write(buf, copied);
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int ota_status_access(uint16_t conn, uint16_t attr,
                             struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        const char *json = ota_status_json();
        return os_mbuf_append(ctxt->om, json, strlen(json)) == 0
                   ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int snapshot_request_access(uint16_t conn, uint16_t attr,
                                   struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint8_t b = 0;
        uint16_t copied = 0;
        ble_hs_mbuf_to_flat(ctxt->om, &b, 1, &copied);
        if (copied >= 1 && b == 0x01) snapshot_request();
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

// Notify-only; dashboard subscribes CCCD and receives chunks. Reads
// shouldn't happen, but return empty rather than assert.
static int snapshot_data_access(uint16_t conn, uint16_t attr,
                                struct ble_gatt_access_ctxt *ctxt, void *arg) {
    return 0;
}

static int telemetry_access(uint16_t conn, uint16_t attr,
                            struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        const char *json = telemetry_json();
        return os_mbuf_append(ctxt->om, json, strlen(json)) == 0
                   ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int fw_info_access(uint16_t conn, uint16_t attr,
                          struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        const char *json = fw_info_json();
        return os_mbuf_append(ctxt->om, json, strlen(json)) == 0
                   ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

// SIGNAL: chunked SDP offer (write) and chunked SDP answer (notify via
// gatt_svr_signal_send). Buffer holds one chunk; chunks bounded at ~100 +
// 1 op byte by webrtc_peer.c's BLE_SIG_CHUNK.
static int signal_access(uint16_t conn, uint16_t attr,
                         struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint8_t buf[256];
        uint16_t copied = 0;
        ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &copied);
        // Pass the writer's conn handle so the answer routes back to the
        // same central. Without this, gatt_svr_signal_send falls through
        // to ble_host_active_conn() ("most-recent connect"), wrong when a
        // second browser is BLE-connected concurrently.
        if (copied > 0) webrtc_peer_handle_ble_signal_write(conn, buf, copied);
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

#if CONFIG_BALANCE_BOT_ENABLED
static int balance_cmd_access(uint16_t conn, uint16_t attr,
                              struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint8_t buf[2] = {0};
        uint16_t copied = 0;
        ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &copied);
        if (copied >= 2) balance_handle_cmd((int8_t)buf[0], (int8_t)buf[1]);
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int balance_pid_access(uint16_t conn, uint16_t attr,
                              struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint8_t buf[128];
        uint16_t copied = 0;
        ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &copied);
        if (copied > 0) balance_handle_pid_write(buf, copied);
        return 0;
    }
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        const char *json = balance_pid_json();
        return os_mbuf_append(ctxt->om, json, strlen(json)) == 0
                   ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int balance_state_access(uint16_t conn, uint16_t attr,
                                struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        const char *json = balance_state_json();
        return os_mbuf_append(ctxt->om, json, strlen(json)) == 0
                   ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static int balance_target_access(uint16_t conn, uint16_t attr,
                                 struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint8_t buf[128];
        uint16_t copied = 0;
        ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &copied);
        if (copied > 0) balance_handle_target_write(buf, copied);
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}
#endif

static const struct ble_gatt_chr_def s_chars[] = {
    {
        .uuid = &s_led_uuid.u,
        .access_cb = led_access,
        .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &s_led_handle,
    },
    {
        .uuid = &s_flash_uuid.u,
        .access_cb = flash_access,
        .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &s_flash_handle,
    },
    {
        .uuid = &s_motor_uuid.u,
        .access_cb = motor_access,
        .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &s_motor_handle,
    },
    {
        .uuid = &s_pin_config_uuid.u,
        .access_cb = pin_config_access,
        .flags = BLE_GATT_CHR_F_WRITE,
    },
    {
        .uuid = &s_wifi_scan_uuid.u,
        .access_cb = wifi_scan_access,
        .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &s_wifi_scan_handle,
    },
    {
        .uuid = &s_wifi_join_uuid.u,
        .access_cb = wifi_join_access,
        .flags = BLE_GATT_CHR_F_WRITE,
    },
    {
        .uuid = &s_wifi_status_uuid.u,
        .access_cb = wifi_status_access,
        .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &s_wifi_status_handle,
    },
    {
        .uuid = &s_ota_data_uuid.u,
        .access_cb = ota_data_access,
        // WRITE | WRITE_NR — without-response lets the dashboard stream
        // chunks without per-frame ATT acks.
        .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
    },
    {
        .uuid = &s_ota_status_uuid.u,
        .access_cb = ota_status_access,
        .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &s_ota_status_handle,
    },
    {
        .uuid = &s_snapshot_request_uuid.u,
        .access_cb = snapshot_request_access,
        .flags = BLE_GATT_CHR_F_WRITE,
    },
    {
        .uuid = &s_snapshot_data_uuid.u,
        .access_cb = snapshot_data_access,
        .flags = BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &s_snapshot_data_handle,
    },
    {
        .uuid = &s_telemetry_uuid.u,
        .access_cb = telemetry_access,
        .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &s_telemetry_handle,
    },
    {
        .uuid = &s_fw_info_uuid.u,
        .access_cb = fw_info_access,
        .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &s_fw_info_handle,
    },
    {
        .uuid = &s_signal_uuid.u,
        .access_cb = signal_access,
        .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &s_signal_handle,
    },
#if CONFIG_BALANCE_BOT_ENABLED
    {
        .uuid      = &s_balance_cmd_uuid.u,
        .access_cb = balance_cmd_access,
        .flags     = BLE_GATT_CHR_F_WRITE,
    },
    {
        .uuid       = &s_balance_pid_uuid.u,
        .access_cb  = balance_pid_access,
        .flags      = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &s_balance_pid_handle,
    },
    {
        .uuid       = &s_balance_state_uuid.u,
        .access_cb  = balance_state_access,
        .flags      = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &s_balance_state_handle,
    },
    {
        .uuid      = &s_balance_target_uuid.u,
        .access_cb = balance_target_access,
        .flags     = BLE_GATT_CHR_F_WRITE,
    },
#endif
    { 0 },
};

static const struct ble_gatt_svc_def s_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &s_service_uuid.u,
        .characteristics = s_chars,
    },
    { 0 },
};

void gatt_svr_init(void) {
    parse_uuid128(SERVICE_UUID,          &s_service_uuid);
    parse_uuid128(LED_CHAR_UUID,         &s_led_uuid);
    parse_uuid128(FLASH_CHAR_UUID,       &s_flash_uuid);
    parse_uuid128(MOTOR_CHAR_UUID,       &s_motor_uuid);
    parse_uuid128(PIN_CONFIG_CHAR_UUID,  &s_pin_config_uuid);
    parse_uuid128(WIFI_SCAN_CHAR_UUID,   &s_wifi_scan_uuid);
    parse_uuid128(WIFI_JOIN_CHAR_UUID,   &s_wifi_join_uuid);
    parse_uuid128(WIFI_STATUS_CHAR_UUID, &s_wifi_status_uuid);
    parse_uuid128(OTA_DATA_CHAR_UUID,         &s_ota_data_uuid);
    parse_uuid128(OTA_STATUS_CHAR_UUID,       &s_ota_status_uuid);
    parse_uuid128(SNAPSHOT_REQUEST_CHAR_UUID, &s_snapshot_request_uuid);
    parse_uuid128(SNAPSHOT_DATA_CHAR_UUID,    &s_snapshot_data_uuid);
    parse_uuid128(TELEMETRY_CHAR_UUID,        &s_telemetry_uuid);
    parse_uuid128(FW_INFO_CHAR_UUID,          &s_fw_info_uuid);
    parse_uuid128(SIGNAL_CHAR_UUID,           &s_signal_uuid);
#if CONFIG_BALANCE_BOT_ENABLED
    parse_uuid128(BALANCE_CMD_CHAR_UUID,    &s_balance_cmd_uuid);
    parse_uuid128(BALANCE_PID_CHAR_UUID,    &s_balance_pid_uuid);
    parse_uuid128(BALANCE_STATE_CHAR_UUID,  &s_balance_state_uuid);
    parse_uuid128(BALANCE_TARGET_CHAR_UUID, &s_balance_target_uuid);
#endif

    int rc = ble_gatts_count_cfg(s_svcs);
    if (rc != 0) { ESP_LOGE(TAG, "count_cfg rc=%d", rc); return; }
    rc = ble_gatts_add_svcs(s_svcs);
    if (rc != 0) { ESP_LOGE(TAG, "add_svcs rc=%d", rc); return; }
    ESP_LOGI(TAG, "service table registered");
}

void gatt_svr_notify_led(void)         { if (s_led_handle)         ble_gatts_chr_updated(s_led_handle); }
void gatt_svr_notify_flash(void)       { if (s_flash_handle)       ble_gatts_chr_updated(s_flash_handle); }
void gatt_svr_notify_motor(void)       { if (s_motor_handle)       ble_gatts_chr_updated(s_motor_handle); }
void gatt_svr_notify_wifi_scan(void)   { if (s_wifi_scan_handle)   ble_gatts_chr_updated(s_wifi_scan_handle); }
void gatt_svr_notify_wifi_status(void) { if (s_wifi_status_handle) ble_gatts_chr_updated(s_wifi_status_handle); }
void gatt_svr_notify_ota_status(void)  { if (s_ota_status_handle)  ble_gatts_chr_updated(s_ota_status_handle); }
void gatt_svr_notify_telemetry(void)   { if (s_telemetry_handle)   ble_gatts_chr_updated(s_telemetry_handle); }
void gatt_svr_notify_fw_info(void)     { if (s_fw_info_handle)     ble_gatts_chr_updated(s_fw_info_handle); }

#if CONFIG_BALANCE_BOT_ENABLED
void gatt_svr_notify_balance_pid(void)   { if (s_balance_pid_handle)   ble_gatts_chr_updated(s_balance_pid_handle); }
void gatt_svr_notify_balance_state(void) { if (s_balance_state_handle) ble_gatts_chr_updated(s_balance_state_handle); }
#endif

void gatt_svr_snapshot_send(const uint8_t *buf, size_t len) {
    uint16_t conn = ble_host_active_conn();
    if (conn == BLE_HS_CONN_HANDLE_NONE) return;
    if (!s_snapshot_data_handle) return;
    struct os_mbuf *om = ble_hs_mbuf_from_flat(buf, len);
    if (!om) return;
    // ble_gatts_notify_custom takes ownership of the mbuf (frees on
    // success and on error), so no cleanup path on the caller side.
    ble_gatts_notify_custom(conn, s_snapshot_data_handle, om);
}

void gatt_svr_signal_send(uint16_t conn, const uint8_t *buf, size_t len) {
    if (conn == BLE_HS_CONN_HANDLE_NONE) return;
    if (!s_signal_handle) return;
    struct os_mbuf *om = ble_hs_mbuf_from_flat(buf, len);
    if (!om) return;
    ble_gatts_notify_custom(conn, s_signal_handle, om);
}
