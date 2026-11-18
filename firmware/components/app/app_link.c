// app_link.c — the `!s` reporter task, the dispatch of host lines, the microphone peak-hold.
// Five tasks meet here and none of them waits for another: the LVGL task bumps atomics and
// gives a task notification, the mic task raises two atomic peaks, and the two transports'
// receive tasks (USB reader, NimBLE host) run the same dispatch, which only parses, stores
// atomics, overwrites a one-slot queue and wakes the reporter. Everything that can take time
// on behalf of a received line (a haptic effect on the I2C bus, an answer over Bluetooth) is
// done by the reporter, because the NimBLE host task must never wait. Only the reporter and
// the USB reader write to the USB port; only the reporter sends over Bluetooth.
#include "app_link.h"
#include "blelink.h"
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
#define BLE_HELLO_TRIES    10u     // reporter rounds (about 0.35 s) to get `!hello` into the BLE stack
// Was 4096 while this task only wrote to USB. It now also sends over Bluetooth (NimBLE down to
// the controller, which alone puts a 256-byte packet buffer on this stack) and plays haptics
// (I2C). 6144 is an estimate, not a measurement: read the low-water mark this task logs after
// STACK_LOG_LINES lines with a central connected, and size from that.
#define REPORT_STACK       6144
#define REPORT_PRIO        5       // above LVGL (4): a redraw must not delay an input report
#define STACK_LOG_LINES    300u    // log the stack low-water mark after about 10 s of work
#define NO_BLOCK           INT_MIN // "no mic block since the last take"; below every real level
#define STALE_AFTER_LINES    5u      // lines in a row without a block before `m` falls to the floor

static atomic_int    s_knob;
static atomic_uint   s_taps, s_zone_taps, s_holds, s_bad;
static atomic_int    s_peak_wire = NO_BLOCK, s_peak_screen = NO_BLOCK;
static atomic_bool   s_hud_seen;
static atomic_uint   s_hud_ms;
static atomic_uint   s_hap_pending;            // effect waiting for the reporter; 0 = none
static atomic_uint   s_ble_hello;              // tries left to answer a `hello` that came over BLE
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

// ---- reporter task: the only place a `!s` line is written, on both transports ----

// A `hap` from either transport. The 60 ms rule does not care where a line came from, so its
// gate has one owner, this task; the I2C write happens here too, not on a receive task.
static void play_pending_hap(void)
{
    static haptic_gate_t gate;
    unsigned effect = atomic_exchange(&s_hap_pending, 0);
    if (effect && haptic_gate_allow(&gate, now_ms())) haptic_play((uint8_t)effect);
}

// `!hello ekko 1` for a `hello` that came over Bluetooth, ahead of the `!s` line of the same
// round. It is an answer, not state, so a stack that cannot take it right now gets it offered
// again for a few rounds. A second `hello` arriving in between only restarts the count.
static void answer_ble_hello(void)
{
    unsigned tries = atomic_load(&s_ble_hello);
    if (!tries) return;
    bool sent = blelink_send_line(PROTO_HELLO_REPLY, sizeof(PROTO_HELLO_REPLY) - 1);
    atomic_compare_exchange_strong(&s_ble_hello, &tries, sent ? 0 : tries - 1);
    if (!sent && tries == 1) ESP_LOGW(TAG, "`hello` over Bluetooth not answered: the central is not taking notifications");
}

// The `!s` line to USB. hostlink_write_fresh() waits up to its timeout for the host to have
// taken the previous data, and with no program reading the port (a charger, a closed tab)
// that wait runs out every time. So patience only while the host is taking lines: after one
// refusal the next lines are offered without waiting, until one goes through. Otherwise every
// round would be 10 ms longer than the contract's 40 ms exactly when the knob is on Bluetooth.
static bool report_to_usb(const char *line, size_t n)
{
    static bool refused;
    refused = !hostlink_write_fresh(line, n, refused ? 0 : REPORT_WRITE_MS);
    return !refused;
}

