#pragma once
// mic_level — turns raw PDM-decimated samples into a sound level. Owns the DC blocker that this
// board's microphone needs: the ESP32-S3 decimator has no high-pass and the stream idles near
// +1200 LSB, so RMS over raw samples reads about -28 dBFS whatever the room does
// (jc3636k518-device/references/microphone.md). Pure C: no ESP-IDF, FreeRTOS or LVGL includes;
// host-tested in test/host/test_mic_level.c.
// Threading: one state per stream, used by one task. No globals, no allocation.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Levels are centi-dB relative to full scale: -7500 means -75.00 dBFS. Integers keep the
// detector and its tests free of float comparisons.
#define LEVEL_FLOOR_CDB  (-12000)   // returned for digital silence (log of zero)

// Filter state carried from one block to the next. Zero-initialised = not primed yet.
typedef struct {
    float x1;        // previous input sample
    float y;         // previous output sample
    bool  primed;    // false until the first sample seeds x1, so the DC step does not ring
} mic_level_state_t;

// Remove DC from `buf[0..n)` (one-pole blocker, 150 Hz at 24 kHz) and return the block's RMS in
// centi-dBFS. Never below LEVEL_FLOOR_CDB. n == 0 returns the floor and leaves the state alone.
int mic_level_block(mic_level_state_t *s, const int16_t *buf, size_t n);
