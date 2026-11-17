#pragma once
// haptic_gate — the spacing rule for haptic effects that arrive from outside (PROTOCOL.md:
// "the device drops effects that arrive closer than 60 ms apart"). The motor cannot render
// them, and every effect is three I2C writes on the bus the touch controller shares.
// Pure C: no ESP-IDF, FreeRTOS or LVGL includes; host-tested in test/host/test_haptic_gate.c.
// Threading: one state per caller, used by one task. Zero-initialised = nothing played yet.
#include <stdbool.h>
#include <stdint.h>

#define HAPTIC_MIN_GAP_MS 60u

typedef struct {
    uint32_t last_ms;   // when the last effect was let through
    bool     played;    // false until the first one, so the first effect always passes
} haptic_gate_t;

// True when an effect arriving at `now_ms` may play: the first one, or at least
// HAPTIC_MIN_GAP_MS after the last one that PLAYED (a dropped effect does not push the window
// forward, so a steady stream faster than the gap still plays at the gap's rate). Records the
// time when it returns true. `now_ms` may wrap; only differences are used.
bool haptic_gate_allow(haptic_gate_t *g, uint32_t now_ms);
