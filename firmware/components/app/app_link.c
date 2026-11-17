// app_link.c — the `!s` reporter task, the dispatch of host lines, the microphone peak-hold.
// Three tasks meet here and none of them waits for another: the LVGL task bumps atomics and
// gives a task notification, the mic task raises two atomic peaks, the reader task hands a
// `hud` over through a one-slot queue. Only the reporter and the reader write to the port.
#include "app_link.h"
#include "hostlink.h"
#include "haptic.h"
#include "haptic_gate.h"
#include "hud_view.h"
#include "mic.h"
#include "mic_level.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include <limits.h>
#include <stdatomic.h>

static const char *TAG = "link";

// The contract says "at least every 40 ms". 35 leaves room for the write and for scheduling.
#define REPORT_PERIOD_MS   35
#define REPORT_WRITE_MS    10      // host not reading: give the line up, the next one is absolute
                                   // (hostlink_write_fresh: old lines must never pile up)
#define REPLY_WRITE_MS     50
#define REPORT_STACK       4096
#define REPORT_PRIO        5       // above LVGL (4): a redraw must not delay an input report
#define STACK_LOG_LINES    300u    // log the stack low-water mark after about 10 s of work
#define NO_BLOCK           INT_MIN // "no mic block since the last take"; below every real level
#define STALE_AFTER_LINES    5u      // lines in a row without a block before `m` falls to the floor

static atomic_int    s_knob;
static atomic_uint   s_taps, s_zone_taps, s_holds, s_bad;
static atomic_int    s_peak_wire = NO_BLOCK, s_peak_screen = NO_BLOCK;
static atomic_bool   s_hud_seen;
static atomic_uint   s_hud_ms;
static QueueHandle_t s_hud_q;                  // one slot, overwritten: only the newest matters
static TaskHandle_t  s_reporter;
static void        (*s_console)(char *line);

static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

static void wake_reporter(void)
{
    if (s_reporter) xTaskNotifyGive(s_reporter);
}

// ---- inputs (LVGL task): atomics and a notification, nothing that can wait ----

void app_link_count_knob(int dir) { atomic_fetch_add(&s_knob, dir);      wake_reporter(); }
void app_link_count_tap(void)     { atomic_fetch_add(&s_taps, 1);        wake_reporter(); }
void app_link_count_zone(void)    { atomic_fetch_add(&s_zone_taps, 1);   wake_reporter(); }
void app_link_count_hold(void)    { atomic_fetch_add(&s_holds, 1);       wake_reporter(); }

void app_link_counts(proto_state_t *out)
{
    out->knob      = atomic_load(&s_knob);
    out->taps      = atomic_load(&s_taps);
    out->zone_taps = atomic_load(&s_zone_taps);
    out->holds     = atomic_load(&s_holds);
}

// ---- microphone (mic task, 100 blocks a second) ----

static void raise_peak(atomic_int *peak, int level)
{
    int seen = atomic_load(peak);
    while (level > seen && !atomic_compare_exchange_weak(peak, &seen, level)) { }
}

static void on_mic_block(int level_cdb, uint32_t at_ms)
{
    (void)at_ms;
    raise_peak(&s_peak_wire, level_cdb);
    raise_peak(&s_peak_screen, level_cdb);
}

int app_link_take_mic(void)
{
    int peak = atomic_exchange(&s_peak_screen, NO_BLOCK);
    return peak == NO_BLOCK ? LEVEL_FLOOR_CDB : peak;
}

// `m` for the next line. A line triggered by an input can follow the previous one within one
// 10 ms mic block; it repeats the last level then, because -12000 would read as "the room went
// silent". Only a mic that has really stopped delivering falls to the floor.
static int32_t take_wire_mic(void)
{
    static int      last = LEVEL_FLOOR_CDB;
    static unsigned empty_lines;
    int peak = atomic_exchange(&s_peak_wire, NO_BLOCK);
    if (peak != NO_BLOCK) {
        empty_lines = 0;
        last = peak > 0 ? 0 : peak;     // the contract's scale ends at 0 dBFS
    } else if (++empty_lines >= STALE_AFTER_LINES) {
        last = LEVEL_FLOOR_CDB;
    }
    return last;
}

