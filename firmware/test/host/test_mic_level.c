// Host tests for mic_level.c: the DC blocker + block RMS that the K518's microphone needs.
#include "unity.h"
#include "mic_level.h"
#include <math.h>
#include <string.h>

#define PI      3.14159265358979323846
#define FS      24000
#define BLOCK   240      // 10 ms
#define DC      1250     // what the idle stream sits at on the real board

void setUp(void) {}
void tearDown(void) {}

static void fill_tone(int16_t *buf, int n, int start, double amp, double hz)
{
    for (int i = 0; i < n; i++)
        buf[i] = (int16_t)lround(DC + amp * sin(2.0 * PI * hz * (start + i) / FS));
}

// Feed `blocks` blocks of a tone and return the level of the last one (filter settled).
static int settled_level(double amp, double hz, int blocks)
{
    mic_level_state_t s = {0};
    int16_t buf[BLOCK];
    int level = 0;
    for (int b = 0; b < blocks; b++) {
        fill_tone(buf, BLOCK, b * BLOCK, amp, hz);
        level = mic_level_block(&s, buf, BLOCK);
    }
    return level;
}

void test_pure_dc_reads_as_silence_not_minus_28(void)
{
    mic_level_state_t s = {0};
    int16_t buf[BLOCK];
    for (int i = 0; i < BLOCK; i++) buf[i] = DC;
    TEST_ASSERT_EQUAL_INT(LEVEL_FLOOR_CDB, mic_level_block(&s, buf, BLOCK));
    TEST_ASSERT_EQUAL_INT(LEVEL_FLOOR_CDB, mic_level_block(&s, buf, BLOCK));
}

void test_tone_on_dc_reads_its_own_level(void)
{
    // 1 kHz, amplitude 1000: RMS 707 LSB = -33.3 dBFS. The 150 Hz blocker costs well under 0.2 dB.
    TEST_ASSERT_INT_WITHIN(30, -3332, settled_level(1000.0, 1000.0, 5));
}

void test_ten_times_the_amplitude_is_20_db_more(void)
{
    int quiet = settled_level(100.0, 1000.0, 5);
    int loud  = settled_level(1000.0, 1000.0, 5);
    TEST_ASSERT_INT_WITHIN(20, 2000, loud - quiet);
}

void test_quiet_room_noise_sits_far_below_the_dc_trap(void)
{
    // +-10 LSB of 1 kHz ripple on the DC offset: about -73 dBFS, nowhere near -28.
    TEST_ASSERT_TRUE(settled_level(10.0, 1000.0, 5) < -7000);
}

void test_state_carries_across_blocks(void)
{
    // One 480-sample block and two 240-sample blocks must see the same filter history.
    int16_t buf[2 * BLOCK];
    fill_tone(buf, 2 * BLOCK, 0, 500.0, 300.0);
    mic_level_state_t a = {0}, b = {0};
    mic_level_block(&a, buf, 2 * BLOCK);
    mic_level_block(&b, buf, BLOCK);
    mic_level_block(&b, buf + BLOCK, BLOCK);
    TEST_ASSERT_EQUAL_FLOAT(a.y, b.y);
    TEST_ASSERT_EQUAL_FLOAT(a.x1, b.x1);
}

void test_empty_block_is_floor_and_leaves_state(void)
{
    mic_level_state_t s = {0};
    TEST_ASSERT_EQUAL_INT(LEVEL_FLOOR_CDB, mic_level_block(&s, NULL, 0));
    TEST_ASSERT_FALSE(s.primed);
}

void test_full_scale_square_does_not_overflow(void)
{
    mic_level_state_t s = {0};
    int16_t buf[BLOCK];
    for (int i = 0; i < BLOCK; i++) buf[i] = (i / 12) % 2 ? INT16_MAX : INT16_MIN;   // 1 kHz square
    int level = mic_level_block(&s, buf, BLOCK);
    TEST_ASSERT_TRUE(level > -600 && level < 700);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_pure_dc_reads_as_silence_not_minus_28);
    RUN_TEST(test_tone_on_dc_reads_its_own_level);
    RUN_TEST(test_ten_times_the_amplitude_is_20_db_more);
    RUN_TEST(test_quiet_room_noise_sits_far_below_the_dc_trap);
    RUN_TEST(test_state_carries_across_blocks);
    RUN_TEST(test_empty_block_is_floor_and_leaves_state);
    RUN_TEST(test_full_scale_square_does_not_overflow);
    return UNITY_END();
}
