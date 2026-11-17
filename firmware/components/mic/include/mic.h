#pragma once
// mic — the board's PDM microphone as a stream of sound levels. Owns the I2S PDM RX channel and
// one task that reads it in 10 ms blocks, removes the DC offset (mic_level.h) and reports the
// level of EVERY block, so a short clap cannot fall between two samples.
// Depends on: board (pins), esp_driver_i2s, esp_timer. Never includes LVGL, net or app.
// Threading: the callback runs on the mic task, 100 times a second. Keep it short, never block,
// never touch LVGL from it.
#include <stdbool.h>
#include <stdint.h>

// level_cdb: block RMS in centi-dBFS with DC removed (about -7500 in a quiet room).
// now_ms: milliseconds since boot, wraps after 49 days; use differences only.
typedef void (*mic_block_cb_t)(int level_cdb, uint32_t now_ms);

// Start capturing and call `on_block` for every block after the 200 ms start-up transient.
// Returns false, with the reason logged, if the I2S channel or the task could not be created;
// the callback is then never called.
bool mic_init(mic_block_cb_t on_block);
