#pragma once
// app_screen — the knob's own display: the Ekko HUD (private to the app component).
//   app_screen.c       the five composed screens (offline, ready, playing, paused, game over)
//   app_screen_live.c  the three small moving parts: aim marker, microphone meter, phase dot
// Every function assumes the LVGL lock is held (call from LVGL callbacks/timers or inside
// ui_lock()). Every colour and motion period comes from the theme tokens, never a literal.
// Nothing here knows about the serial link or tasks; app.c feeds it.
// Motion budget: only the three live parts ever animate, each at most 84 x 10 px. This panel
// has no TE line and a QSPI bus as its bottleneck; anything large changes in one step.
#include <stdbool.h>
#include <stdint.h>
#include "lvgl.h"
#include "hud_view.h"
#include "proto.h"

// Create all widgets on lv_screen_active(). Nothing is laid out until app_screen_show().
void app_screen_build(void);

// Show `view` with the content of `hud`. Only what differs from the last call is redrawn, so
// calling it every tick with unchanged values costs nothing. `hud` is read during the call.
void app_screen_show(hud_view_t view, const proto_hud_t *hud);

// The object that receives taps and long presses (the whole screen).
lv_obj_t *app_screen_touch_target(void);

// The small circle at the bottom: its own short tap, independent of the screen behind it.
lv_obj_t *app_screen_zone_target(void);

// A plain, style-less, non-clickable shape of one colour (`radius` may be LV_RADIUS_CIRCLE).
// Shared by both screen files.
lv_obj_t *app_screen_shape(lv_obj_t *parent, int32_t w, int32_t h, int32_t radius, uint32_t color);

// ---- app_screen_live.c ----

// Create the aim marker, the microphone meter and the phase dot on `scr`.
void app_screen_live_build(lv_obj_t *scr);

// Move the aim marker to where `detents` knob detents from boot point: 12 o'clock at 0,
// clockwise for positive. Local feedback: it never waits for the browser.
void app_screen_live_set_aim(int detents);

// Feed the microphone meter one level in centi-dBFS (call once per tick).
void app_screen_live_set_mic(int level_cdb);

// Put the phase dot left of `beside` in `color`, breathing with `period_ms` (0 = solid).
// `beside` NULL hides the dot.
void app_screen_live_set_dot(lv_obj_t *beside, uint32_t color, uint32_t period_ms);
