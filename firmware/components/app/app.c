// app.c — wiring: inputs in, screen out. Rules this file keeps:
//   • knob and touch callbacks run on the LVGL task; they count the event (atomics, app_link.h)
//     and move the aim marker, and never write to the serial port or wait for anything;
//   • the screen has exactly one owner, the LVGL task: a 40 ms lv_timer takes the newest `hud`
//     from app_link, checks the 3 s link timeout and feeds the microphone meter;
//   • the knob's display never decides game state. It shows the last `hud` and local feedback.
#include "app.h"
#include "app_link.h"
#include "app_screen.h"
#include "hud_view.h"
#include "ui.h"
#include "knob.h"
#include "esp_log.h"
#include "lvgl.h"
#include <stdio.h>

static const char *TAG = "app";

#define TICK_MS 40    // hud is sent at most 10 times a second; the mic meter wants ~25 fps

// What a fresh display assumes until the first `hud` line: nothing scored, nothing lost.
static const proto_hud_t HUD_BOOT = { .health = PROTO_PERCENT_MAX };

static proto_hud_t s_hud;          // the last `hud` taken from the link (LVGL task only)
static bool        s_connected;

// Take what arrived and make the screen match. LVGL task, or any task holding the lock.
static void sync_screen(void)
{
    proto_hud_t hud;
    if (app_link_poll_hud(&hud)) s_hud = hud;
    s_connected = app_link_alive();
    // The radio gets its name a moment after boot; until then the title is plain "Ekko".
    app_screen_set_offline_title(hud_view_offline_title(app_link_ble_name()));
    app_screen_show(hud_view_for(s_connected, s_hud.phase), &s_hud);
}

static void show_aim(void)
{
    proto_state_t st;
    app_link_counts(&st);
    app_screen_live_set_aim(st.knob);
}

// ---- inputs (LVGL task) ----

static void on_knob_step(int dir) { app_link_count_knob(dir); show_aim(); }
static void on_short_tap(void)    { app_link_count_tap(); }
static void on_long_press(void)   { app_link_count_hold(); }
static void on_zone_tap(void)     { app_link_count_zone(); }

static void on_zone_event(lv_event_t *e)
{
    (void)e;
    on_zone_tap();
}

static void on_touch(lv_event_t *e)
{
    lv_event_code_t code = lv_event_get_code(e);
    if (code == LV_EVENT_SHORT_CLICKED)     on_short_tap();
    else if (code == LV_EVENT_LONG_PRESSED) on_long_press();
}

static void on_tick(lv_timer_t *t)
{
    (void)t;
    sync_screen();
    app_screen_live_set_mic(app_link_take_mic());
}

// ---- test hooks (caller holds the LVGL lock) ----

void app_inject_knob(int steps)
{
    int dir = steps < 0 ? -1 : 1;
    for (int i = 0; i < (steps < 0 ? -steps : steps); i++) on_knob_step(dir);
}

void app_inject_tap(void)  { on_short_tap(); }
void app_inject_zone(void) { on_zone_tap(); }
void app_inject_hold(void) { on_long_press(); }

void app_inject_reset(void)
{
    app_link_reset();
    s_hud = HUD_BOOT;
    show_aim();
    sync_screen();
}

void app_state_line(char *buf, size_t cap)
{
    sync_screen();      // a `hud` sent just before `state` is in the reply and on the screen
    proto_state_t st;
    app_link_counts(&st);
    const char *ble = app_link_ble_name();
    int n = snprintf(buf, cap, "link=%d k=%ld t=%lu z=%lu h=%lu score=%lu health=%u breath=%u phase=%u pol=%u bad=%u ble=%s",
                     (int)s_connected, (long)st.knob, (unsigned long)st.taps,
                     (unsigned long)st.zone_taps, (unsigned long)st.holds,
                     (unsigned long)s_hud.score, (unsigned)s_hud.health, (unsigned)s_hud.breath,
                     (unsigned)s_hud.phase, (unsigned)s_hud.pol, app_link_bad_lines(),
                     ble[0] ? ble : "-");
    if (n < 0 || (size_t)n >= cap) snprintf(buf, cap, "error state line needs %d bytes", n + 1);
}

void app_set_console(void (*handle)(char *line)) { app_link_set_console(handle); }

void app_init(void)
{
    s_hud = HUD_BOOT;
    if (!ui_lock(1000)) { ESP_LOGE(TAG, "no LVGL lock — no screen"); return; }
    app_screen_build();
    sync_screen();
    lv_obj_add_event_cb(app_screen_touch_target(), on_touch, LV_EVENT_SHORT_CLICKED, NULL);
    lv_obj_add_event_cb(app_screen_touch_target(), on_touch, LV_EVENT_LONG_PRESSED, NULL);
    // SHORT_CLICKED, not CLICKED: CLICKED also fires when a long press is released.
    lv_obj_add_event_cb(app_screen_zone_target(), on_zone_event, LV_EVENT_SHORT_CLICKED, NULL);
    lv_timer_create(on_tick, TICK_MS, NULL);
    ui_unlock();

    knob_init(on_knob_step);   // takes the lock itself
    if (!app_link_start()) ESP_LOGE(TAG, "host link not started: the browser cannot see this knob");
    ESP_LOGI(TAG, "ready: Ekko controller, protocol %d", PROTO_VERSION);
}
