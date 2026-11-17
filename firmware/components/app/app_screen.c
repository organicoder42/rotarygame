// app_screen.c — the five composed screens. One set of widgets, one row of LAYOUT per screen:
// a screen is "which widgets are visible, with which text, at which height". Geometry, from the
// bezel inwards (radii from the centre of the 360 px panel):
//   170..164  status ring (the one status colour on the screen)
//   161..151  orbit of the aim marker (app_screen_live.c)
//   142..134  breath arc
//   < 134     content; everything below is placed by its offset from the centre
#include "app_screen.h"
#include "theme.h"
#include "fonts.h"

#define APP_TITLE   "Ekko"

#define RING_W      6
#define ARC_DIA     284
#define ARC_W       8
#define TAG_Y       66      // from the top edge; the row is 100 px wide where the arc is 10 px away
#define TAG_SHIFT   9       // half of dot + gap, so dot and label are centred as a pair
#define TITLE_Y     (-78)
#define BAR_W       12      // the pause glyph: two bars
#define BAR_H       40
#define BAR_DX      12
#define BAR_Y       (-44)
#define ZONE_DIA    48      // polarity circle = second tap zone; ext click area adds a finger margin
#define ZONE_PAD    10
#define ZONE_Y      102
#define ZONE_RING_W 3

// Marks "this label shows the score" in LAYOUT; compared by address, never printed.
static const char SCORE[] = "#";

typedef struct {
    bool        arc, tag, bars, title;
    const char *big;                    // 64 px line (digits and "Ekko" only); NULL = hidden
    const char *mid;                    // 28 px line
    const char *hint;                   // 20 px line
    int16_t     big_y, mid_y, hint_y;   // offsets from the centre
} layout_t;

static const layout_t LAYOUT[HUD_VIEW_COUNT] = {
    [HUD_VIEW_OFFLINE] = { .title = true,
                           .mid = "Ikke forbundet", .mid_y = -30,
                           .hint = "Forbind fra browseren", .hint_y = 14 },
    [HUD_VIEW_READY]   = { .tag = true, .big = APP_TITLE, .big_y = -26,
                           .hint = "hold for at starte", .hint_y = 26 },
    [HUD_VIEW_PLAYING] = { .tag = true, .arc = true, .big = SCORE, .big_y = -6 },
    [HUD_VIEW_PAUSED]  = { .tag = true, .arc = true, .bars = true, .mid = SCORE, .mid_y = 2,
                           .hint = "hold for at fortsætte", .hint_y = 32 },
    [HUD_VIEW_OVER]    = { .tag = true, .big = SCORE, .big_y = -26,
                           .hint = "hold for at spille igen", .hint_y = 26 },
};

static lv_obj_t *s_ring, *s_arc, *s_tag, *s_title, *s_big, *s_mid, *s_hint, *s_zone, *s_bars[2];

static struct {
    bool          valid;
    hud_view_t    view;
    proto_hud_t   hud;
    theme_state_t status;
} s_shown;

lv_obj_t *app_screen_shape(lv_obj_t *parent, int32_t w, int32_t h, int32_t radius, uint32_t color)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    lv_obj_set_size(o, w, h);
    lv_obj_set_style_radius(o, radius, 0);
    lv_obj_set_style_bg_color(o, lv_color_hex(color), 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_clickable(o, false);     // taps fall through to the screen
    lv_obj_set_scrollable(o, false);
    return o;
}

static lv_obj_t *make_label(lv_obj_t *parent, const lv_font_t *font, uint32_t color)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
    lv_label_set_text(l, "");
    return l;
}

static lv_obj_t *make_arc(lv_obj_t *parent)
{
    lv_obj_t *arc = lv_arc_create(parent);
    lv_obj_set_size(arc, ARC_DIA, ARC_DIA);
    lv_obj_center(arc);
    lv_arc_set_rotation(arc, 270);              // empty at 12 o'clock, fills clockwise
    lv_arc_set_bg_angles(arc, 0, 360);
    lv_arc_set_range(arc, 0, PROTO_PERCENT_MAX);
    lv_obj_remove_style(arc, NULL, LV_PART_KNOB);
    lv_obj_set_style_arc_width(arc, ARC_W, LV_PART_MAIN);
    lv_obj_set_style_arc_width(arc, ARC_W, LV_PART_INDICATOR);
    lv_obj_set_style_arc_color(arc, lv_color_hex(HUD_LINE), LV_PART_MAIN);
    lv_obj_set_style_arc_color(arc, lv_color_hex(HUD_SUB), LV_PART_INDICATOR);
    lv_obj_set_clickable(arc, false);
    return arc;
}