// ---- reporter task: the only place a `!s` line is written ----

static void report_task(void *arg)
{
    (void)arg;
    char line[PROTO_STATE_LINE_MAX];
    uint32_t lines = 0, dropped = 0;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(REPORT_PERIOD_MS));   // an input, or the heartbeat
        proto_state_t st;
        app_link_counts(&st);
        st.mic_cdb = take_wire_mic();
        size_t n = proto_format_state(line, sizeof(line), &st);
        if (!n) { ESP_LOGE(TAG, "!s line does not fit %u bytes", (unsigned)sizeof(line)); continue; }
        if (!hostlink_write_fresh(line, n, REPORT_WRITE_MS)) dropped++;
        if (++lines == STACK_LOG_LINES)     // everything is running by now: the numbers that matter
            ESP_LOGI(TAG, "reporter: %u lines, %u not taken by the host, stack %u B never used of %u; "
                     "heap internal free=%u min=%u",
                     (unsigned)lines, (unsigned)dropped,
                     (unsigned)uxTaskGetStackHighWaterMark(NULL), (unsigned)REPORT_STACK,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                     (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
    }
}

// ---- host lines (reader task) ----

static void on_hud(const proto_hud_t *hud)
{
    xQueueOverwrite(s_hud_q, hud);
    atomic_store(&s_hud_ms, now_ms());
    atomic_store(&s_hud_seen, true);
}

static void on_hap(uint8_t effect)
{
    static haptic_gate_t gate;
    if (haptic_gate_allow(&gate, now_ms())) haptic_play(effect);
}

static void on_line(char *line)
{
    proto_cmd_t cmd;
    switch (proto_parse(line, &cmd)) {
    case PROTO_HELLO:
        hostlink_write(PROTO_HELLO_REPLY, sizeof(PROTO_HELLO_REPLY) - 1, REPLY_WRITE_MS);
        wake_reporter();                    // "...and sends a `!s` line"
        break;
    case PROTO_HUD:  on_hud(&cmd.hud);  break;
    case PROTO_HAP:  on_hap(cmd.effect); break;
    case PROTO_BAD:  atomic_fetch_add(&s_bad, 1); break;   // no reply by contract; `state` shows the count
    default:
        if (s_console) s_console(line);
        break;
    }
}

bool app_link_poll_hud(proto_hud_t *hud)
{
    return s_hud_q && xQueueReceive(s_hud_q, hud, 0) == pdTRUE;
}

bool app_link_alive(void)
{
    return hud_view_link_alive(atomic_load(&s_hud_seen), atomic_load(&s_hud_ms), now_ms());
}

unsigned app_link_bad_lines(void) { return atomic_load(&s_bad); }

void app_link_reset(void)
{
    atomic_store(&s_knob, 0);
    atomic_store(&s_taps, 0);
    atomic_store(&s_zone_taps, 0);
    atomic_store(&s_holds, 0);
    atomic_store(&s_bad, 0);
    atomic_store(&s_hud_seen, false);
    if (s_hud_q) xQueueReset(s_hud_q);
    wake_reporter();
}

void app_link_set_console(void (*handle)(char *line)) { s_console = handle; }

bool app_link_start(void)
{
    s_hud_q = xQueueCreate(1, sizeof(proto_hud_t));
    if (!s_hud_q) { ESP_LOGE(TAG, "no hud queue"); return false; }
    if (!mic_init(on_mic_block)) ESP_LOGE(TAG, "no microphone: m stays at %d", LEVEL_FLOOR_CDB);
    if (xTaskCreate(report_task, "report", REPORT_STACK, NULL, REPORT_PRIO, &s_reporter) != pdPASS) {
        ESP_LOGE(TAG, "reporter task not created");
        return false;
    }
    return hostlink_init(on_line);
}
