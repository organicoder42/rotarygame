// Host tests for proto.c: the Ekko wire contract (knob-game/PROTOCOL.md). The parser sits on a
// link that loses bytes, so most of these are about what must NOT be accepted.
#include "unity.h"
#include "proto.h"
#include <string.h>

void setUp(void) {}
void tearDown(void) {}

static proto_cmd_t cmd;

static proto_kind_t parse(const char *line)
{
    memset(&cmd, 0xEE, sizeof(cmd));    // any field the parser leaves alone stays recognisable
    return proto_parse(line, &cmd);
}

// ---- hello ----

void test_hello(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_HELLO, parse("hello"));
}

void test_hello_tolerates_cr_and_spaces(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_HELLO, parse("hello\r"));
    TEST_ASSERT_EQUAL_INT(PROTO_HELLO, parse("  hello  \r"));
    TEST_ASSERT_EQUAL_INT(PROTO_HELLO, parse("\thello\t"));
}

void test_hello_with_arguments_is_bad(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hello 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hello ekko"));
}

// ---- hud ----

void test_hud_contract_example(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_HUD, parse("hud 1250 80 35 1 1"));
    TEST_ASSERT_EQUAL_UINT32(1250, cmd.hud.score);
    TEST_ASSERT_EQUAL_UINT8(80, cmd.hud.health);
    TEST_ASSERT_EQUAL_UINT8(35, cmd.hud.breath);
    TEST_ASSERT_EQUAL_UINT8(PROTO_PHASE_PLAYING, cmd.hud.phase);
    TEST_ASSERT_EQUAL_UINT8(1, cmd.hud.pol);
}

void test_hud_range_ends_are_accepted(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_HUD, parse("hud 0 0 0 0 0"));
    TEST_ASSERT_EQUAL_UINT32(0, cmd.hud.score);
    TEST_ASSERT_EQUAL_INT(PROTO_HUD, parse("hud 999999 100 100 3 1"));
    TEST_ASSERT_EQUAL_UINT32(999999, cmd.hud.score);
    TEST_ASSERT_EQUAL_UINT8(100, cmd.hud.health);
    TEST_ASSERT_EQUAL_UINT8(100, cmd.hud.breath);
    TEST_ASSERT_EQUAL_UINT8(PROTO_PHASE_OVER, cmd.hud.phase);
}

void test_hud_extra_whitespace_and_crlf(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_HUD, parse("  hud   1250  80\t35 1   1  \r"));
    TEST_ASSERT_EQUAL_UINT32(1250, cmd.hud.score);
    TEST_ASSERT_EQUAL_UINT8(1, cmd.hud.pol);
    TEST_ASSERT_EQUAL_INT(PROTO_HUD, parse("hud 7 100 0 0 0\r"));
    TEST_ASSERT_EQUAL_UINT32(7, cmd.hud.score);
}

void test_hud_leading_zeros_are_decimal(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_HUD, parse("hud 0010 080 009 01 01"));
    TEST_ASSERT_EQUAL_UINT32(10, cmd.hud.score);
    TEST_ASSERT_EQUAL_UINT8(80, cmd.hud.health);
    TEST_ASSERT_EQUAL_UINT8(9, cmd.hud.breath);
}

void test_hud_each_field_out_of_range_is_bad(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1000000 80 35 1 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1250 101 35 1 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1250 80 101 1 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1250 80 35 4 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1250 80 35 1 2"));
}

void test_hud_huge_number_does_not_wrap_into_range(void)
{
    // 4294967297 is 1 modulo 2^32: a parser that overflows would accept it as score 1.
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 4294967297 80 35 1 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 99999999999999999999 80 35 1 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1 256 35 1 1"));      // 256 is 0 in a uint8
}

void test_hud_wrong_field_count_is_bad(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1250 80 35 1"));      // a lost tail
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1250 80 35 1 1 0"));
}

void test_hud_non_numbers_are_bad(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud -1 80 35 1 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud +1 80 35 1 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 0x10 80 35 1 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 12a 80 35 1 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1.5 80 35 1 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud abc 80 35 1 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1250,80,35,1,1"));
}

void test_hud_two_lines_glued_by_a_lost_newline_are_bad(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1250 80 35 1 1hud 1260 80 35 1 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1250 80 35 1 1 hap 14"));
}

void test_bad_line_leaves_out_untouched(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1250 80 35 1 9"));
    TEST_ASSERT_EQUAL_HEX8(0xEE, cmd.hud.health);
    TEST_ASSERT_EQUAL_HEX8(0xEE, cmd.effect);
}

// ---- hap ----

void test_hap_range(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_HAP, parse("hap 1"));
    TEST_ASSERT_EQUAL_UINT8(1, cmd.effect);
    TEST_ASSERT_EQUAL_INT(PROTO_HAP, parse("hap 123\r"));
    TEST_ASSERT_EQUAL_UINT8(123, cmd.effect);
    TEST_ASSERT_EQUAL_INT(PROTO_HAP, parse(" hap  47 "));
    TEST_ASSERT_EQUAL_UINT8(47, cmd.effect);
}

void test_hap_out_of_range_or_malformed_is_bad(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hap 0"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hap 124"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hap 379"));               // 123 modulo 256
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hap"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hap -1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hap 1 2"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hap click"));
}

// ---- not ours ----

