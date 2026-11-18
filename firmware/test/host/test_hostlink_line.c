// Host tests for hostlink_line.c: bytes from the host -> whole lines, damaged lines dropped whole.
// One assembler, two transports: USB reads and Bluetooth LE writes both end up here.
#include "unity.h"
#include "hostlink_line.h"
#include <string.h>

void setUp(void) {}
void tearDown(void) {}

// Push `text` and return the last line that came out (NULL if none), counting them in *lines.
static char *feed(hostlink_line_t *lb, const char *text, size_t n, int *lines)
{
    char *last = NULL;
    for (size_t i = 0; i < n; i++) {
        char *line = hostlink_line_push(lb, text[i]);
        if (line) { last = line; if (lines) (*lines)++; }
    }
    return last;
}

void test_one_line(void)
{
    hostlink_line_t lb = {0};
    int lines = 0;
    char *line = feed(&lb, "hello\n", 6, &lines);
    TEST_ASSERT_EQUAL_INT(1, lines);
    TEST_ASSERT_EQUAL_STRING("hello", line);
}

void test_nothing_until_the_newline(void)
{
    hostlink_line_t lb = {0};
    TEST_ASSERT_NULL(feed(&lb, "hud 1250 80 35 1 1", 18, NULL));
    TEST_ASSERT_EQUAL_STRING("hud 1250 80 35 1 1", hostlink_line_push(&lb, '\n'));
}

void test_crlf_keeps_the_cr_for_the_parser(void)
{
    hostlink_line_t lb = {0};
    TEST_ASSERT_EQUAL_STRING("hap 14\r", feed(&lb, "hap 14\r\n", 8, NULL));
}

void test_two_lines_in_one_chunk(void)
{
    hostlink_line_t lb = {0};
    int lines = 0;
    char *last = feed(&lb, "hap 1\nhap 2\n", 12, &lines);
    TEST_ASSERT_EQUAL_INT(2, lines);
    TEST_ASSERT_EQUAL_STRING("hap 2", last);
}

void test_empty_line_comes_out_empty(void)
{
    hostlink_line_t lb = {0};
    char *line = hostlink_line_push(&lb, '\n');
    TEST_ASSERT_NOT_NULL(line);
    TEST_ASSERT_EQUAL_STRING("", line);
}

void test_longest_line_that_fits(void)
{
    hostlink_line_t lb = {0};
    char text[HOSTLINK_LINE_MAX];
    memset(text, 'a', sizeof(text) - 1);
    text[sizeof(text) - 1] = '\n';
    char *line = feed(&lb, text, sizeof(text), NULL);
    TEST_ASSERT_NOT_NULL(line);
    TEST_ASSERT_EQUAL_size_t(HOSTLINK_LINE_MAX - 1, strlen(line));
}

void test_overlong_line_is_dropped_whole_and_its_tail_is_not_a_command(void)
{
    hostlink_line_t lb = {0};
    char text[HOSTLINK_LINE_MAX + 20];
    memset(text, 'x', sizeof(text));
    memcpy(text + sizeof(text) - 6, "reset\n", 6);     // the tail spells a console command
    int lines = 0;
    TEST_ASSERT_NULL(feed(&lb, text, sizeof(text), &lines));
    TEST_ASSERT_EQUAL_INT(0, lines);
    TEST_ASSERT_EQUAL_STRING("ping", feed(&lb, "ping\n", 5, &lines));   // and the next line is fine
    TEST_ASSERT_EQUAL_INT(1, lines);
}

void test_line_with_a_nul_byte_is_dropped(void)
{
    hostlink_line_t lb = {0};
    int lines = 0;
    TEST_ASSERT_NULL(feed(&lb, "tap\0junk\n", 9, &lines));
    TEST_ASSERT_EQUAL_INT(0, lines);
    TEST_ASSERT_EQUAL_STRING("tap", feed(&lb, "tap\n", 4, &lines));
}

// ---- Bluetooth LE: a GATT write is not a message (blelink.c pushes every written byte) ----

static int  s_lines;
static char s_last[HOSTLINK_LINE_MAX];

static void write_bytes(hostlink_line_t *lb, const char *bytes)
{
    for (; *bytes; bytes++) {
        char *line = hostlink_line_push(lb, *bytes);
        if (line) { s_lines++; strcpy(s_last, line); }
    }
}

void test_a_command_sent_in_20_byte_writes_is_one_line(void)
{
    hostlink_line_t lb = {0};
    s_lines = 0;
    write_bytes(&lb, "hud 999999 100 100 3");       // the host's first 20 bytes
    TEST_ASSERT_EQUAL_INT(0, s_lines);
    write_bytes(&lb, " 1\n");
    TEST_ASSERT_EQUAL_INT(1, s_lines);
    TEST_ASSERT_EQUAL_STRING("hud 999999 100 100 3 1", s_last);
}

void test_one_write_may_hold_several_lines_and_the_start_of_the_next(void)
{
    hostlink_line_t lb = {0};
    s_lines = 0;
    write_bytes(&lb, "hello\nhap 14\nhud 12");
    TEST_ASSERT_EQUAL_INT(2, s_lines);
    TEST_ASSERT_EQUAL_STRING("hap 14", s_last);
    write_bytes(&lb, "50 80 35 1 1\r\n");
    TEST_ASSERT_EQUAL_INT(3, s_lines);
    TEST_ASSERT_EQUAL_STRING("hud 1250 80 35 1 1\r", s_last);       // the parser treats '\r' as space
}

