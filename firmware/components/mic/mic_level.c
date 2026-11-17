#include "mic_level.h"
#include <math.h>

// y[n] = x[n] - x[n-1] + a*y[n-1], a = 1 - 2*pi*fc/fs. fc = 150 Hz at fs = 24 kHz gives 0.961:
// low enough to pass speech and claps, high enough to settle within a few milliseconds.
#define DC_BLOCK_A      0.961f
#define FULL_SCALE      32768.0f

int mic_level_block(mic_level_state_t *s, const int16_t *buf, size_t n)
{
    if (n == 0) return LEVEL_FLOOR_CDB;
    if (!s->primed) { s->x1 = (float)buf[0]; s->y = 0.0f; s->primed = true; }

    float acc = 0.0f;
    for (size_t i = 0; i < n; i++) {
        float x = (float)buf[i];
        s->y = x - s->x1 + DC_BLOCK_A * s->y;
        s->x1 = x;
        acc += s->y * s->y;
    }
    float rms = sqrtf(acc / (float)n);
    if (rms <= 0.0f) return LEVEL_FLOOR_CDB;

    int cdb = (int)lroundf(2000.0f * log10f(rms / FULL_SCALE));
    return cdb < LEVEL_FLOOR_CDB ? LEVEL_FLOOR_CDB : cdb;
}
