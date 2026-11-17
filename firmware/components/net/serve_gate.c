// serve_gate.c — pure admission rules for the on-device HTTP server. See serve_gate.h.
#include "serve_gate.h"
#include <string.h>

static int token_ok(const char *expected, const char *given)
{
    if (!expected || expected[0] == '\0') return 1;   // open endpoint
    return given && strcmp(expected, given) == 0;
}

serve_verdict_t serve_gate(const char *expected_token, const char *given_token,
                           size_t content_len, size_t max_body)
{
    if (!token_ok(expected_token, given_token)) return SERVE_UNAUTHORISED;
    if (content_len == 0)                       return SERVE_EMPTY;
    if (content_len > max_body)                 return SERVE_TOO_LARGE;
    return SERVE_ACCEPT;
}
