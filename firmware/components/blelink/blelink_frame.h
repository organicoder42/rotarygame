#pragma once
// blelink_frame — every decision the Bluetooth LE transport makes, with no radio in it (private
// to the blelink component): the UUIDs of PROTOCOL.md as bytes, the `Ekko-XXXX` name, how a
// line is cut into notifications for an ATT MTU, and when the stack's buffer pool is too full
// to accept another line. Pure C: no ESP-IDF, FreeRTOS or NimBLE includes, no globals, no
// allocation; host-tested in test/host/test_blelink_frame.c.
// Threading: stateless functions plus one blelink_tx_t per link, used by one task at a time.
// Pointers: nothing passed in is kept; blelink_tx_peek() returns a pointer into the state.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// The Nordic UART Service of PROTOCOL.md, least significant byte first: the order the bytes
// have on the air and in NimBLE's BLE_UUID128_INIT. Read backwards they are the text form,
// 6e40000N-b5a3-f393-e0a9-e50e24dcca9e (the test checks exactly that).
#define BLELINK_UUID_LE(n) \
    0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0, 0x93, 0xf3, 0xa3, 0xb5, (n), 0x00, 0x40, 0x6e
#define BLELINK_UUID_SERVICE_LE   BLELINK_UUID_LE(0x01)
#define BLELINK_UUID_RX_LE        BLELINK_UUID_LE(0x02)   // host -> device: write, write without response
#define BLELINK_UUID_TX_LE        BLELINK_UUID_LE(0x03)   // device -> host: notify

// What the device asks the central for (PROTOCOL.md): 7.5-15 ms interval, latency 0, 2 s
// supervision timeout, in the units of the Bluetooth specification.
#define BLELINK_CONN_ITVL_MIN     6      // x 1.25 ms
#define BLELINK_CONN_ITVL_MAX     12     // x 1.25 ms
#define BLELINK_CONN_LATENCY      0
#define BLELINK_CONN_TIMEOUT      200    // x 10 ms

#define BLELINK_NAME_MAX          10     // "Ekko-XXXX" with its NUL
#define BLELINK_LINE_MAX          64     // longest line sent, with its '\n' (the longest `!s` is 63)
#define BLELINK_ATT_MTU_MIN       23     // the default ATT MTU; nothing lower exists
#define BLELINK_ATT_NOTIFY_HDR    3      // opcode + attribute handle in front of every notification

// Write "Ekko-XXXX" into `buf`: XXXX is the last two bytes of the BLE address as it is written
// (AA:BB:CC:DD:EE:FF -> EEFF), upper-case hex. `addr_le` is the address least significant byte
// first, as NimBLE's ble_hs_id_copy_addr() delivers it, so those are addr_le[1] and addr_le[0].
// Returns false and leaves `buf` empty if `cap` is below BLELINK_NAME_MAX.
bool blelink_name_format(char *buf, size_t cap, const uint8_t addr_le[6]);

// Bytes of line text one notification can carry at `att_mtu`. An MTU below the default 23
// (0 = "not known") counts as 23, so the result is never below 20.
size_t blelink_payload_max(uint16_t att_mtu);

// One line on its way out. Zero-initialised = idle. A line that was started is always
// finished before the next one is accepted: a stream that lost the middle of a line would glue
// the head of one `!s` to the tail of another, and that can still parse as a valid line.
typedef struct {
    char   buf[BLELINK_LINE_MAX];
    size_t len;     // bytes of the line in buf; 0 = idle
    size_t off;     // bytes already handed to the stack
} blelink_tx_t;

// True when no line is waiting to be finished.
bool blelink_tx_idle(const blelink_tx_t *tx);

// Take a copy of `line` (`len` bytes, '\n' included) as the line to send. Returns false and
// changes nothing if the previous line is not finished, `len` is 0, or it exceeds
// BLELINK_LINE_MAX.
bool blelink_tx_load(blelink_tx_t *tx, const char *line, size_t len);

// The next notification: `*chunk` points at its bytes and the return value is their count,
// the whole rest of the line when it fits `att_mtu`, otherwise as much as fits. 0 = nothing
// left to send (`*chunk` is not written then).
size_t blelink_tx_peek(const blelink_tx_t *tx, uint16_t att_mtu, const char **chunk);

// The stack took `n` bytes of the chunk from blelink_tx_peek(). The state is idle again once
// the whole line went out.
void blelink_tx_sent(blelink_tx_t *tx, size_t n);

// Forget the line: the link it was meant for is gone.
void blelink_tx_clear(blelink_tx_t *tx);

// The stack refused the very first piece of the loaded line: forget the line and return true.
// "A line the stack cannot take right now is dropped, never queued" (PROTOCOL.md); only a line
// of which something already went out is kept, to be finished. False, and no change, when the
// state is idle or the line has been started.
bool blelink_tx_drop_unstarted(blelink_tx_t *tx);

// "Can the stack take a new line right now?" in terms of NimBLE's buffer pools. NimBLE has a
// pool of small blocks and one of large blocks, reports only the free count of both together
// (`free_blocks`), and builds every notification from the SMALL pool alone, without falling
// back to the large one. So the small pool is what fills up when the central stops taking
// data. Its free count is at least `free_blocks - large_blocks` (exactly that while no large
// block is in use); the answer is true while that is at least half of `small_blocks`. The
// other half stays for the stack's own traffic (responses, signalling).
bool blelink_pool_has_room(int free_blocks, int small_blocks, int large_blocks);