void test_console_commands_and_noise_are_unknown(void)
{
    static const char *const LINES[] = {
        "", " ", "\r", "ping", "state", "snap", "knob +3", "tap", "zone", "hold", "reset",
        "hudx 1 2 3 4 5", "hu", "ha", "hell", "helloo", "hapt 1", "HUD 1 2 3 4 5", "Hello",
        "!s 1 2 3 4 -7500", "!hello ekko 1", "I (123) app: ready",
    };
    for (size_t i = 0; i < sizeof(LINES) / sizeof(LINES[0]); i++)
        TEST_ASSERT_EQUAL_INT_MESSAGE(PROTO_UNKNOWN, parse(LINES[i]), LINES[i]);
}

// PROTOCOL.md, Bluetooth LE: "the device ignores an empty line" (the host may send a lone '\n').
// An empty line is not a command and not a damaged command either: it must not count as bad,
// and `out` stays untouched. With "\r\n" the assembler leaves the '\r' in; same answer.
void test_an_empty_line_is_nothing_at_all(void)
{
    static const char *const EMPTY[] = { "", "\r", " ", "\t", " \r" };
    for (size_t i = 0; i < sizeof(EMPTY) / sizeof(EMPTY[0]); i++) {
        TEST_ASSERT_EQUAL_INT(PROTO_UNKNOWN, parse(EMPTY[i]));
        TEST_ASSERT_EQUAL_HEX8(0xEE, cmd.effect);
        TEST_ASSERT_EQUAL_HEX8(0xEE, cmd.hud.phase);
    }
}

// What a lone '\n' turns a half-sent command into. A fragment that lacks fields is rejected;
// nothing of it is applied.
void test_a_closed_fragment_of_a_hud_line_is_rejected(void)
{
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1250 8"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud 1250 80 35 1"));
    TEST_ASSERT_EQUAL_INT(PROTO_BAD, parse("hud"));
    TEST_ASSERT_EQUAL_INT(PROTO_UNKNOWN, parse("hu"));
}

// ---- !s ----

void test_state_line_contract_example(void)
{
    char buf[PROTO_STATE_LINE_MAX];
    proto_state_t s = { .knob = -3, .taps = 2, .zone_taps = 0, .holds = 1, .mic_cdb = -6840 };
    size_t n = proto_format_state(buf, sizeof(buf), &s);
    TEST_ASSERT_EQUAL_STRING("!s -3 2 0 1 -6840\n", buf);
    TEST_ASSERT_EQUAL_size_t(strlen(buf), n);
}

void test_state_line_extremes_fit_the_buffer(void)
{
    char buf[PROTO_STATE_LINE_MAX];
    proto_state_t s = { .knob = INT32_MIN, .taps = UINT32_MAX, .zone_taps = UINT32_MAX,
                        .holds = UINT32_MAX, .mic_cdb = INT32_MIN };
    size_t n = proto_format_state(buf, sizeof(buf), &s);
    TEST_ASSERT_EQUAL_STRING("!s -2147483648 4294967295 4294967295 4294967295 -2147483648\n", buf);
    TEST_ASSERT_EQUAL_size_t(strlen(buf), n);
}

void test_state_line_too_small_buffer_is_refused_not_cut(void)
{
    char buf[12];
    proto_state_t s = { .knob = 1000, .taps = 1000, .zone_taps = 1000, .holds = 1000, .mic_cdb = -7500 };
    TEST_ASSERT_EQUAL_size_t(0, proto_format_state(buf, sizeof(buf), &s));
    char exact[sizeof("!s 1 2 3 4 -5\n")];
    proto_state_t t = { .knob = 1, .taps = 2, .zone_taps = 3, .holds = 4, .mic_cdb = -5 };
    TEST_ASSERT_EQUAL_size_t(sizeof(exact) - 1, proto_format_state(exact, sizeof(exact), &t));
    TEST_ASSERT_EQUAL_size_t(0, proto_format_state(exact, sizeof(exact) - 1, &t));
}

void test_hello_reply_is_the_contract_line(void)
{
    TEST_ASSERT_EQUAL_STRING("!hello ekko 1\n", PROTO_HELLO_REPLY);
    TEST_ASSERT_EQUAL_INT(1, PROTO_VERSION);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_hello);
    RUN_TEST(test_hello_tolerates_cr_and_spaces);
    RUN_TEST(test_hello_with_arguments_is_bad);
    RUN_TEST(test_hud_contract_example);
    RUN_TEST(test_hud_range_ends_are_accepted);
    RUN_TEST(test_hud_extra_whitespace_and_crlf);
    RUN_TEST(test_hud_leading_zeros_are_decimal);
    RUN_TEST(test_hud_each_field_out_of_range_is_bad);
    RUN_TEST(test_hud_huge_number_does_not_wrap_into_range);
    RUN_TEST(test_hud_wrong_field_count_is_bad);
    RUN_TEST(test_hud_non_numbers_are_bad);
    RUN_TEST(test_hud_two_lines_glued_by_a_lost_newline_are_bad);
    RUN_TEST(test_bad_line_leaves_out_untouched);
    RUN_TEST(test_hap_range);
    RUN_TEST(test_hap_out_of_range_or_malformed_is_bad);
    RUN_TEST(test_console_commands_and_noise_are_unknown);
    RUN_TEST(test_an_empty_line_is_nothing_at_all);
    RUN_TEST(test_a_closed_fragment_of_a_hud_line_is_rejected);
    RUN_TEST(test_state_line_contract_example);
    RUN_TEST(test_state_line_extremes_fit_the_buffer);
    RUN_TEST(test_state_line_too_small_buffer_is_refused_not_cut);
    RUN_TEST(test_hello_reply_is_the_contract_line);
    return UNITY_END();
}