// Writes without response, two or three per connection interval, each at most 20 bytes: the
// bytes simply follow each other. Every line comes out, in order, none lost or merged.
void test_back_to_back_writes_lose_nothing(void)
{
    static const char *const WRITES[] = {
        "hello\nhud 1250 80 35", " 1 1\nhap 14\nhud 9999", "99 100 100 3 1\n",     // 20, 20, 15 bytes
    };
    static const char *const WANT[] = { "hello", "hud 1250 80 35 1 1", "hap 14", "hud 999999 100 100 3 1" };
    hostlink_line_t lb = {0};
    int got = 0;
    for (size_t w = 0; w < sizeof(WRITES) / sizeof(WRITES[0]); w++) {
        TEST_ASSERT_TRUE(strlen(WRITES[w]) <= 20);
        for (const char *p = WRITES[w]; *p; p++) {
            char *line = hostlink_line_push(&lb, *p);
            if (!line) continue;
            TEST_ASSERT_TRUE(got < 4);
            TEST_ASSERT_EQUAL_STRING(WANT[got], line);
            got++;
        }
    }
    TEST_ASSERT_EQUAL_INT(4, got);
}

// PROTOCOL.md: the host may send a lone '\n' to close a fragment after a failed write. The
// fragment comes out as a line of its own (the parser rejects or ignores it, test_proto.c), the
// command after it is intact, and a '\n' with nothing before it is an empty line.
void test_a_lone_newline_closes_a_fragment_and_spares_the_next_command(void)
{
    hostlink_line_t lb = {0};
    s_lines = 0;
    write_bytes(&lb, "hud 1250 8");                 // the write with the rest failed
    write_bytes(&lb, "\n");
    TEST_ASSERT_EQUAL_INT(1, s_lines);
    TEST_ASSERT_EQUAL_STRING("hud 1250 8", s_last);
    write_bytes(&lb, "\n");                         // nothing was pending this time
    TEST_ASSERT_EQUAL_INT(2, s_lines);
    TEST_ASSERT_EQUAL_STRING("", s_last);
    write_bytes(&lb, "hello\n");
    TEST_ASSERT_EQUAL_INT(3, s_lines);
    TEST_ASSERT_EQUAL_STRING("hello", s_last);
}

// hostlink_line_reset() is what blelink does when a central connects or disconnects: the half
// line of the central that left must not become the head of the next one's first command.
void test_a_half_line_does_not_survive_a_new_connection(void)
{
    hostlink_line_t lb = {0};
    s_lines = 0;
    write_bytes(&lb, "hap 1");
    hostlink_line_reset(&lb);
    write_bytes(&lb, "hello\n");
    TEST_ASSERT_EQUAL_INT(1, s_lines);
    TEST_ASSERT_EQUAL_STRING("hello", s_last);      // not "hap 1hello"
}

// The central left in the middle of an overlong line: "skip to the next newline" must not
// carry over either, or it would swallow the next connection's `hello`.
void test_a_damaged_half_line_does_not_swallow_the_next_connections_first_line(void)
{
    hostlink_line_t lb = {0};
    char junk[HOSTLINK_LINE_MAX + 10];
    memset(junk, 'x', sizeof(junk) - 1);
    junk[sizeof(junk) - 1] = '\0';
    s_lines = 0;
    write_bytes(&lb, junk);                         // overflowed: the assembler is discarding
    TEST_ASSERT_EQUAL_INT(0, s_lines);
    hostlink_line_reset(&lb);
    write_bytes(&lb, "hello\n");
    TEST_ASSERT_EQUAL_INT(1, s_lines);
    TEST_ASSERT_EQUAL_STRING("hello", s_last);
}

void test_reset_of_an_empty_state_changes_nothing(void)
{
    hostlink_line_t lb = {0};
    hostlink_line_reset(&lb);
    TEST_ASSERT_EQUAL_STRING("ping", feed(&lb, "ping\n", 5, NULL));
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_one_line);
    RUN_TEST(test_nothing_until_the_newline);
    RUN_TEST(test_crlf_keeps_the_cr_for_the_parser);
    RUN_TEST(test_two_lines_in_one_chunk);
    RUN_TEST(test_empty_line_comes_out_empty);
    RUN_TEST(test_longest_line_that_fits);
    RUN_TEST(test_overlong_line_is_dropped_whole_and_its_tail_is_not_a_command);
    RUN_TEST(test_line_with_a_nul_byte_is_dropped);
    RUN_TEST(test_a_command_sent_in_20_byte_writes_is_one_line);
    RUN_TEST(test_one_write_may_hold_several_lines_and_the_start_of_the_next);
    RUN_TEST(test_back_to_back_writes_lose_nothing);
    RUN_TEST(test_a_lone_newline_closes_a_fragment_and_spares_the_next_command);
    RUN_TEST(test_a_half_line_does_not_survive_a_new_connection);
    RUN_TEST(test_a_damaged_half_line_does_not_swallow_the_next_connections_first_line);
    RUN_TEST(test_reset_of_an_empty_state_changes_nothing);
    return UNITY_END();
}
