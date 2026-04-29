#include "gatt_svr.h"

#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "host/ble_hs.h"
#include "os/os_mbuf.h"

#include "flash.h"
#include "led.h"
#include "motors.h"
#include "pin_config.h"
#include "uuids.h"

static const char *TAG = "gatt_svr";

static ble_uuid128_t s_service_uuid;
static ble_uuid128_t s_led_uuid;
static ble_uuid128_t s_flash_uuid;
static ble_uuid128_t s_motor_uuid;
static ble_uuid128_t s_pin_config_uuid;

static uint16_t s_led_handle;
static uint16_t s_flash_handle;
static uint16_t s_motor_handle;

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
    parse_uuid128(SERVICE_UUID,         &s_service_uuid);
    parse_uuid128(LED_CHAR_UUID,        &s_led_uuid);
    parse_uuid128(FLASH_CHAR_UUID,      &s_flash_uuid);
    parse_uuid128(MOTOR_CHAR_UUID,      &s_motor_uuid);
    parse_uuid128(PIN_CONFIG_CHAR_UUID, &s_pin_config_uuid);

    int rc = ble_gatts_count_cfg(s_svcs);
    if (rc != 0) { ESP_LOGE(TAG, "count_cfg rc=%d", rc); return; }
    rc = ble_gatts_add_svcs(s_svcs);
    if (rc != 0) { ESP_LOGE(TAG, "add_svcs rc=%d", rc); return; }
    ESP_LOGI(TAG, "service table registered");
}

void gatt_svr_notify_led(void)   { if (s_led_handle)   ble_gatts_chr_updated(s_led_handle); }
void gatt_svr_notify_flash(void) { if (s_flash_handle) ble_gatts_chr_updated(s_flash_handle); }
void gatt_svr_notify_motor(void) { if (s_motor_handle) ble_gatts_chr_updated(s_motor_handle); }
