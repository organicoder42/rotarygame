#pragma once
// hostlink_line — assembles the byte stream from the host into lines. Pure C: no ESP-IDF,
// FreeRTOS or LVGL includes; host-tested in test/host/test_hostlink_line.c.
// A line that does not fit, or that contains a NUL byte, is dropped WHOLE: its tail is never
// handed out as if it were a line of its own (bytes get lost on this link, and the tail of a
// damaged line can spell a command).
// Threading: one state per stream, used by one task. Zero-initialised = empty.
#include <stdbool.h>
#include <stddef.h>

#define HOSTLINK_LINE_MAX 64   // longest line with its NUL; the longest contract line is 22

typedef struct {
    char   buf[HOSTLINK_LINE_MAX];
    size_t len;
    bool   discard;    // the current line overflowed or carried a NUL: skip to the next '\n'
} hostlink_line_t;

// Feed one received byte. Returns the finished line when `c` is '\n' and the line is intact:
// NUL-terminated, without the '\n' (a trailing '\r' is left in; the parser treats it as
// space), possibly empty. Returns NULL otherwise. The pointer is into `lb` and stays valid
// until the next push; the caller may modify the text.
char *hostlink_line_push(hostlink_line_t *lb, char c);
