// app_screen_live.c — the three small things that move. Each is one object of at most
// 84 x 10 px, so a frame of motion redraws a few hundred pixels, which this panel (no TE line,
// QSPI bandwidth-bound) shows without tearing. Two of them are local feedback that never waits
// for the browser: the aim marker follows the knob, the meter follows the microphone.
#include "app_screen.h"
#include "theme.h"

#define AIM_DIA        10
#define AIM_ORBIT_R    156     // just inside the ring's inner edge (164), outside the arc (142)
#define AIM_MOVE_MS    90      // one detent glides; a fast spin simply retargets

#define METER_H          6
#define METER_W_MIN      6       // quiet: a dot
#define METER_W_MAX      84      // loud: a bar, grown from its centre
#define METER_Y          57      // offset from the centre, between the content and the circle

#define DOT_DIA        10
#define DOT_GAP        8
#define DOT_OPA_LOW    LV_OPA_30

static lv_obj_t *s_aim, *s_mic, *s_dot;
static int32_t   s_aim_deg;    // where the marker is drawn right now

// Animation step and direct setter: `deg` is unwrapped (720 = two turns clockwise).
static void aim_place(void *obj, int32_t deg)
{
    s_aim_deg = deg;
    int16_t a = (int16_t)(((deg % 360) + 360) % 360);
    int32_t x = (AIM_ORBIT_R * lv_trigo_sin(a)) / LV_TRIGO_SIN_MAX;
    int32_t y = -(AIM_ORBIT_R * lv_trigo_cos(a)) / LV_TRIGO_SIN_MAX;
    lv_obj_align(obj, LV_ALIGN_CENTER, x, y);
}

static void dot_opa(void *obj, int32_t opa)
{
    lv_obj_set_style_bg_opa(obj, (lv_opa_t)opa, 0);
}

void app_screen_live_build(lv_obj_t *scr)
{
    s_aim = app_screen_shape(scr, AIM_DIA, AIM_DIA, LV_RADIUS_CIRCLE, HUD_INK);
    aim_place(s_aim, 0);

    s_mic = app_screen_shape(scr, METER_W_MIN, METER_H, LV_RADIUS_CIRCLE, HUD_SUB);
    lv_obj_align(s_mic, LV_ALIGN_CENTER, 0, METER_Y);

    s_dot = app_screen_shape(scr, DOT_DIA, DOT_DIA, LV_RADIUS_CIRCLE, HUD_SUB);
    lv_obj_set_hidden(s_dot, true);
}

void app_screen_live_set_aim(int detents)
{
    int32_t target = (int32_t)detents * HUD_AIM_DEG_PER_DETENT;
    lv_anim_delete(s_aim, aim_place);
    if (target == s_aim_deg) return;

    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, s_aim);
    lv_anim_set_exec_cb(&a, aim_place);
    lv_anim_set_values(&a, s_aim_deg, target);
    lv_anim_set_duration(&a, AIM_MOVE_MS);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
    lv_anim_start(&a);
}

void app_screen_live_set_mic(int level_cdb)
{
    static int shown_pct;
    int pct = hud_view_meter_step(shown_pct, hud_view_mic_pct(level_cdb));
    if (pct == shown_pct) return;
    shown_pct = pct;
    // Aligned to the centre, so the bar grows to both sides when its width changes.
    lv_obj_set_width(s_mic, METER_W_MIN + (METER_W_MAX - METER_W_MIN) * pct / 100);
}

// Breathe with the given period: full -> dim over half of it, back over the other half.
// A period of 0 means solid.
void app_screen_live_set_dot(lv_obj_t *beside, uint32_t color, uint32_t period_ms)
{
    lv_anim_delete(s_dot, dot_opa);
    lv_obj_set_hidden(s_dot, beside == NULL);
    if (!beside) return;

    lv_obj_set_style_bg_color(s_dot, lv_color_hex(color), 0);
    lv_obj_set_style_bg_opa(s_dot, LV_OPA_COVER, 0);
    lv_obj_align_to(s_dot, beside, LV_ALIGN_OUT_LEFT_MID, -DOT_GAP, 0);
    if (period_ms == 0) return;

    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, s_dot);
    lv_anim_set_exec_cb(&a, dot_opa);
    lv_anim_set_values(&a, LV_OPA_COVER, DOT_OPA_LOW);
    lv_anim_set_duration(&a, period_ms / 2);
    lv_anim_set_reverse_duration(&a, period_ms / 2);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_in_out);
    lv_anim_start(&a);
}
