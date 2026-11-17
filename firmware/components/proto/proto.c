// proto.c — the host line parser and the `!s` formatter. Hand-rolled field reader on purpose:
// strtol accepts signs, hex prefixes and leading newlines, and silently saturates on overflow,
// all of which would let a damaged line (bytes do get lost on this link) through as a command.
#include "proto.h"
#include <stdbool.h>
#include <stdio.h>

static bool is_space(char c)
{
    return c == ' ' || c == '\t' || c == '\r';
}

static const char *skip_space(const char *p)
{
    while (is_space(*p)) p++;
    return p;
}

static bool at_end(const char *p)
{
    return *skip_space(p) == '\0';
}

// If the next token is exactly `verb`, return the position after it; otherwise NULL.
static const char *take_verb(const char *p, const char *verb)
{
    p = skip_space(p);
    while (*verb && *p == *verb) { p++; verb++; }
    if (*verb) return NULL;
    return (*p == '\0' || is_space(*p)) ? p : NULL;
}

// Read one decimal field in 0..max and advance *pp past it. False for a missing field, a
// non-digit, or a value above max. `max` is at most 999999, so v * 10 + 9 cannot overflow.
static bool take_uint(const char **pp, uint32_t max, uint32_t *out)
{
    const char *p = skip_space(*pp);
    if (*p < '0' || *p > '9') return false;
    uint32_t v = 0;
    for (; *p >= '0' && *p <= '9'; p++) {
        v = v * 10u + (uint32_t)(*p - '0');
        if (v > max) return false;
    }
    if (*p != '\0' && !is_space(*p)) return false;   // "12x"
    *pp = p;
    *out = v;
    return true;
}

static proto_kind_t parse_hud(const char *p, proto_cmd_t *out)
{
    uint32_t score, health, breath, phase, pol;
    bool ok = take_uint(&p, PROTO_SCORE_MAX, &score) &&
              take_uint(&p, PROTO_PERCENT_MAX, &health) &&
              take_uint(&p, PROTO_PERCENT_MAX, &breath) &&
              take_uint(&p, PROTO_PHASE_MAX, &phase) &&
              take_uint(&p, 1u, &pol) &&
              at_end(p);
    if (!ok) return PROTO_BAD;
    out->hud = (proto_hud_t){ .score = score, .health = (uint8_t)health, .breath = (uint8_t)breath,
                              .phase = (uint8_t)phase, .pol = (uint8_t)pol };
    return PROTO_HUD;
}

static proto_kind_t parse_hap(const char *p, proto_cmd_t *out)
{
    uint32_t effect;
    if (!take_uint(&p, PROTO_EFFECT_MAX, &effect) || effect < PROTO_EFFECT_MIN || !at_end(p))
        return PROTO_BAD;
    out->effect = (uint8_t)effect;
    return PROTO_HAP;
}

proto_kind_t proto_parse(const char *line, proto_cmd_t *out)
{
    const char *rest;
    if ((rest = take_verb(line, "hello")) != NULL) return at_end(rest) ? PROTO_HELLO : PROTO_BAD;
    if ((rest = take_verb(line, "hud")) != NULL)   return parse_hud(rest, out);
    if ((rest = take_verb(line, "hap")) != NULL)   return parse_hap(rest, out);
    return PROTO_UNKNOWN;
}

size_t proto_format_state(char *buf, size_t cap, const proto_state_t *s)
{
    int n = snprintf(buf, cap, "!s %ld %lu %lu %lu %ld\n", (long)s->knob, (unsigned long)s->taps,
                     (unsigned long)s->zone_taps, (unsigned long)s->holds, (long)s->mic_cdb);
    return (n > 0 && (size_t)n < cap) ? (size_t)n : 0;
}