void app_screen_build(void)
{
    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, lv_color_hex(HUD_BG), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_set_scrollable(scr, false);
    lv_obj_set_clickable(scr, true);

    // Status ring: a border on a transparent circle, the full safe diameter.
    s_ring = app_screen_shape(scr, HUD_SAFE_DIA, HUD_SAFE_DIA, LV_RADIUS_CIRCLE, HUD_BG);
    lv_obj_set_style_bg_opa(s_ring, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(s_ring, RING_W, 0);
    lv_obj_center(s_ring);

    s_arc = make_arc(scr);
    app_screen_live_build(scr);

    s_tag   = make_label(scr, &font_muli_20, HUD_SUB);
    s_title = make_label(scr, &font_muli_28, HUD_SUB);
    s_big   = make_label(scr, &font_muli_64_score, HUD_INK);
    s_mid   = make_label(scr, &font_muli_28, HUD_INK);
    s_hint  = make_label(scr, &font_muli_20, HUD_SUB);
    lv_obj_align(s_tag, LV_ALIGN_TOP_MID, TAG_SHIFT, TAG_Y);
    lv_label_set_text(s_title, APP_TITLE);
    lv_obj_align(s_title, LV_ALIGN_CENTER, 0, TITLE_Y);

    for (int i = 0; i < 2; i++) {
        s_bars[i] = app_screen_shape(scr, BAR_W, BAR_H, BAR_W / 4, HUD_INK);
        lv_obj_align(s_bars[i], LV_ALIGN_CENTER, i ? BAR_DX : -BAR_DX, BAR_Y);
    }

    // Clickable, so a tap here goes to its own handler and not to the screen behind it (LVGL
    // does not bubble events by default).
    s_zone = app_screen_shape(scr, ZONE_DIA, ZONE_DIA, LV_RADIUS_CIRCLE, HUD_PANEL);
    lv_obj_set_style_border_width(s_zone, ZONE_RING_W, 0);
    lv_obj_align(s_zone, LV_ALIGN_CENTER, 0, ZONE_Y);
    lv_obj_set_clickable(s_zone, true);
    lv_obj_set_ext_click_area(s_zone, ZONE_PAD);
}

// Show `label` with `text` at `y` from the centre, or hide it when the screen has no such line.
// The SCORE marker only places the label; apply_score() writes the number.
static void place_line(lv_obj_t *label, const char *text, int32_t y)
{
    lv_obj_set_hidden(label, text == NULL);
    if (!text) return;
    if (text != SCORE) lv_label_set_text(label, text);
    lv_obj_align(label, LV_ALIGN_CENTER, 0, y);
}

static void apply_layout(hud_view_t view)
{
    const layout_t *l = &LAYOUT[view];
    lv_obj_set_hidden(s_arc, !l->arc);
    lv_obj_set_hidden(s_title, !l->title);
    lv_obj_set_hidden(s_bars[0], !l->bars);
    lv_obj_set_hidden(s_bars[1], !l->bars);
    lv_obj_set_hidden(s_tag, !l->tag);
    lv_label_set_text(s_tag, hud_view_tag(view));
    place_line(s_big, l->big, l->big_y);
    place_line(s_mid, l->mid, l->mid_y);
    place_line(s_hint, l->hint, l->hint_y);
}

// The one status colour: the ring and the phase dot. The tag's text stays neutral: the idle
// teal is too dark to read as 20 px text on this background. Offline has no game state to
// show, so the ring falls back to a neutral hairline token.
static void apply_status(hud_view_t view, theme_state_t status)
{
    uint32_t color = view == HUD_VIEW_OFFLINE ? HUD_LINE : theme_state_color(status);
    lv_obj_set_style_border_color(s_ring, lv_color_hex(color), 0);
    lv_obj_update_layout(s_tag);        // the dot sits left of the tag's new width
    app_screen_live_set_dot(LAYOUT[view].tag ? s_tag : NULL, color,
                            theme_state_motion_ms(hud_view_motion_state(view)));
}

static void apply_score(hud_view_t view, uint32_t score)
{
    const layout_t *l = &LAYOUT[view];
    if (l->big == SCORE) lv_label_set_text_fmt(s_big, "%u", (unsigned)score);
    if (l->mid == SCORE) lv_label_set_text_fmt(s_mid, "%u", (unsigned)score);
}

// Neutral tokens on purpose: status colours belong to the ring (design/principles.md).
static void apply_polarity(bool filled)
{
    lv_obj_set_style_bg_color(s_zone, lv_color_hex(filled ? HUD_INK : HUD_PANEL), 0);
    lv_obj_set_style_border_color(s_zone, lv_color_hex(filled ? HUD_INK : HUD_SUB), 0);
}

void app_screen_show(hud_view_t view, const proto_hud_t *hud)
{
    if ((unsigned)view >= HUD_VIEW_COUNT) return;
    bool fresh = !s_shown.valid || view != s_shown.view;
    theme_state_t status = hud_view_health_state(hud->health);
    bool filled = view != HUD_VIEW_OFFLINE && hud->pol;

    if (fresh) apply_layout(view);
    if (fresh || status != s_shown.status)         apply_status(view, status);
    if (fresh || hud->score != s_shown.hud.score)  apply_score(view, hud->score);
    if (fresh || hud->breath != s_shown.hud.breath) lv_arc_set_value(s_arc, hud->breath);
    if (fresh || hud->pol != s_shown.hud.pol)      apply_polarity(filled);

    s_shown.valid = true;
    s_shown.view = view;
    s_shown.hud = *hud;
    s_shown.status = status;
}

lv_obj_t *app_screen_touch_target(void) { return lv_screen_active(); }
lv_obj_t *app_screen_zone_target(void)  { return s_zone; }
