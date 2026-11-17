#pragma once
// hostlink — the USB Serial/JTAG port as a line transport. Owns the port's driver and the ONE
// task that reads it; nothing else in the firmware may read the port. Output is whole lines:
// a line is queued completely or not at all, so a line can never reach the host cut in half
// or with another task's text inside it. ESP_LOGx output is routed through the same path.
// Depends on: esp_driver_usb_serial_jtag. Never includes LVGL, proto or app; what a line means
// is the caller's business.
// Threading: hostlink_write/printf may be called from any task, but they can wait up to
// 2 x timeout_ms when the host is not reading, so never from the LVGL task or with the LVGL
// lock held unless the timeout is 0. The line callback runs on the reader task.
// Pointers: the callback's `line` is valid only during the call and may be modified; copy
// what you keep.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// One received line, NUL-terminated, without its '\n'; may be empty.
typedef void (*hostlink_line_cb_t)(char *line);

// Install the driver, route the log through hostlink_write and start the reader task. Returns
// false with the reason logged if any of that failed; then nothing is received and every write
// returns false.
bool hostlink_init(hostlink_line_cb_t on_line);

// Queue `len` bytes (one or more complete lines, '\n' included) as one unit. Returns false if
// they could not be queued within the timeout (host not reading, or before hostlink_init);
// nothing is sent then. `len` must be below the 4096-byte transmit buffer.
bool hostlink_write(const void *data, size_t len, uint32_t timeout_ms);

// The same, but only if the host has already picked up everything queued before; it waits at
// most `timeout_ms` for that and otherwise sends nothing and returns false. For state that is
// only worth sending fresh (the `!s` line): without this, up to 4 KB of old lines pile up while
// no program has the port open and are delivered first, minutes later, when one opens it. At
// most one such line can be left waiting in the USB endpoint.
bool hostlink_write_fresh(const void *data, size_t len, uint32_t timeout_ms);

// printf into one line of at most 127 characters and queue it with hostlink_write. Returns
// false, and sends nothing, if the text did not fit or could not be queued.
bool hostlink_printf(uint32_t timeout_ms, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
