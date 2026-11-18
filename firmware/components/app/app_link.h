#pragma once
// app_link — everything the app says to and hears from the browser (private to the app
// component), over both transports of PROTOCOL.md at once: USB (hostlink) and Bluetooth LE
// (blelink). Out: the `!s` input-state line, written by a dedicated reporter task so nothing
// else ever waits for a transport; the same line goes out on both. In: `hello`, `hud`, `hap`
// from either transport through one dispatch; `!hello` is answered on the transport the
// `hello` came from. It also owns the microphone peak-hold, because `m` in `!s` is "the
// loudest block since the previous line". Depends on hostlink, blelink, proto, mic, haptic;
// never touches LVGL.
// Threading: received lines arrive on two tasks, the USB reader and the NimBLE host task. The
// dispatch only parses, stores atomics and wakes the reporter, so it is safe from both and
// never makes the NimBLE host task wait; haptics and Bluetooth answers are done by the
// reporter. The count/poll/take functions are lock-free and never block; they are safe on the
// LVGL task. The LVGL task reads what arrived by polling; nothing here calls into the screen.
#include <stdbool.h>
#include <stdint.h>
#include "proto.h"

// Start the microphone, the reporter task and both transports. Returns false if the USB link
// or the reporter could not start (logged); a missing microphone only logs and reports -12000,
// a Bluetooth link that does not start only logs and leaves the knob on USB. Needs
// nvs_flash_init() to have run (the radio's calibration data).
bool app_link_start(void);

// Inputs. Each bumps its absolute counter and wakes the reporter, which sends a `!s` line at
// once. `dir` is +1 for a clockwise detent, -1 for the other way.
void app_link_count_knob(int dir);
void app_link_count_tap(void);
void app_link_count_zone(void);
void app_link_count_hold(void);

// The counters as the next `!s` line will carry them (mic_cdb is not filled in).
void app_link_counts(proto_state_t *out);

// True once per `hud` line that arrived since the last call, with its content in `*hud`
// (only the newest is kept).
bool app_link_poll_hud(proto_hud_t *hud);

// True while a `hud` line arrived within the last 3 s.
bool app_link_alive(void);

// The loudest microphone block since the previous call, centi-dBFS; -12000 when no block
// arrived in between. A separate peak from the one `!s` reports, so the on-screen meter and
// the wire never steal each other's samples.
int app_link_take_mic(void);

// Protocol lines rejected since boot or the last reset (bad field count, range, syntax).
unsigned app_link_bad_lines(void);

// The name this knob advertises over Bluetooth, "Ekko-XXXX", or "" while the radio is still
// starting or if it did not start. Never NULL; the pointer stays valid.
const char *app_link_ble_name(void);

// Console `reset`: counters back to 0 and the last `hud` forgotten. The host sees counters go
// down, which the contract defines as "device rebooted: resynchronise".
void app_link_reset(void);

// Where lines from USB that are not protocol go (the dev console); NULL = ignore them. Lines
// from Bluetooth never get there. The handler runs on the USB reader task; `line` is valid
// only during the call and may be modified.
void app_link_set_console(void (*handle)(char *line));
