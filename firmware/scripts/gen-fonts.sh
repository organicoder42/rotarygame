#!/usr/bin/env bash
# Regenerate the LVGL bitmap fonts in components/ui/fonts/ from design/fonts/. Needs node.
# Latin-1 supplement (0x00C0-0x00FF) covers æøåÆØÅ and accents. 4 bpp = smooth edges.
# Add a size or face here, declare it in fonts/fonts.h and list the .c in components/ui/CMakeLists.txt.
#   muli_20        hints and the phase tag
#   muli_28        titles and messages
#   muli_64_score  the score, readable at arm's length: digits plus the letters of "Ekko" only,
#                  which keeps it at 14 glyphs. Stay well below 120 px: a font that size once
#                  blanked this panel with a clean boot log.
set -euo pipefail
cd "$(dirname "$0")/.."
FONT=design/fonts/Muli-SemiBold.ttf
OUT=components/ui/fonts

gen() {   # gen <size> <output name> <lv_font_conv glyph selection...>
  local size="$1" name="$2"; shift 2
  npx --yes lv_font_conv --font "$FONT" "$@" \
    --size "$size" --bpp 4 --format lvgl \
    --force-fast-kern-format --no-compress \
    -o "$OUT/$name.c"
}

gen 20 font_muli_20       --range 0x20-0x7E,0x00C0-0x00FF
gen 28 font_muli_28       --range 0x20-0x7E,0x00C0-0x00FF
gen 64 font_muli_64_score --symbols 0123456789Eko
