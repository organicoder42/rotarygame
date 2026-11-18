#pragma once
// app — the Ekko controller: reports the knob, taps, long presses and the microphone level to
// the browser and renders the browser's `hud` lines on the knob's own display, over USB and
// Bluetooth LE at the same time. The contract is knob-game/PROTOCOL.md. Depends on ui, theme,
// haptic, mic, proto, hostlink, blelink; nothing depends on app except the dev console.
// Threading: everything LVGL happens on the LVGL task. Input handlers there only bump atomic
// counters and move the aim marker; the writes to both transports happen on app_link's
// reporter task and received lines are parsed on the task of the transport they came in on
// (USB reader, NimBLE host), handed to the LVGL task through a one-slot queue that a 40 ms
// LVGL timer drains (app_link.h). Neither receive task ever takes the LVGL lock for protocol.
#include <stddef.h>

// Build the screen, wire knob + touch, start the microphone and both links. Call last in
// app_main, after nvs_flash_init() (the radio), ui_init() and haptic_init().
void app_init(void);

// Lines from USB that are not protocol commands go to `handle` (the dev console), on the
// USB reader task; lines from Bluetooth never do. `line` is valid only during the call and may be modified. NULL = such
// lines are ignored, which is what the contract asks for in a production image.
void app_set_console(void (*handle)(char *line));

// Test hooks (components/testctl): run the SAME handlers hardware input runs, so they move the
// counters in `!s` too. Caller holds ui_lock(). Add one per new input; the console never
// reaches into this component's statics.
void app_inject_knob(int steps);    // sign = direction, |steps| detents
void app_inject_tap(void);          // short tap on the screen
void app_inject_zone(void);         // short tap on the small circle
void app_inject_hold(void);         // long press
void app_inject_reset(void);        // counters 0, last hud forgotten -> the offline screen

// The model as one line, after applying every `hud` received so far (caller holds ui_lock()):
// "link=0|1 k=N t=N z=N h=N score=N health=N breath=N phase=N pol=N bad=N ble=NAME". `bad`
// counts rejected protocol lines; `ble` is the advertised name, the one on the offline screen
// ("-" while the radio has none). Writes "error state line needs N bytes" if `cap` is too small.
void app_state_line(char *buf, size_t cap);
