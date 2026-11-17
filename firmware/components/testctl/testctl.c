// testctl.c — the dev console's commands. Runs on the host-link reader task and injects events
// into the app under the LVGL lock, so the app's real handlers run exactly as they do for
// hardware input. Every reply is one hostlink line, so a `!s` line can never land inside it.
#include "testctl.h"
#include "app.h"
#include "hostlink.h"
#include "ui.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "mbedtls/base64.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *TAG = "testctl";

#define LOCK_MS        500
#define REPLY_MS       200
#define ROW_MS         1000     // one snapshot row may wait this long for the host to read
#define STATE_LINE_MAX 112      // the reply must fit hostlink_printf's 127 characters with "> "

static void reply(const char *text)
{
    if (!hostlink_printf(REPLY_MS, "> %s\n", text))
        ESP_LOGW(TAG, "reply not sent (host not reading, or over %d chars)", 127);
}

static void reply_state(void)
{
    char line[STATE_LINE_MAX];
    if (!ui_lock(LOCK_MS)) { reply("error lvgl lock"); return; }
    app_state_line(line, sizeof(line));
    ui_unlock();
    reply(line);
}

// One base64 row per line, each queued as ONE unit, so nothing can land inside it.
static bool send_rows(const uint8_t *pixels, uint32_t w, uint32_t h, uint32_t stride)
{
    size_t b64_cap = ((w * 2 + 2) / 3) * 4 + 1;
    unsigned char *row = malloc(2 + b64_cap + 1);
    if (!row) { reply("error no memory for base64"); return false; }
    bool ok = hostlink_printf(REPLY_MS, "SNAP BEGIN %u %u RGB565\n", (unsigned)w, (unsigned)h);
    for (uint32_t y = 0; ok && y < h; y++) {
        size_t olen = 0;
        row[0] = 'S'; row[1] = ':';
        mbedtls_base64_encode(row + 2, b64_cap, &olen, pixels + (size_t)y * stride, w * 2);
        row[2 + olen] = '\n';
        ok = hostlink_write(row, 3 + olen, ROW_MS);
    }
    free(row);
    if (ok) ok = hostlink_printf(REPLY_MS, "SNAP END\n");
    return ok;
}

// Snapshot the active screen into a PSRAM buffer and stream it as base64 rows.
static void do_snap(void)
{
    static uint8_t *s_pixels;
    const lv_color_format_t cf = LV_COLOR_FORMAT_RGB565;
    lv_obj_t *scr = lv_screen_active();
    uint32_t w = lv_obj_get_width(scr), h = lv_obj_get_height(scr);
    uint32_t stride = lv_draw_buf_width_to_stride(w, cf);
    size_t size = (size_t)stride * h;

    if (!s_pixels) s_pixels = heap_caps_aligned_alloc(64, size, MALLOC_CAP_SPIRAM);
    if (!s_pixels) { reply("error no memory for snapshot"); return; }

    lv_draw_buf_t buf;
    lv_draw_buf_init(&buf, w, h, cf, stride, s_pixels, size);
    lv_draw_buf_set_flag(&buf, LV_IMAGE_FLAGS_MODIFIABLE);

    if (!ui_lock(LOCK_MS)) { reply("error lvgl lock"); return; }
    lv_result_t r = lv_snapshot_take_to_draw_buf(scr, cf, &buf);
    ui_unlock();
    if (r != LV_RESULT_OK) { reply("error snapshot failed"); return; }

    if (!send_rows(s_pixels, w, h, stride)) reply("error snapshot stream stalled");
    // Rendering the whole screen is the biggest job this task ever does: size its stack from this.
    ESP_LOGI(TAG, "snap done, reader stack %u B never used", (unsigned)uxTaskGetStackHighWaterMark(NULL));
}

// The commands that inject an input; each runs under the LVGL lock and answers with the state.
static bool inject(const char *line)
{
    bool is_knob = !strncmp(line, "knob ", 5);
    void (*hook)(void) = !strcmp(line, "tap")   ? app_inject_tap  :
                         !strcmp(line, "zone")  ? app_inject_zone :
                         !strcmp(line, "hold")  ? app_inject_hold :
                         !strcmp(line, "reset") ? app_inject_reset : NULL;
    if (!is_knob && !hook) return false;

    if (!ui_lock(LOCK_MS)) { reply("error lvgl lock"); return true; }
    if (is_knob) app_inject_knob((int)strtol(line + 5, NULL, 10));
    else         hook();
    ui_unlock();
    reply_state();
    return true;
}

// Called by the app for every received line that is not a protocol command.
static void handle(char *line)
{
    while (*line == ' ') line++;
    size_t n = strlen(line);
    while (n && (line[n - 1] == '\r' || line[n - 1] == ' ')) line[--n] = '\0';
    if (!n) return;

    if (!strcmp(line, "ping"))  { reply("pong"); return; }
    if (!strcmp(line, "snap"))  { do_snap(); return; }
    if (!strcmp(line, "state")) { reply_state(); return; }
    if (inject(line)) return;

    char msg[96];
    snprintf(msg, sizeof(msg), "error unknown command '%.40s'", line);
    reply(msg);
}

void testctl_init(void)
{
    app_set_console(handle);
    ESP_LOGI(TAG, "serial test console up: knob <±N> | tap | zone | hold | reset | state | snap | ping");
}
