// Host tests for hud_view.c: the decisions behind the knob's display. The theme's token header
// is replaced by stubs/tokens.h, so these pin which theme STATE is chosen, not a colour value.
#include "unity.h"
#include "hud_view.h"
#include <string.h>

void setUp(void) {}
void tearDown(void) {}

void test_each_phase_has_its_own_screen(void)
{
    TEST_ASSERT_EQUAL_INT(HUD_VIEW_READY,   hud_view_for(true, 0));
    TEST_ASSERT_EQUAL_INT(HUD_VIEW_PLAYING, hud_view_for(true, 1));
    TEST_ASSERT_EQUAL_INT(HUD_VIEW_PAUSED,  hud_view_for(true, 2));
    TEST_ASSERT_EQUAL_INT(HUD_VIEW_OVER,    hud_view_for(true, 3));
}

void test_no_link_is_offline_whatever_the_phase(void)
{
    for (uint8_t phase = 0; phase < 4; phase++)
        TEST_ASSERT_EQUAL_INT(HUD_VIEW_OFFLINE, hud_view_for(false, phase));
}

void test_phase_outside_the_contract_shows_ready(void)
{
    TEST_ASSERT_EQUAL_INT(HUD_VIEW_READY, hud_view_for(true, 4));
    TEST_ASSERT_EQUAL_INT(HUD_VIEW_READY, hud_view_for(true, 255));
}

void test_health_bands(void)
{
    TEST_ASSERT_EQUAL_INT(THEME_STATE_IDLE,        hud_view_health_state(100));
    TEST_ASSERT_EQUAL_INT(THEME_STATE_IDLE,        hud_view_health_state(60));
    TEST_ASSERT_EQUAL_INT(THEME_STATE_LOW_BATTERY, hud_view_health_state(59));
    TEST_ASSERT_EQUAL_INT(THEME_STATE_LOW_BATTERY, hud_view_health_state(30));
    TEST_ASSERT_EQUAL_INT(THEME_STATE_ERROR,       hud_view_health_state(29));
    TEST_ASSERT_EQUAL_INT(THEME_STATE_ERROR,       hud_view_health_state(0));
}

void test_health_bands_use_three_different_colours(void)
{
    uint32_t high = theme_state_color(hud_view_health_state(100));
    uint32_t mid  = theme_state_color(hud_view_health_state(45));
    uint32_t low  = theme_state_color(hud_view_health_state(10));
    TEST_ASSERT_EQUAL_HEX32(HUD_ST_IDLE, high);
    TEST_ASSERT_EQUAL_HEX32(HUD_ST_LOW_BATTERY, mid);
    TEST_ASSERT_EQUAL_HEX32(HUD_ST_ERROR, low);
}

void test_tags_are_the_danish_phase_labels(void)
{
    TEST_ASSERT_EQUAL_STRING("klar",    hud_view_tag(HUD_VIEW_READY));
    TEST_ASSERT_EQUAL_STRING("spiller", hud_view_tag(HUD_VIEW_PLAYING));
    TEST_ASSERT_EQUAL_STRING("pause",   hud_view_tag(HUD_VIEW_PAUSED));
    TEST_ASSERT_EQUAL_STRING("slut",    hud_view_tag(HUD_VIEW_OVER));
    TEST_ASSERT_EQUAL_STRING("",        hud_view_tag(HUD_VIEW_OFFLINE));
    TEST_ASSERT_EQUAL_STRING("",        hud_view_tag(HUD_VIEW_COUNT));
}

void test_dot_is_solid_while_playing_and_moves_while_waiting(void)
{
    TEST_ASSERT_EQUAL_UINT32(HUD_MS_RECORDING,    theme_state_motion_ms(hud_view_motion_state(HUD_VIEW_PLAYING)));
    TEST_ASSERT_EQUAL_UINT32(HUD_MS_IDLE_BREATHE, theme_state_motion_ms(hud_view_motion_state(HUD_VIEW_READY)));
    TEST_ASSERT_EQUAL_UINT32(HUD_MS_PAUSED_PULSE, theme_state_motion_ms(hud_view_motion_state(HUD_VIEW_PAUSED)));
    TEST_ASSERT_EQUAL_UINT32(HUD_MS_RECORDING,    theme_state_motion_ms(hud_view_motion_state(HUD_VIEW_OVER)));
    TEST_ASSERT_EQUAL_INT(THEME_STATE_RECORDING,  hud_view_motion_state(HUD_VIEW_COUNT));
}

