# Ekko controller firmware

Firmware for the Guition JC3636K518C / Waveshare ESP32-S3-Knob-Touch-LCD-1.8 (ESP32-S3R8,
1.8" 360×360 round ST77916 display, CST816 touch, rotary knob, DRV2605L haptics, PDM
microphone) that turns the knob into the controller of the web game **Ekko**, over USB serial
and over Bluetooth LE, both at the same time.

The wire contract is `../PROTOCOL.md`. This firmware implements it exactly; change that file
first, then `components/proto/` and the web side.

- **Out:** knob detents, taps, taps on the small circle, long presses and the microphone level
  as the `!s <k> <t> <z> <h> <m>` line: absolute counters, sent on change and every 35 ms.
- **In:** `hello`, `hud <score> <health> <breath> <phase> <pol>`, `hap <effect>`.
- **Two transports, one byte stream:** USB Serial/JTAG (with the log and the dev console on the
  same port) and a Bluetooth LE peripheral with the Nordic UART Service (protocol lines only).
  Commands are taken from either, `!s` goes out on both, `!hello ekko 1` goes back on the one
  the `hello` came in on.
- **The knob's own display** is the game HUD, one composed screen per phase, plus an
  "Ikke forbundet" screen after 3 s without a `hud` line, titled with the knob's Bluetooth
  name. An aim marker follows the knob and a small meter follows the microphone, both locally,
  without waiting for the browser.
- **No Wi-Fi.** Bluetooth LE is the only user of the radio.

## Layout

```
components/board/    pins + capabilities (the ONLY place a GPIO number may appear; linted)
components/ui/       ST77916 + CST816 + LVGL bring-up, knob driver, backlight, Muli fonts
components/theme/    design tokens (tokens.h) + colour = state policy, no LVGL dependency
components/haptic/   DRV2605L on the touch I2C bus; haptic_gate.c = the 60 ms spacing rule (pure)
components/mic/      PDM microphone -> level per 10 ms block, DC removed (mic_level.c is pure)
components/proto/    PROTOCOL.md as pure C: host line parser, `!s` formatter
components/hostlink/ USB Serial/JTAG as a line transport: the one reader task, whole-line writes,
                     the log routed through the same path (hostlink_line.c is pure, and shared)
components/blelink/  Bluetooth LE as a line transport: NimBLE peripheral, Nordic UART Service
                     blelink.c        GATT service, bytes -> lines, lines -> notifications
                     blelink_gap.c    name, advertising, the one connection
                     blelink_frame.c  UUIDs, name, split by MTU, buffer gate (pure)
components/app/      app.c         inputs in, screen out
                     app_link.c    `!s` reporter task, dispatch of host lines from both
                                   transports, mic peak-hold
                     app_screen.c  the five composed screens
                     app_screen_live.c  aim marker, mic meter, phase dot
                     hud_view.c    every display decision, no drawing (pure)
components/testctl/  dev console (CONFIG_KNOB_TESTCTL): inject knob/tap/zone/hold, snapshot
main/main.c          boot order (NVS first: the radio keeps its calibration there)
test/host/           Unity suites for every pure module
scripts/             build.sh (Docker), flash.sh (host esptool), test.sh (gcc), gen-fonts.sh,
                     testctl.py + verify-screens.sh (drive the device over USB)
design/              tokens.json / tokens.h, principles.md, fonts + OFL licences
```

## Tasks

| Task | Does | Never |
|---|---|---|
| LVGL (esp_lvgl_port) | draws; knob/touch handlers bump atomic counters and move the aim marker; a 40 ms timer takes the newest `hud`, checks the link timeout, feeds the mic meter | writes to the serial port, waits |
| `report` | builds the `!s` line on a notification or every 35 ms and sends it on both transports; plays `hap`; answers a `hello` that came over Bluetooth | touches LVGL |
| `hostlink_rx` | the only reader of the USB port; parses lines; answers `hello`; runs console commands | lets a second reader exist |
| NimBLE host (`nimble_host`) | the Bluetooth host; assembles written bytes into lines and parses them | waits, does I/O, takes the LVGL lock, writes to USB except for the log |
| `mic` | reads PDM in 10 ms blocks, raises two atomic peaks (wire, screen) | blocks, touches LVGL |

Lines arrive on two tasks. Both run the same dispatch (`app_link.c`), which only parses, stores
atomics, overwrites the one-slot `hud` queue and wakes the reporter; the things that take time
(a haptic effect on the I2C bus, an answer over Bluetooth) are done by the reporter. That is
what keeps the 60 ms `hap` rule and the 3 s `hud` timeout blind to the transport.

Every write to the USB port is one whole line through `hostlink_write()`: queued completely or
not at all. The `!s` line uses `hostlink_write_fresh()`, which sends nothing while the host has
not picked up what was queued before, so old state never piles up while the browser tab is
closed. The reporter sends over Bluetooth first and waits for USB (10 ms at most) only while
the host is actually taking lines, so a knob on a charger keeps its 35 ms rhythm.

## Bluetooth LE

The contract is the section "Bluetooth LE (wireless)" of `../PROTOCOL.md`; `components/blelink`
is its implementation and nothing outside that component includes a NimBLE header.

- **Name:** `Ekko-XXXX`, XXXX = the last two bytes of the chip's public BLE address. It is in the
  scan response, in the GAP device name, in the title of the offline screen, in the boot log
  (`blelink: advertising as Ekko-3A7F (..)`) and in `testctl.py state` (`ble=Ekko-3A7F`).
