// hostlink.c — USB Serial/JTAG driver, reader task, whole-line writes, log hook.
// Why not printf: the driver-backed stdout queues one character at a time and drops the ones
// that do not fit, so with a full buffer (browser tab closed) the host later receives line
// fragments, and the head of one `!s` line glued to the tail of another still parses as valid.
// usb_serial_jtag_write_bytes() puts a whole buffer into the transmit ring or nothing.
#include "hostlink.h"
#include "hostlink_line.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

static const char *TAG = "hostlink";

#define RX_RING_BYTES   1024
#define TX_RING_BYTES   4096
#define READ_CHUNK      64
// The console's `snap` renders the whole screen on this task. Measured with the busiest screen
// (six-digit score, full arc): 3.5 KB used; 6 KB leaves well over a quarter spare.
#define READER_STACK    6144
#define READER_PRIO     5       // above LVGL (4): a `hap` must not wait for a redraw
#define PRINTF_MAX      128
#define LOG_LINE_MAX    256
#define LOG_WAIT_MS     10      // a log line may wait this long for buffer room, then it is dropped

static hostlink_line_cb_t s_on_line;
static bool               s_up;
static SemaphoreHandle_t  s_log_mutex;             // guards s_log_line
static char               s_log_line[LOG_LINE_MAX];

bool hostlink_write(const void *data, size_t len, uint32_t timeout_ms)
{
    if (!s_up || !data || !len) return false;
    return usb_serial_jtag_write_bytes(data, len, pdMS_TO_TICKS(timeout_ms)) == (int)len;
}

bool hostlink_write_fresh(const void *data, size_t len, uint32_t timeout_ms)
{
    if (!s_up) return false;
    // ESP_OK means the transmit ring is empty AND the host has taken the last packet.
    if (usb_serial_jtag_wait_tx_done(pdMS_TO_TICKS(timeout_ms)) != ESP_OK) return false;
    return hostlink_write(data, len, timeout_ms);
}

bool hostlink_printf(uint32_t timeout_ms, const char *fmt, ...)
{
    char line[PRINTF_MAX];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    if (n <= 0 || n >= (int)sizeof(line)) return false;
    return hostlink_write(line, (size_t)n, timeout_ms);
}

// Installed with esp_log_set_vprintf: every ESP_LOGx line becomes one hostlink_write. An
// overlong line is cut but keeps a colour reset and its newline, so the next line still starts
// at column 0 in the default colour.
static int log_to_link(const char *fmt, va_list ap)
{
    static const char CUT_END[] = "\033[0m\n";
    if (xSemaphoreTake(s_log_mutex, pdMS_TO_TICKS(LOG_WAIT_MS)) != pdTRUE) return 0;
    int n = vsnprintf(s_log_line, sizeof(s_log_line), fmt, ap);
    if (n >= (int)sizeof(s_log_line)) {
        n = (int)sizeof(s_log_line) - 1;
        memcpy(s_log_line + n - (sizeof(CUT_END) - 1), CUT_END, sizeof(CUT_END) - 1);
    }
    if (n > 0) hostlink_write(s_log_line, (size_t)n, LOG_WAIT_MS);
    xSemaphoreGive(s_log_mutex);
    return n;
}

static void reader_task(void *arg)
{
    (void)arg;
    static hostlink_line_t lb;
    uint8_t chunk[READ_CHUNK];
    for (;;) {
        // Returns as soon as any byte is there; the timeout only bounds the idle wait.
        int n = usb_serial_jtag_read_bytes(chunk, sizeof(chunk), pdMS_TO_TICKS(100));
        for (int i = 0; i < n; i++) {
            char *line = hostlink_line_push(&lb, (char)chunk[i]);
            if (line) s_on_line(line);
        }
    }
}

bool hostlink_init(hostlink_line_cb_t on_line)
{
    if (!on_line) { ESP_LOGE(TAG, "hostlink_init: no line callback"); return false; }
    s_on_line = on_line;

    usb_serial_jtag_driver_config_t cfg = { .rx_buffer_size = RX_RING_BYTES, .tx_buffer_size = TX_RING_BYTES };
    esp_err_t err = usb_serial_jtag_driver_install(&cfg);
    if (err != ESP_OK) { ESP_LOGE(TAG, "usb_serial_jtag driver: %s", esp_err_to_name(err)); return false; }
    usb_serial_jtag_vfs_use_driver();   // a stray printf goes through the driver, not around it

    s_log_mutex = xSemaphoreCreateMutex();
    if (!s_log_mutex) { ESP_LOGE(TAG, "no log mutex"); return false; }
    s_up = true;
    esp_log_set_vprintf(log_to_link);

    if (xTaskCreate(reader_task, "hostlink_rx", READER_STACK, NULL, READER_PRIO, NULL) != pdPASS) {
        ESP_LOGE(TAG, "reader task not created");
        return false;
    }
    ESP_LOGI(TAG, "host link up on USB Serial/JTAG");
    return true;
}