void test_link_is_dead_until_the_first_hud(void)
{
    TEST_ASSERT_FALSE(hud_view_link_alive(false, 0, 0));
    TEST_ASSERT_FALSE(hud_view_link_alive(false, 1000, 1001));
}

void test_link_times_out_after_3_s(void)
{
    TEST_ASSERT_TRUE(hud_view_link_alive(true, 5000, 5000));
    TEST_ASSERT_TRUE(hud_view_link_alive(true, 5000, 7999));
    TEST_ASSERT_FALSE(hud_view_link_alive(true, 5000, 8000));
    TEST_ASSERT_FALSE(hud_view_link_alive(true, 5000, 60000));
}

void test_link_timeout_survives_clock_wrap(void)
{
    TEST_ASSERT_TRUE(hud_view_link_alive(true, UINT32_MAX - 999, 1999));     // 2999 ms later
    TEST_ASSERT_FALSE(hud_view_link_alive(true, UINT32_MAX - 999, 2000));    // 3000 ms later
}

void test_mic_meter_range(void)
{
    TEST_ASSERT_EQUAL_INT(0,   hud_view_mic_pct(-12000));
    TEST_ASSERT_EQUAL_INT(0,   hud_view_mic_pct(-7500));      // a quiet room shows nothing
    TEST_ASSERT_EQUAL_INT(0,   hud_view_mic_pct(HUD_MIC_QUIET_CDB));
    TEST_ASSERT_EQUAL_INT(50,  hud_view_mic_pct(-4500));
    TEST_ASSERT_EQUAL_INT(100, hud_view_mic_pct(HUD_MIC_LOUD_CDB));
    TEST_ASSERT_EQUAL_INT(100, hud_view_mic_pct(0));
    TEST_ASSERT_EQUAL_INT(100, hud_view_mic_pct(500));
}

void test_meter_jumps_up_and_falls_slowly(void)
{
    TEST_ASSERT_EQUAL_INT(80, hud_view_meter_step(10, 80));
    TEST_ASSERT_EQUAL_INT(80 - HUD_METER_DECAY_PCT, hud_view_meter_step(80, 0));
    TEST_ASSERT_EQUAL_INT(78, hud_view_meter_step(80, 78));   // never below the target
    TEST_ASSERT_EQUAL_INT(0,  hud_view_meter_step(3, 0));
    TEST_ASSERT_EQUAL_INT(0,  hud_view_meter_step(0, 0));
}

void test_meter_reaches_zero(void)
{
    int shown = 100, ticks = 0;
    while (shown > 0 && ticks < 100) { shown = hud_view_meter_step(shown, 0); ticks++; }
    TEST_ASSERT_EQUAL_INT(0, shown);
    TEST_ASSERT_TRUE(ticks <= 25);       // within a second at 40 ms a tick
}

// ---- offline title: the Bluetooth name once the radio has one ----

void test_offline_title_is_the_ble_name(void)
{
    static const char NAME[] = "Ekko-3A7F";
    TEST_ASSERT_EQUAL_PTR(NAME, hud_view_offline_title(NAME));
}

void test_offline_title_is_the_app_name_until_the_radio_has_one(void)
{
    TEST_ASSERT_EQUAL_STRING("Ekko", hud_view_offline_title(""));
    TEST_ASSERT_EQUAL_STRING("Ekko", hud_view_offline_title(NULL));
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_offline_title_is_the_ble_name);
    RUN_TEST(test_offline_title_is_the_app_name_until_the_radio_has_one);
    RUN_TEST(test_each_phase_has_its_own_screen);
    RUN_TEST(test_no_link_is_offline_whatever_the_phase);
    RUN_TEST(test_phase_outside_the_contract_shows_ready);
    RUN_TEST(test_health_bands);
    RUN_TEST(test_health_bands_use_three_different_colours);
    RUN_TEST(test_tags_are_the_danish_phase_labels);
    RUN_TEST(test_dot_is_solid_while_playing_and_moves_while_waiting);
    RUN_TEST(test_link_is_dead_until_the_first_hud);
    RUN_TEST(test_link_times_out_after_3_s);
    RUN_TEST(test_link_timeout_survives_clock_wrap);
    RUN_TEST(test_mic_meter_range);
    RUN_TEST(test_meter_jumps_up_and_falls_slowly);
    RUN_TEST(test_meter_reaches_zero);
    return UNITY_END();
}
