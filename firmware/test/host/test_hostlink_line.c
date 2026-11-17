// Host tests for hostlink_line.c: bytes from the host -> whole lines, damaged lines dropped whole.
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
    return UNITY_END();
}
