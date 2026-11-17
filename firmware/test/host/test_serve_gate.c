// Host unit tests for the on-device HTTP server's admission rules (net/serve_gate.c). Pure C, no
// ESP-IDF. These pin what the knob refuses before it reads a single body byte.
#include "unity.h"
#include "serve_gate.h"

#define MAX_BODY (256u * 1024u)

void setUp(void) {}
void tearDown(void) {}

// ── open endpoint: no token configured ───────────────────────────────────────
void test_open_endpoint_accepts_without_token(void) {
    TEST_ASSERT_EQUAL(SERVE_ACCEPT, serve_gate("", NULL, 100, MAX_BODY));
    TEST_ASSERT_EQUAL(SERVE_ACCEPT, serve_gate(NULL, NULL, 100, MAX_BODY));
}

void test_open_endpoint_ignores_a_given_token(void) {
    TEST_ASSERT_EQUAL(SERVE_ACCEPT, serve_gate("", "anything", 100, MAX_BODY));
}

// ── token configured ─────────────────────────────────────────────────────────
void test_matching_token_accepts(void) {
    TEST_ASSERT_EQUAL(SERVE_ACCEPT, serve_gate("s3cret", "s3cret", 100, MAX_BODY));
}

void test_missing_token_is_unauthorised(void) {
    TEST_ASSERT_EQUAL(SERVE_UNAUTHORISED, serve_gate("s3cret", NULL, 100, MAX_BODY));
}

void test_wrong_token_is_unauthorised(void) {
    TEST_ASSERT_EQUAL(SERVE_UNAUTHORISED, serve_gate("s3cret", "s3cre", 100, MAX_BODY));
    TEST_ASSERT_EQUAL(SERVE_UNAUTHORISED, serve_gate("s3cret", "s3cret!", 100, MAX_BODY));
    TEST_ASSERT_EQUAL(SERVE_UNAUTHORISED, serve_gate("s3cret", "", 100, MAX_BODY));
}

// The token is judged first: a caller without it must not learn the size limit.
void test_unauthorised_wins_over_size(void) {
    TEST_ASSERT_EQUAL(SERVE_UNAUTHORISED, serve_gate("s3cret", NULL, MAX_BODY + 1, MAX_BODY));
    TEST_ASSERT_EQUAL(SERVE_UNAUTHORISED, serve_gate("s3cret", NULL, 0, MAX_BODY));
}

// ── body size ────────────────────────────────────────────────────────────────
void test_empty_body_is_refused(void) {
    TEST_ASSERT_EQUAL(SERVE_EMPTY, serve_gate("", NULL, 0, MAX_BODY));
}

void test_size_boundary(void) {
    TEST_ASSERT_EQUAL(SERVE_ACCEPT,    serve_gate("", NULL, 1, MAX_BODY));
    TEST_ASSERT_EQUAL(SERVE_ACCEPT,    serve_gate("", NULL, MAX_BODY, MAX_BODY));
    TEST_ASSERT_EQUAL(SERVE_TOO_LARGE, serve_gate("", NULL, MAX_BODY + 1, MAX_BODY));
}

void test_zero_ceiling_refuses_everything(void) {
    TEST_ASSERT_EQUAL(SERVE_TOO_LARGE, serve_gate("", NULL, 1, 0));
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_open_endpoint_accepts_without_token);
    RUN_TEST(test_open_endpoint_ignores_a_given_token);
    RUN_TEST(test_matching_token_accepts);
    RUN_TEST(test_missing_token_is_unauthorised);
    RUN_TEST(test_wrong_token_is_unauthorised);
    RUN_TEST(test_unauthorised_wins_over_size);
    RUN_TEST(test_empty_body_is_refused);
    RUN_TEST(test_size_boundary);
    RUN_TEST(test_zero_ceiling_refuses_everything);
    return UNITY_END();
}
