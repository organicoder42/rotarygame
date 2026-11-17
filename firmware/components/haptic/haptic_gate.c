#include "haptic_gate.h"

bool haptic_gate_allow(haptic_gate_t *g, uint32_t now_ms)
{
    if (g->played && (uint32_t)(now_ms - g->last_ms) < HAPTIC_MIN_GAP_MS) return false;
    g->played = true;
    g->last_ms = now_ms;
    return true;
}
