#include "hostlink_line.h"

void hostlink_line_reset(hostlink_line_t *lb)
{
    lb->len = 0;
    lb->discard = false;
}

char *hostlink_line_push(hostlink_line_t *lb, char c)
{
    if (c == '\n') {
        bool intact = !lb->discard;
        lb->buf[lb->len] = '\0';
        lb->len = 0;
        lb->discard = false;
        return intact ? lb->buf : NULL;
    }
    if (c == '\0' || lb->len >= HOSTLINK_LINE_MAX - 1) {
        lb->discard = true;
        return NULL;
    }
    lb->buf[lb->len++] = c;
    return NULL;
}
