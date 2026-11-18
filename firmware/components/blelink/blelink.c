// blelink.c — the byte pipe: the Nordic UART Service, received bytes -> lines, lines ->
// notifications, and the bring-up of controller + NimBLE host. Who is connected is
// blelink_gap.c's business; every decision about bytes is in blelink_frame.c (pure).
#include "sdkconfig.h"
#if !CONFIG_BT_NIMBLE_ENABLED
// An sdkconfig from before the Bluetooth transport wins over sdkconfig.defaults, and without
// this check the build would fail further down on a missing NimBLE header.
#error "Bluetooth is not enabled in sdkconfig: delete firmware/sdkconfig and build again, so that sdkconfig.defaults applies"
#endif
#include "blelink.h"
#include "blelink_frame.h"
#include "blelink_priv.h"
#include "hostlink_line.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "host/ble_hs.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include <stdatomic.h>

static const char *TAG = "blelink";

static const ble_uuid128_t UUID_SERVICE = BLE_UUID128_INIT(BLELINK_UUID_SERVICE_LE);
static const ble_uuid128_t UUID_RX      = BLE_UUID128_INIT(BLELINK_UUID_RX_LE);
static const ble_uuid128_t UUID_TX      = BLE_UUID128_INIT(BLELINK_UUID_TX_LE);

static blelink_line_cb_t s_on_line;
static atomic_bool       s_up;             // set last in blelink_init; senders on other tasks read it
static uint16_t          s_tx_handle;      // written once by NimBLE when the service registers
static hostlink_line_t   s_rx;             // NimBLE host task only
static SemaphoreHandle_t s_tx_mutex;       // guards s_tx and s_tx_epoch
static blelink_tx_t      s_tx;
static unsigned          s_tx_epoch;       // the link s_tx was loaded for
static int               s_tx_refusal;     // the last reason the stack refused a piece on this link

uint16_t blelink_tx_handle(void) { return s_tx_handle; }
void     blelink_rx_reset(void)  { hostlink_line_reset(&s_rx); }
const char *blelink_name(void)   { return blelink_gap_name(); }

// ---- host -> device (NimBLE host task) ----

// A write is not a message (PROTOCOL.md): it may hold a piece of a line or several lines, and
// the mbuf chain it arrives in may be cut anywhere. So every byte goes through the assembler,
// here, before this callback returns: there is no buffer between the stack and the assembler
// that a second write could overwrite, and NimBLE delivers writes one at a time and in order,
// so several writes without response in one connection interval simply arrive as a longer
// run of bytes. An empty line (the host's lone '\n') reaches the callback like any other.
static int on_rx_write(uint16_t conn, uint16_t attr, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn; (void)attr; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;
    for (const struct os_mbuf *om = ctxt->om; om; om = SLIST_NEXT(om, om_next)) {
        for (uint16_t i = 0; i < om->om_len; i++) {
            char *line = hostlink_line_push(&s_rx, (char)om->om_data[i]);
            if (line) s_on_line(line);
        }
    }
    return 0;
}

// TX is notify-only. NimBLE insists on a callback for every characteristic; with no read or
// write property it is never asked for the value.
static int on_tx_access(uint16_t conn, uint16_t attr, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn; (void)attr; (void)ctxt; (void)arg;
    return BLE_ATT_ERR_READ_NOT_PERMITTED;
}

static const struct ble_gatt_svc_def SERVICES[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &UUID_SERVICE.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            { .uuid = &UUID_RX.u, .access_cb = on_rx_write,
              .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP },
            { .uuid = &UUID_TX.u, .access_cb = on_tx_access,
              .flags = BLE_GATT_CHR_F_NOTIFY, .val_handle = &s_tx_handle },
            { 0 },
        },
    },
    { 0 },
};

// ---- device -> host (any task, under s_tx_mutex) ----

// NimBLE takes every notification from its small-block pool (blelink_frame.h says why that
// matters); the config says how many blocks each pool has.
#define POOL_SMALL  MYNEWT_VAL(MSYS_1_BLOCK_COUNT)
#define POOL_LARGE  MYNEWT_VAL(MSYS_2_BLOCK_COUNT)

