// Host tests for haptic_gate.c: PROTOCOL.md's "effects closer than 60 ms apart are dropped".
#include "unity.h"
#include "haptic_gate.h"

void setUp(void) {}
void tearDown(void) {}

void test_first_effect_always_plays(void)
{
    haptic_gate_t g = {0};
    TEST_ASSERT_TRUE(haptic_gate_allow(&g, 0));
    haptic_gate_t later = {0};
    TEST_ASSERT_TRUE(haptic_gate_allow(&later, 5));    // also when the clock is still below 60
}

void test_closer_than_60_ms_is_dropped(void)
{
    haptic_gate_t g = {0};
    TEST_ASSERT_TRUE(haptic_gate_allow(&g, 1000));
    TEST_ASSERT_FALSE(haptic_gate_allow(&g, 1000));
    TEST_ASSERT_FALSE(haptic_gate_allow(&g, 1059));
}

void test_60_ms_apart_plays(void)
{
    haptic_gate_t g = {0};
    TEST_ASSERT_TRUE(haptic_gate_allow(&g, 1000));
    TEST_ASSERT_TRUE(haptic_gate_allow(&g, 1060));
    TEST_ASSERT_FALSE(haptic_gate_allow(&g, 1119));
    TEST_ASSERT_TRUE(haptic_gate_allow(&g, 1120));
}

void test_dropped_effects_do_not_push_the_window(void)
{
    // A stream every 20 ms must still play every third effect, not starve for ever.
    haptic_gate_t g = {0};
    int played = 0;
    for (uint32_t t = 0; t < 600; t += 20) played += haptic_gate_allow(&g, t);
    TEST_ASSERT_EQUAL_INT(10, played);
}

void test_clock_wrap(void)
{
    haptic_gate_t g = {0};
    TEST_ASSERT_TRUE(haptic_gate_allow(&g, UINT32_MAX - 9));      // 10 ms before the wrap
    TEST_ASSERT_FALSE(haptic_gate_allow(&g, 20));                 // 30 ms later
    TEST_ASSERT_TRUE(haptic_gate_allow(&g, 50));                  // 60 ms later
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_first_effect_always_plays);
    RUN_TEST(test_closer_than_60_ms_is_dropped);
    RUN_TEST(test_60_ms_apart_plays);
    RUN_TEST(test_dropped_effects_do_not_push_the_window);
    RUN_TEST(test_clock_wrap);
    return UNITY_END();
}
