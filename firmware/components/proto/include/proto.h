#pragma once
// proto — the Ekko wire contract (knob-game/PROTOCOL.md) as code: parses the lines the browser
// sends (`hello`, `hud ...`, `hap ...`) and formats the `!s` input-state line the knob sends.
// Pure C: no ESP-IDF, FreeRTOS or LVGL includes, no globals, no allocation; host-tested in
// test/host/test_proto.c. Change PROTOCOL.md first, then this file, then the web side.
// Threading: every function works only on its arguments, so any task may call it.
// Pointers: `line` is read during the call and never kept; `out` is written only on a match.
#include <stddef.h>
#include <stdint.h>

#define PROTO_VERSION         1
#define PROTO_HELLO_REPLY     "!hello ekko 1\n"     // answer to `hello`

// Limits from the contract. A field outside its range makes the whole line PROTO_BAD.
#define PROTO_SCORE_MAX       999999u
#define PROTO_PERCENT_MAX     100u
#define PROTO_PHASE_MAX       3u
#define PROTO_EFFECT_MIN      1u
#define PROTO_EFFECT_MAX      123u

typedef enum {
    PROTO_PHASE_READY = 0,
    PROTO_PHASE_PLAYING,
    PROTO_PHASE_PAUSED,
    PROTO_PHASE_OVER,
} proto_phase_t;

// What the knob's own display shows: the payload of one `hud` line.
typedef struct {
    uint32_t score;     // 0..PROTO_SCORE_MAX
    uint8_t  health;    // 0..100
    uint8_t  breath;    // 0..100
    uint8_t  phase;     // proto_phase_t
    uint8_t  pol;       // 0 = outline, 1 = filled
} proto_hud_t;

typedef enum {
    PROTO_UNKNOWN = 0,  // not a protocol verb (empty line, console command, noise): not ours
    PROTO_BAD,          // a protocol verb with missing, extra, malformed or out-of-range fields
    PROTO_HELLO,
    PROTO_HUD,          // out->hud is valid
    PROTO_HAP,          // out->effect is valid
} proto_kind_t;

typedef struct {
    proto_hud_t hud;
    uint8_t     effect; // DRV2605L library waveform, PROTO_EFFECT_MIN..PROTO_EFFECT_MAX
} proto_cmd_t;

// Classify one host line (NUL-terminated, without its '\n'). Spaces, tabs and '\r' around and
// between fields are tolerated; numbers are plain decimal digits (no sign, no hex). Returns the
// kind and fills `out` for PROTO_HUD / PROTO_HAP; `out` is untouched for every other result.
proto_kind_t proto_parse(const char *line, proto_cmd_t *out);

// The device -> host input state: absolute counters, never deltas.
typedef struct {
    int32_t  knob;       // detents since boot, clockwise positive
    uint32_t taps;       // short taps on the screen
    uint32_t zone_taps;  // short taps on the small circle
    uint32_t holds;      // long presses
    int32_t  mic_cdb;    // loudest block since the previous line, centi-dBFS
} proto_state_t;

// Longest possible `!s` line with its '\n' and NUL: "!s " + five 32-bit numbers + separators.
#define PROTO_STATE_LINE_MAX  64

// Write "!s <k> <t> <z> <h> <m>\n" into `buf`. Returns the length without the NUL, or 0 when
// `cap` is too small (nothing useful is in `buf` then; never a cut line).
size_t proto_format_state(char *buf, size_t cap, const proto_state_t *s);
