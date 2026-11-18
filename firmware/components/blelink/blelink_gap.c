// blelink_gap.c — the link: address and name, advertising, the one connection and its state.
// Everything here runs on the NimBLE host task except blelink_gap_link() and
// blelink_gap_name(), which other tasks read through atomics.
#include "blelink_priv.h"
#include "blelink_frame.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "services/gap/ble_svc_gap.h"
#include <stdatomic.h>
#include <string.h>

static const char *TAG = "blelink";

static const ble_uuid128_t UUID_SERVICE = BLE_UUID128_INIT(BLELINK_UUID_SERVICE_LE);

static uint8_t      s_addr_type;
static char         s_name[BLELINK_NAME_MAX];   // written once, before s_named is set
static atomic_bool  s_named;
static atomic_uint  s_conn = BLE_HS_CONN_HANDLE_NONE;
static atomic_bool  s_subscribed;
static atomic_uint  s_epoch;
static struct ble_npl_callout s_adv_retry;      // host task: advertising did not start, try again
static int          s_adv_rc;                   // why not, last time; 0 = it started

#define ADV_RETRY_MS  100

static int on_gap_event(struct ble_gap_event *event, void *arg);

const char *blelink_gap_name(void) { return atomic_load(&s_named) ? s_name : ""; }

bool blelink_gap_link(uint16_t *conn, unsigned *epoch)
{
    *epoch = atomic_load(&s_epoch);
    *conn = (uint16_t)atomic_load(&s_conn);
    return *conn != BLE_HS_CONN_HANDLE_NONE && atomic_load(&s_subscribed);
}

// The link changed hands or direction: nothing half-received or half-sent survives it.
static void new_epoch(unsigned conn, bool subscribed)
{
    atomic_store(&s_subscribed, subscribed);
    atomic_store(&s_conn, conn);
    atomic_fetch_add(&s_epoch, 1);
}

// Connectable and discoverable whenever no central is connected (PROTOCOL.md). The flags and
// the 128-bit UUID fill 21 of the 31 advertising bytes, so the name goes in the scan response.
static bool advertise(void)
{
    const struct ble_hs_adv_fields adv = {
        .flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP,
        .uuids128 = &UUID_SERVICE, .num_uuids128 = 1, .uuids128_is_complete = 1,
    };
    const struct ble_hs_adv_fields rsp = {
        .name = (const uint8_t *)s_name, .name_len = (uint8_t)strlen(s_name), .name_is_complete = 1,
    };
    const struct ble_gap_adv_params params = {
        .conn_mode = BLE_GAP_CONN_MODE_UND, .disc_mode = BLE_GAP_DISC_MODE_GEN,
    };
    int rc = ble_gap_adv_set_fields(&adv);
    if (rc == 0) rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc == 0) rc = ble_gap_adv_start(s_addr_type, NULL, BLE_HS_FOREVER, &params, on_gap_event, NULL);
    if (rc == BLE_HS_EALREADY) rc = 0;
    // A knob that does not advertise cannot be found by any browser, so a refusal is never
    // final. One case is certain to happen: a central that gives up within the first few
    // connection events is reported as a failed CONNECT while NimBLE still holds the only
    // connection slot, and it refuses to advertise (ENOMEM) until that callback has returned.
    if (rc != 0) ble_npl_callout_reset(&s_adv_retry, ble_npl_time_ms_to_ticks32(ADV_RETRY_MS));
    if (rc != s_adv_rc) {                   // once per change, not every 100 ms
        if (rc != 0) ESP_LOGW(TAG, "advertising not started: rc=%d; trying again every %d ms", rc, ADV_RETRY_MS);
        else         ESP_LOGI(TAG, "advertising started after all");
    }
    s_adv_rc = rc;
    return rc == 0;
}

static void on_adv_retry(struct ble_npl_event *ev)
{
    (void)ev;
    if (atomic_load(&s_conn) == BLE_HS_CONN_HANDLE_NONE && !ble_gap_adv_active()) advertise();
}

void blelink_gap_init(void)
{
    ble_npl_callout_init(&s_adv_retry, nimble_port_get_dflt_eventq(), on_adv_retry, NULL);
}

