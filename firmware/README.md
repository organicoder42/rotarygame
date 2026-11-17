# Ekko controller firmware

Firmware for the Guition JC3636K518C / Waveshare ESP32-S3-Knob-Touch-LCD-1.8 (ESP32-S3R8,
1.8" 360×360 round ST77916 display, CST816 touch, rotary knob, DRV2605L haptics, PDM
microphone) that turns the knob into the controller of the web game **Ekko**, over USB serial.

The wire contract is `../PROTOCOL.md`. This firmware implements it exactly; change that file
first, then `components/proto/` and the web side.

- **Out:** knob detents, taps, taps on the small circle, long presses and the microphone level
  as the `!s <k> <t> <z> <h> <m>` line: absolute counters, sent on change and every 35 ms.
- **In:** `hello`, `hud <score> <health> <breath> <phase> <pol>`, `hap <effect>`.
- **The knob's own display** is the game HUD, one composed screen per phase, plus an
  "Ikke forbundet" screen after 3 s without a `hud` line. An aim marker follows the knob and a
  small meter follows the microphone, both locally, without waiting for the browser.
- **No Wi-Fi.** Nothing starts the radio. `components/net/` is left over from the starter and is
  not referenced by anything; `scripts/build.sh` still asks for its `wifi_secrets.h`.

## Layout

```
components/board/    pins + capabilities (the ONLY place a GPIO number may appear; linted)
components/ui/       ST77916 + CST816 + LVGL bring-up, knob driver, backlight, Muli fonts
components/theme/    design tokens (tokens.h) + colour = state policy, no LVGL dependency
components/haptic/   DRV2605L on the touch I2C bus; haptic_gate.c = the 60 ms spacing rule (pure)
components/mic/      PDM microphone -> level per 10 ms block, DC removed (mic_level.c is pure)
components/proto/    PROTOCOL.md as pure C: host line parser, `!s` formatter
components/hostlink/ USB Serial/JTAG as a line transport: the one reader task, whole-line writes,
                     the log routed through the same path (hostlink_line.c is pure)
components/app/      app.c         inputs in, screen out
                     app_link.c    `!s` reporter task, dispatch of host lines, mic peak-hold
                     app_screen.c  the five composed screens
                     app_screen_live.c  aim marker, mic meter, phase dot
                     hud_view.c    every display decision, no drawing (pure)
components/testctl/  dev console (CONFIG_KNOB_TESTCTL): inject knob/tap/zone/hold, snapshot
components/net/      unused (see above)
main/main.c          boot order
test/host/           Unity suites for every pure module
scripts/             build.sh (Docker), flash.sh (host esptool), test.sh (gcc), gen-fonts.sh,
                     testctl.py + verify-screens.sh (drive the device over USB)
design/              tokens.json / tokens.h, principles.md, fonts + OFL licences
```

## Tasks

| Task | Does | Never |
|---|---|---|
| LVGL (esp_lvgl_port) | draws; knob/touch handlers bump atomic counters and move the aim marker; a 40 ms timer takes the newest `hud`, checks the link timeout, feeds the mic meter | writes to the serial port, waits |
| `report` | builds and writes the `!s` line on a notification or every 35 ms | touches LVGL |
| `hostlink_rx` | the only reader of the port; parses lines; plays `hap`; runs console commands | lets a second reader exist |
| `mic` | reads PDM in 10 ms blocks, raises two atomic peaks (wire, screen) | blocks, touches LVGL |

Every write to the port is one whole line through `hostlink_write()`: queued completely or not
at all. The `!s` line uses `hostlink_write_fresh()`, which sends nothing while the host has not
picked up what was queued before, so old state never piles up while the browser tab is closed.

## Build, flash, test

```bash
scripts/build.sh                             # docker espressif/idf:release-v5.3 → build/knob_starter.bin
scripts/flash.sh /dev/cu.usbmodem1101        # host esptool --no-stub (first time: full image)
scripts/flash.sh /dev/cu.usbmodem1101 app    # later: app image only
scripts/test.sh                              # host unit tests + GPIO-literal lint, no IDF needed
export KNOB_PORT=/dev/cu.usbmodem1101        # /dev/ttyACM0 on Linux (the default)
scripts/testctl.py state                     # link=0 k=0 t=0 z=0 h=0 score=0 health=100 ...
scripts/testctl.py knob +3                   # inject 3 detents -> k=3, also in the `!s` line
scripts/testctl.py hud 1250 80 35 1 1        # what the browser sends; shows the playing screen
scripts/testctl.py snap shot.png             # pixel-exact LVGL screenshot
scripts/verify-screens.sh                    # scripted walk with snapshots, evidence in build/verify/
```

Flash from the host, never from the container (no serial access there). `--no-stub` is required
on this board's native USB. On the K518 the USB-C plug orientation picks the chip: `303a:1001`
is the S3 you flash; `1a86:7523` is the Bluetooth sidecar.

Only one program can hold the port: close the game's browser tab (or disconnect in it) before
using `testctl.py`, and the other way round.

## The display

| Screen | When | Shows |
|---|---|---|
| offline | no `hud` for 3 s | "Ekko", "Ikke forbundet", "Forbind fra browseren"; neutral ring |
| ready | phase 0 | "Ekko" at 64 px, "hold for at starte" |
| playing | phase 1 | the score at 64 px, breath on the arc, polarity on the bottom circle |
| paused | phase 2 | pause glyph, the score at 28 px, "hold for at fortsætte" |
| game over | phase 3 | the final score at 64 px, "hold for at spille igen" |

The ring carries the one status colour, from health through the theme: 60–100 idle, 30–59
caution, below 30 alarm (`hud_view.h`). Everything else uses neutral tokens. The aim marker
turns 12° per detent, the same as `CONTROL.DETENT_DEG` in `../web/src/config.js`.

Fonts are generated by `scripts/gen-fonts.sh` from `design/fonts/Muli-SemiBold.ttf`: 20 px and
28 px (ASCII + Latin-1) and a 64 px score font that holds only `0123456789Eko`.

Nothing large is animated: this panel has no TE line. The three things that move are at most
84 × 10 px each.
