#include "ble_host.h"

#include <string.h>

#include "esp_log.h"
#include "host/ble_hs.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "gatt_svr.h"

static const char *TAG = "ble_host";

static uint8_t s_addr_type;
static char s_name[32];

static void start_advertising(void);

static int gap_event(struct ble_gap_event *event, void *arg) {
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            ESP_LOGI(TAG, "connect status=%d", event->connect.status);
            if (event->connect.status != 0) start_advertising();
            break;
        case BLE_GAP_EVENT_DISCONNECT:
            ESP_LOGI(TAG, "disconnect reason=%d", event->disconnect.reason);
            start_advertising();
            break;
        case BLE_GAP_EVENT_ADV_COMPLETE:
            start_advertising();
            break;
    }
    return 0;
}

static void start_advertising(void) {
    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = (uint8_t *)s_name;
    fields.name_len = strlen(s_name);
    fields.name_is_complete = 1;
    fields.uuids128 = (ble_uuid128_t *)gatt_svr_service_uuid();
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;
    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) { ESP_LOGE(TAG, "adv_set_fields rc=%d", rc); return; }

    struct ble_gap_adv_params adv = {0};
    adv.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv.disc_mode = BLE_GAP_DISC_MODE_GEN;
    rc = ble_gap_adv_start(s_addr_type, NULL, BLE_HS_FOREVER, &adv, gap_event, NULL);
    if (rc != 0) { ESP_LOGE(TAG, "adv_start rc=%d", rc); }
}

static void on_sync(void) {
    int rc = ble_hs_id_infer_auto(0, &s_addr_type);
    if (rc != 0) { ESP_LOGE(TAG, "id_infer rc=%d", rc); return; }
    start_advertising();
    ESP_LOGI(TAG, "advertising as %s", s_name);
}

static void on_reset(int reason) {
    ESP_LOGW(TAG, "reset reason=%d", reason);
}

static void host_task(void *arg) {
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void ble_host_init(const char *name) {
    strlcpy(s_name, name, sizeof(s_name));

    ESP_ERROR_CHECK(nimble_port_init());

    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;

    ble_svc_gap_init();
    ble_svc_gatt_init();
    gatt_svr_init();
    ble_svc_gap_device_name_set(s_name);

    nimble_port_freertos_init(host_task);
}