static void report_task(void *arg)
{
    (void)arg;
    char line[PROTO_STATE_LINE_MAX];
    uint32_t lines = 0, usb_dropped = 0, ble_sent = 0;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(REPORT_PERIOD_MS));   // an input, a command, or the heartbeat
        play_pending_hap();
        answer_ble_hello();
        proto_state_t st;
        app_link_counts(&st);
        st.mic_cdb = take_wire_mic();
        size_t n = proto_format_state(line, sizeof(line), &st);
        if (!n) { ESP_LOGE(TAG, "!s line does not fit %u bytes", (unsigned)sizeof(line)); continue; }
        // The same line on both transports; each drops it by its own rule when nobody takes it.
        // Bluetooth first: it never waits, USB may.
        if (blelink_send_line(line, n)) ble_sent++;
        if (!report_to_usb(line, n)) usb_dropped++;
        if (++lines == STACK_LOG_LINES)     // everything is running by now: the numbers that matter
            ESP_LOGI(TAG, "reporter: %u lines, %u not taken over USB, %u sent over BLE, stack %u B "
                     "never used of %u; heap internal free=%u min=%u",
                     (unsigned)lines, (unsigned)usb_dropped, (unsigned)ble_sent,
                     (unsigned)uxTaskGetStackHighWaterMark(NULL), (unsigned)REPORT_STACK,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                     (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
    }
}

// ---- host lines: one dispatch, two callers (USB reader task and NimBLE host task) ----
// Everything dispatch() does on those tasks is safe from both at once and never waits, except
// the two things only the USB side may do: write the `hello` answer to the port and run the
// dev console.

typedef enum { VIA_USB, VIA_BLE } via_t;

static void on_hello(via_t via)
{
    // Answered on the transport it came from; the `!s` line that follows goes out on both.
    if (via == VIA_USB) hostlink_write(PROTO_HELLO_REPLY, sizeof(PROTO_HELLO_REPLY) - 1, REPLY_WRITE_MS);
    else                atomic_store(&s_ble_hello, BLE_HELLO_TRIES);
    wake_reporter();                        // "...and sends a `!s` line"
}

static void on_hud(const proto_hud_t *hud)
{
    xQueueOverwrite(s_hud_q, hud);
    atomic_store(&s_hud_ms, now_ms());
    atomic_store(&s_hud_seen, true);
}

// Of two effects that arrive before the reporter has run, the first stays: the second would
// have fallen to the 60 ms rule anyway.
static void on_hap(uint8_t effect)
{
    unsigned none = 0;
    atomic_compare_exchange_strong(&s_hap_pending, &none, effect);
    wake_reporter();
}

static void dispatch(char *line, via_t via)
{
    proto_cmd_t cmd;
    switch (proto_parse(line, &cmd)) {
    case PROTO_HELLO: on_hello(via);      break;
    case PROTO_HUD:   on_hud(&cmd.hud);   break;
    case PROTO_HAP:   on_hap(cmd.effect); break;
    case PROTO_BAD:   atomic_fetch_add(&s_bad, 1); break;   // no reply by contract; `state` shows the count
    default:
        // Not protocol. Over USB that is the dev console's line; over Bluetooth the contract
        // allows only protocol in either direction, so it is ignored.
        if (via == VIA_USB && s_console) s_console(line);
        break;
    }
}

static void on_usb_line(char *line) { dispatch(line, VIA_USB); }
static void on_ble_line(char *line) { dispatch(line, VIA_BLE); }

bool app_link_poll_hud(proto_hud_t *hud)
{
    return s_hud_q && xQueueReceive(s_hud_q, hud, 0) == pdTRUE;
}

bool app_link_alive(void)
{
    return hud_view_link_alive(atomic_load(&s_hud_seen), atomic_load(&s_hud_ms), now_ms());
}

unsigned app_link_bad_lines(void) { return atomic_load(&s_bad); }

const char *app_link_ble_name(void) { return blelink_name(); }

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
    bool usb = hostlink_init(on_usb_line);  // first: it also carries the log of what follows
    if (!blelink_init(on_ble_line))
        ESP_LOGE(TAG, "no Bluetooth link: this knob can only be reached over USB");
    return usb;
}