static void log_conn_params(uint16_t conn, const char *what)
{
    struct ble_gap_conn_desc d;
    if (ble_gap_conn_find(conn, &d) != 0) return;
    ESP_LOGI(TAG, "%s: interval %u.%02u ms, latency %u, timeout %u ms", what,
             (unsigned)(d.conn_itvl * 125 / 100), (unsigned)(d.conn_itvl * 125 % 100),
             (unsigned)d.conn_latency, (unsigned)d.supervision_timeout * 10);
}

static void on_connect(int status, uint16_t conn)
{
    if (status != 0) {                      // the attempt failed and advertising has stopped
        ESP_LOGW(TAG, "connection attempt failed: status=%d", status);
        advertise();                        // refused inside this callback with one slot; the retry gets it
        return;
    }
    blelink_rx_reset();
    new_epoch(conn, false);
    log_conn_params(conn, "central connected");

    // Ask for the contract's parameters; the central decides (CONN_UPDATE reports its answer).
    const struct ble_gap_upd_params want = {
        .itvl_min = BLELINK_CONN_ITVL_MIN, .itvl_max = BLELINK_CONN_ITVL_MAX,
        .latency = BLELINK_CONN_LATENCY, .supervision_timeout = BLELINK_CONN_TIMEOUT,
    };
    int rc = ble_gap_update_params(conn, &want);
    if (rc != 0) ESP_LOGW(TAG, "connection parameters not requested: rc=%d", rc);
}

static void on_disconnect(int reason)
{
    blelink_rx_reset();
    new_epoch(BLE_HS_CONN_HANDLE_NONE, false);
    // The host task has done all of its work by now: receive, parse, notify-side events.
    ESP_LOGI(TAG, "central gone (reason 0x%x), advertising again; host task stack %u B never used",
             (unsigned)reason, (unsigned)uxTaskGetStackHighWaterMark(NULL));
    advertise();
}

static void on_subscribe(uint16_t conn, uint16_t attr, bool notify)
{
    if (attr != blelink_tx_handle() || conn != atomic_load(&s_conn)) return;
    if (notify == atomic_load(&s_subscribed)) return;
    new_epoch(conn, notify);
    ESP_LOGI(TAG, "central %s notifications", notify ? "enabled" : "disabled");
}

static int on_gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        on_connect(event->connect.status, event->connect.conn_handle);
        break;
    case BLE_GAP_EVENT_DISCONNECT:
        on_disconnect(event->disconnect.reason);
        break;
    case BLE_GAP_EVENT_ADV_COMPLETE:        // not expected with BLE_HS_FOREVER; never stay silent
        advertise();
        break;
    case BLE_GAP_EVENT_SUBSCRIBE:
        on_subscribe(event->subscribe.conn_handle, event->subscribe.attr_handle, event->subscribe.cur_notify);
        break;
    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "ATT MTU %u: %u bytes of line per notification", (unsigned)event->mtu.value,
                 (unsigned)blelink_payload_max(event->mtu.value));
        break;
    case BLE_GAP_EVENT_CONN_UPDATE:
        log_conn_params(event->conn_update.conn_handle,
                        event->conn_update.status == 0 ? "connection updated" : "connection update refused, still");
        break;
    default:
        break;
    }
    return 0;
}

void blelink_gap_on_reset(int reason)
{
    ESP_LOGE(TAG, "NimBLE host reset: reason=%d", reason);
}

void blelink_gap_on_sync(void)
{
    uint8_t addr[6];
    int rc = ble_hs_util_ensure_addr(0);
    if (rc == 0) rc = ble_hs_id_infer_auto(0, &s_addr_type);
    if (rc == 0) rc = ble_hs_id_copy_addr(s_addr_type, addr, NULL);
    if (rc != 0) { ESP_LOGE(TAG, "no BLE address: rc=%d. Not advertising", rc); return; }

    if (!atomic_load(&s_named)) {           // a sync after a host reset keeps the name
        if (!blelink_name_format(s_name, sizeof(s_name), addr)) {
            ESP_LOGE(TAG, "name does not fit %u bytes", (unsigned)sizeof(s_name));
            return;
        }
        rc = ble_svc_gap_device_name_set(s_name);
        if (rc != 0) ESP_LOGW(TAG, "GAP device name not set: rc=%d", rc);
        atomic_store(&s_named, true);
    }
    if (!advertise()) return;
    ESP_LOGI(TAG, "advertising as %s (%02X:%02X:%02X:%02X:%02X:%02X); heap internal free=%u min=%u",
             s_name, addr[5], addr[4], addr[3], addr[2], addr[1], addr[0],
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
}