- **Advertising:** connectable, whenever no central is connected; flags and the 128-bit service
  UUID in the advertising packet, the name in the scan response. One central at a time. If
  advertising cannot be started it is tried again every 100 ms: with a single connection slot
  NimBLE refuses it for a moment after a central gave up in the middle of connecting.
- **Receiving:** every written byte goes through the same line assembler as USB, inside the
  write callback, so a command may come in pieces of any size, one write may hold several
  commands, and several writes without response per connection interval are just more bytes
  (nothing in between that a second write could overwrite; 24 packet buffers sit between the
  controller and the host task). An empty line is ignored. A half line is forgotten when the
  central disconnects, so it cannot merge with the next connection's `hello`.
- **Sending:** `blelink_send_line()` sends a line as one notification when it fits the
  negotiated MTU and in pieces otherwise, and only while the central has notifications enabled.
  It has no wait of its own. A line is dropped when less than half of NimBLE's small buffer
  blocks are free (the central is not taking data; every notification is built from that
  pool) or when the stack refuses its first piece; a line whose first piece went out is always
  finished first, so the central never sees half a line glued to the next.
- **No security:** the NimBLE security manager is compiled out.
- **Connection parameters:** the knob asks for 7.5-15 ms, latency 0, 2 s timeout after
  connecting and publishes the same as its preferred parameters; the log shows what the central
  granted (`blelink: connection updated: interval ...`).
- **Memory:** the NimBLE host allocates from PSRAM (`CONFIG_BT_NIMBLE_MEM_ALLOC_MODE_EXTERNAL`).
  The controller and the host task's 4 KB stack are internal RAM. The boot log prints the
  internal heap at `heap[after init]`, at `advertising as` and after 300 `!s` lines.
- **Power:** the knob needs USB-C power; with Bluetooth any charger and either plug orientation
  will do, because the data lines are not used.

Try it without the game: any "nRF UART" style app (nRF Connect, LightBlue) can connect, enable
notifications on `6e400003-...` and write `hello\n` to `6e400002-...`; the knob answers
`!hello ekko 1` and streams `!s` lines.

## Build, flash, test

```bash
scripts/build.sh                             # docker espressif/idf:release-v5.3 → build/knob_starter.bin
scripts/flash.sh /dev/cu.usbmodem1101        # host esptool --no-stub (first time: full image)
scripts/flash.sh /dev/cu.usbmodem1101 app    # later: app image only
scripts/test.sh                              # host unit tests + GPIO-literal lint, no IDF needed
export KNOB_PORT=/dev/cu.usbmodem1101        # /dev/ttyACM0 on Linux (the default)
scripts/testctl.py state                     # link=0 k=0 t=0 z=0 h=0 score=0 ... bad=0 ble=Ekko-3A7F
scripts/testctl.py hello                     # the handshake over USB: !hello ekko 1
scripts/testctl.py knob +3                   # inject 3 detents -> k=3, also in the `!s` line
scripts/testctl.py hud 1250 80 35 1 1        # what the browser sends; shows the playing screen
scripts/testctl.py snap shot.png             # pixel-exact LVGL screenshot
scripts/verify-screens.sh                    # scripted walk with snapshots, evidence in build/verify/
```

Flash from the host, never from the container (no serial access there). `--no-stub` is required
on this board's native USB. On the K518 the USB-C plug orientation picks the chip: `303a:1001`
is the S3 you flash; `1a86:7523` is the Bluetooth sidecar.

Only one program can hold the port: close the game's browser tab (or disconnect in it) before
using `testctl.py`, and the other way round. A game connected over Bluetooth does not hold the
port, so `testctl.py` works beside it; its `hud` lines and the game's then both reach the
display, the newest wins.

The first build creates `sdkconfig` from `sdkconfig.defaults`. After pulling a change to
`sdkconfig.defaults` (Bluetooth was one), delete `sdkconfig` before building: an existing
`sdkconfig` wins over new defaults, and `fullclean` does not remove it. A build without the
Bluetooth settings stops in `blelink.c` with exactly that advice.

## The display

| Screen | When | Shows |
|---|---|---|
| offline | no `hud` for 3 s | the Bluetooth name ("Ekko-3A7F"; plain "Ekko" until the radio is up), "Ikke forbundet", "Forbind fra browseren"; neutral ring |
| ready | phase 0 | "Ekko" at 64 px, "hold for at starte" |
| playing | phase 1 | the score at 64 px, breath on the arc, polarity on the bottom circle |
| paused | phase 2 | pause glyph, the score at 28 px, "hold for at fortsætte" |
| game over | phase 3 | the final score at 64 px, "hold for at spille igen" |

The ring carries the one status colour, from health through the theme: 60–100 idle, 30–59
caution, below 30 alarm (`hud_view.h`). Everything else uses neutral tokens. The aim marker
turns 12° per detent, the same as `CONTROL.DETENT_DEG` in `../web/src/config.js`.

Fonts are generated by `scripts/gen-fonts.sh` from `design/fonts/Muli-SemiBold.ttf`: 20 px and
28 px (ASCII + Latin-1) and a 64 px score font that holds only `0123456789Eko`. The Bluetooth
name is set in the 28 px font for that reason: the score font has no `-` and no hex letters.

Nothing large is animated: this panel has no TE line. The three things that move are at most
84 × 10 px each.
