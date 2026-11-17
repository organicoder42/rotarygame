#pragma once
// serve_gate — the decision "may this request body come in?" as pure C (no ESP-IDF includes), so
// it runs under gcc + Unity on the host (test/host/test_serve_gate.c). net_serve.c asks it before
// reading a single body byte; a refused request costs the knob nothing but the headers.
#include <stddef.h>

typedef enum {
    SERVE_ACCEPT = 0,
    SERVE_UNAUTHORISED,   // a token is configured and the caller's is missing or wrong  -> 401
    SERVE_EMPTY,          // no body declared                                            -> 400
    SERVE_TOO_LARGE,      // declared body is larger than the limit                      -> 413
} serve_verdict_t;

// `expected_token`: NULL or "" means the endpoint is open. `given_token`: the caller's header
// value, NULL when absent. `content_len` is what the caller declared; `max_body` is the ceiling.
// The token is checked first so an unauthorised caller learns nothing about the limits.
serve_verdict_t serve_gate(const char *expected_token, const char *given_token,
                           size_t content_len, size_t max_body);
