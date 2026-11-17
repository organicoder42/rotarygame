#pragma once
#include "lvgl.h"

// LVGL bitmap fonts generated from design/fonts/Muli-SemiBold.ttf with lv_font_conv
// (scripts/gen-fonts.sh). Add sizes/faces there, not by hand. All of it is const data in flash.
extern const lv_font_t font_muli_20;         // hints, phase tag. ASCII + Latin-1, so æøå render
extern const lv_font_t font_muli_28;         // titles, messages. ASCII + Latin-1
extern const lv_font_t font_muli_64_score;   // ONLY the glyphs 0123456789 and E k o
