#pragma once
// hud_view — every decision the knob's display makes, with no drawing in it (private to the
// app component): which composed screen a link state and phase select, which theme state a
// health value means, when the link counts as lost, how the microphone meter moves.
// Pure C: depends only on theme.h (plain integers); no ESP-IDF, FreeRTOS or LVGL includes.
// Host-tested in test/host/test_hud_view.c.
// Threading: stateless functions; any task may call them.
#include <stdbool.h>
#include <stdint.h>
#include "theme.h"

// One composed screen per phase, plus the one shown while no browser is talking to us.
typedef enum {
    HUD_VIEW_OFFLINE = 0,
    HUD_VIEW_READY,
    HUD_VIEW_PLAYING,
    HUD_VIEW_PAUSED,
    HUD_VIEW_OVER,
    HUD_VIEW_COUNT,
} hud_view_t;

#define HUD_LINK_TIMEOUT_MS   3000u   // PROTOCOL.md: no `hud` for 3 s = not connected

// Health bands. PROTOCOL.md names three bands but no numbers; these are the firmware's choice.
#define HUD_HEALTH_HIGH_MIN   60      // 60..100 idle colour
#define HUD_HEALTH_MEDIUM_MIN 30      // 30..59 caution colour, below that alarm colour

// Microphone meter range in centi-dBFS: at or below QUIET the meter is empty, at or above
// LOUD it is full. A quiet room measures about -7500 on this board, the haptic motor -4600.
#define HUD_MIC_QUIET_CDB     (-6500)
#define HUD_MIC_LOUD_CDB      (-2500)
#define HUD_METER_DECAY_PCT   6       // per 40 ms tick: full to empty in about 0.7 s

// The aim marker travels this far around the ring per knob detent. It mirrors the game's
// shield, so it must equal CONTROL.DETENT_DEG in knob-game/web/src/config.js (12 when this was
// written). PROTOCOL.md does not carry the number; if the game changes it, change it here.
#define HUD_AIM_DEG_PER_DETENT 12

// The screen for a link state and a `hud` phase (0..3). A phase outside the contract cannot
// come out of the parser; it selects the ready screen so the display never shows a stale game.
hud_view_t hud_view_for(bool connected, uint8_t phase);

// The theme state whose colour the ring takes for a health of 0..100.
theme_state_t hud_view_health_state(uint8_t health);

// The theme state whose motion period the small phase dot borrows on `view`.
theme_state_t hud_view_motion_state(hud_view_t view);

// The short Danish phase label ("klar", "spiller", "pause", "slut"); "" for the offline view.
// Points at a constant; never NULL.
const char *hud_view_tag(hud_view_t view);

// The title of the offline screen: the knob's Bluetooth name ("Ekko-3A7F"), which is what the
// browser's device chooser lists, so that two knobs can be told apart; plain HUD_VIEW_APP_TITLE
// while the radio has no name yet (`ble_name` "" or NULL). Returns `ble_name` itself or a
// constant; never NULL.
#define HUD_VIEW_APP_TITLE "Ekko"
const char *hud_view_offline_title(const char *ble_name);

// True while the last `hud` line is younger than HUD_LINK_TIMEOUT_MS. `seen` is false until
// the first one arrives. Times are milliseconds that may wrap; only the difference is used.
bool hud_view_link_alive(bool seen, uint32_t last_ms, uint32_t now_ms);

// Microphone level (centi-dBFS) to meter fill, 0..100, linear in dB between QUIET and LOUD.
int hud_view_mic_pct(int level_cdb);

// One meter tick: jump up to a louder target at once, fall back by at most
// HUD_METER_DECAY_PCT, so a short sound stays visible for a moment.
int hud_view_meter_step(int shown_pct, int target_pct);
