#pragma once
// blelink — the Bluetooth LE transport of PROTOCOL.md as a line transport, the wireless twin of
// hostlink: a NimBLE peripheral whose Nordic UART Service is a plain byte pipe for lines ending
// in '\n'. Owns the BT controller, the NimBLE host and its task, the GATT service, advertising
// as `Ekko-XXXX` and the one connection (no pairing, no bonding, no encryption).
// Depends on: bt (NimBLE) and hostlink, the latter only for its pure line assembler
// (hostlink_line.h), so both transports cut lines the same way. No NimBLE include or type
// leaves this component. Never includes LVGL, proto or app; what a line means is the caller's
// business. Needs nvs_flash_init() before blelink_init(): the radio keeps its calibration there.
// Threading: the line callback runs on the NimBLE host task, which also runs the whole
// Bluetooth host. It must return at once: no waiting, no I/O, no LVGL lock; hand work to
// another task. blelink_send_line() and blelink_name() may be called from any task.
// blelink_send_line() has no wait of its own and gives up at once when the stack is busy; the
// one wait inside it is NimBLE handing a packet to the controller, normally microseconds and
// capped by NimBLE at 2 s if the controller stops answering. NimBLE runs down to the
// controller on the caller's stack (a 256-byte packet buffer among other things): check the
// caller's stack low-water mark. Never call it on the LVGL task.
// Pointers: the callback's `line` is valid only during the call and may be modified; copy
// what you keep. blelink_send_line() copies what it takes. blelink_name() points at storage
// that lives for ever.
#include <stdbool.h>
#include <stddef.h>

// One received line, NUL-terminated, without its '\n'. It may be empty: the host is allowed to
// send a lone '\n', and the contract wants such a line ignored (the app's parser classes it as
// "not protocol", which over Bluetooth means: nothing happens). A line that was only partly
// received when the central disconnected is never delivered.
typedef void (*blelink_line_cb_t)(char *line);

// Bring up the controller and the NimBLE host, register the service and start the host task;
// advertising begins by itself as soon as the host has its address, and again after every
// disconnect. Returns false with the reason logged if any of that failed; then nothing is
// received, blelink_send_line() returns false and blelink_name() stays "".
bool blelink_init(blelink_line_cb_t on_line);

// Send one complete line (`len` bytes, its '\n' included, at most 64) to the central: in one
// notification when it fits the negotiated MTU, otherwise in pieces. Returns true when the
// stack took it. Returns false, and the line is dropped, when no central has enabled
// notifications, when the stack's buffers are filling up (the central is not taking data),
// when the stack refuses its first piece, or when another task is in this function right now.
// Nothing is queued here for later, with one exception: the rest of a line whose first piece
// already went out is sent by the next call before anything else, so that the central never
// sees half a line.
bool blelink_send_line(const char *line, size_t len);

// The advertised name, "Ekko-XXXX" with XXXX from the BLE address (the same on every boot), or
// "" until the host has started and read that address, a few tens of milliseconds after
// blelink_init(). Never NULL.
const char *blelink_name(void);
