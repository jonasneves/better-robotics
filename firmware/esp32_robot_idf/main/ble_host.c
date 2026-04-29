#include "ble_host.h"

#include <string.h>

#include "esp_log.h"
#include "host/ble_hs.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "gatt_svr.h"
#include "logs.h"
#include "pair_mailbox.h"

static const char *TAG = "ble_host";

static uint8_t s_addr_type;
static char s_name[32];
static uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;

// All currently-connected centrals. Used by the pair-mailbox to
// broadcast ads to every subscriber. Single-peer flows (snapshot,
// signal char) keep using ble_host_active_conn for convenience —
// they target the most-recent peer, which is correct for those.
static uint16_t s_conns[BLE_HOST_MAX_CONNS];
static size_t s_conns_count = 0;

uint16_t ble_host_active_conn(void) { return s_conn_handle; }

size_t ble_host_active_conns(uint16_t *out, size_t cap) {
    size_t n = s_conns_count < cap ? s_conns_count : cap;
    for (size_t i = 0; i < n; i++) out[i] = s_conns[i];
    return n;
}

static void conns_add(uint16_t handle) {
    for (size_t i = 0; i < s_conns_count; i++) {
        if (s_conns[i] == handle) return;
    }
    if (s_conns_count < BLE_HOST_MAX_CONNS) {
        s_conns[s_conns_count++] = handle;
    }
}

static void conns_remove(uint16_t handle) {
    for (size_t i = 0; i < s_conns_count; i++) {
        if (s_conns[i] == handle) {
            s_conns[i] = s_conns[--s_conns_count];
            return;
        }
    }
}

static void start_advertising(void);

static int gap_event(struct ble_gap_event *event, void *arg) {
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            ESP_LOGI(TAG, "connect status=%d handle=%u",
                     event->connect.status, event->connect.conn_handle);
            if (event->connect.status == 0) {
                s_conn_handle = event->connect.conn_handle;
                conns_add(event->connect.conn_handle);
                // Keep advertising even with active conns — phone-pair
                // (Phase 2.F.2) needs the robot reachable to a SECOND
                // central while desktop is already connected.
                if (s_conns_count < BLE_HOST_MAX_CONNS) start_advertising();
            } else {
                start_advertising();
            }
            break;
        case BLE_GAP_EVENT_DISCONNECT:
            ESP_LOGI(TAG, "disconnect reason=%d handle=%u",
                     event->disconnect.reason, event->disconnect.conn.conn_handle);
            conns_remove(event->disconnect.conn.conn_handle);
            if (s_conn_handle == event->disconnect.conn.conn_handle) {
                s_conn_handle = s_conns_count > 0 ? s_conns[0] : BLE_HS_CONN_HANDLE_NONE;
            }
            start_advertising();
            break;
        case BLE_GAP_EVENT_SUBSCRIBE:
            // Replay buffered pair-mailbox ads to a new subscriber. The
            // mailbox helper checks the attr_handle against the mailbox
            // char itself before replaying, so this is safe to call on
            // every subscribe event.
            ESP_LOGI(TAG, "subscribe conn=%u attr=%u cur_notify=%d",
                     event->subscribe.conn_handle, event->subscribe.attr_handle,
                     event->subscribe.cur_notify);
            if (event->subscribe.cur_notify
                && event->subscribe.attr_handle == gatt_svr_pair_mailbox_handle()) {
                pair_mailbox_replay_to(event->subscribe.conn_handle);
            }
            // Logs subscribe → flush whatever's already buffered so the
            // operator gets context for the boot/early-init lines they
            // missed (especially the ones that fired before BLE came up).
            if (event->subscribe.cur_notify
                && event->subscribe.attr_handle == gatt_svr_logs_handle()) {
                logs_replay_to(event->subscribe.conn_handle);
            }
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