// Hand the stack as much of the loaded line as it takes. What it refuses stays loaded; the
// caller decides whether that is the rest of a started line (kept) or a whole line (dropped).
static void pump(uint16_t conn)
{
    uint16_t mtu = ble_att_mtu(conn);
    if (mtu == 0) return;                   // the connection ended a moment ago; the epoch follows
    const char *chunk;
    size_t n;
    while ((n = blelink_tx_peek(&s_tx, mtu, &chunk)) > 0) {
        struct os_mbuf *om = ble_hs_mbuf_from_flat(chunk, (uint16_t)n);
        // ble_gatts_notify_custom() owns `om` from here on, also when it fails.
        int rc = om ? ble_gatts_notify_custom(conn, s_tx_handle, om) : BLE_HS_ENOMEM;
        if (rc != 0) {
            // Rare by design (the pool gate keeps new lines out long before the stack is full),
            // and a reason that never goes away would silence this link: say it, once.
            if (rc != s_tx_refusal) ESP_LOGW(TAG, "stack refused %u bytes: rc=%d", (unsigned)n, rc);
            s_tx_refusal = rc;
            return;
        }
        blelink_tx_sent(&s_tx, n);
    }
}

static bool send_locked(const char *line, size_t len)
{
    uint16_t conn;
    unsigned epoch;
    bool linked = blelink_gap_link(&conn, &epoch);
    if (epoch != s_tx_epoch) {              // a half-sent line must not reach the next listener
        blelink_tx_clear(&s_tx);
        s_tx_epoch = epoch;
        s_tx_refusal = 0;
    }
    if (!linked) return false;

    pump(conn);                             // first the rest of a line that was started
    if (!blelink_tx_idle(&s_tx)) return false;
    if (!blelink_pool_has_room(os_msys_num_free(), POOL_SMALL, POOL_LARGE)) return false;
    if (!blelink_tx_load(&s_tx, line, len)) {
        ESP_LOGE(TAG, "line of %u bytes not sent: the limit is %u", (unsigned)len, (unsigned)BLELINK_LINE_MAX);
        return false;
    }
    pump(conn);
    return !blelink_tx_drop_unstarted(&s_tx);   // the stack took none of it: dropped, not kept
}

bool blelink_send_line(const char *line, size_t len)
{
    if (!atomic_load(&s_up) || !line) return false;
    // No waiting: a caller that finds the sender busy drops its line, like any other line the
    // stack cannot take right now.
    if (xSemaphoreTake(s_tx_mutex, 0) != pdTRUE) return false;
    bool sent = send_locked(line, len);
    xSemaphoreGive(s_tx_mutex);
    return sent;
}

// ---- bring-up ----

static void host_task(void *arg)
{
    (void)arg;
    nimble_port_run();                      // returns only after nimble_port_stop(), which nothing calls
    nimble_port_freertos_deinit();
}

static bool register_service(void)
{
    ble_svc_gap_init();
    ble_svc_gatt_init();
    int rc = ble_gatts_count_cfg(SERVICES);
    if (rc == 0) rc = ble_gatts_add_svcs(SERVICES);
    if (rc != 0) ESP_LOGE(TAG, "GATT service not registered: rc=%d", rc);
    return rc == 0;
}

bool blelink_init(blelink_line_cb_t on_line)
{
    if (!on_line) { ESP_LOGE(TAG, "blelink_init: no line callback"); return false; }
    s_on_line = on_line;
    s_tx_mutex = xSemaphoreCreateMutex();
    if (!s_tx_mutex) { ESP_LOGE(TAG, "no tx mutex"); return false; }

    esp_err_t err = nimble_port_init();     // controller + host; the PHY reads its calibration from NVS
    if (err != ESP_OK) { ESP_LOGE(TAG, "controller/NimBLE init: %s", esp_err_to_name(err)); return false; }
    // The pool gate counts on two pools of the configured sizes; say so if that ever changes.
    if (os_msys_count() != POOL_SMALL + POOL_LARGE)
        ESP_LOGW(TAG, "NimBLE has %d buffer blocks, expected %d + %d: the send gate may be wrong",
                 os_msys_count(), POOL_SMALL, POOL_LARGE);
    ble_hs_cfg.sync_cb = blelink_gap_on_sync;
    ble_hs_cfg.reset_cb = blelink_gap_on_reset;
    blelink_gap_init();
    if (!register_service()) return false;

    atomic_store(&s_up, true);
    nimble_port_freertos_init(host_task);   // the host syncs with the controller, then advertises
    return true;
}
