#pragma once
// blelink_priv — what the two halves of the component share. Nothing outside blelink includes it.
//   blelink.c      the byte pipe: the GATT service, received bytes -> lines, lines -> notifications
//   blelink_gap.c  the link: address and name, advertising, the one connection and its state
// Threading: the blelink_gap_on_* functions and blelink_rx_reset() run on the NimBLE host task
// only. blelink_gap_link() and blelink_gap_name() are lock-free and safe on any task.
#include <stdbool.h>
#include <stdint.h>

// ---- blelink_gap.c ----

// Once, after nimble_port_init() and before the host task runs: sets up the timer that tries
// again when advertising could not be started.
void blelink_gap_init(void);

// NimBLE's sync callback: the host and the controller agree and the address is known. Derives
// the name from it and starts advertising.
void blelink_gap_on_sync(void);

// NimBLE's reset callback: the host lost the controller and will sync again. Logs `reason`.
void blelink_gap_on_reset(int reason);

// True while a central is connected AND has enabled notifications on TX; `*conn` is its
// connection handle then. `*epoch` (always written) changes whenever the link is no longer the
// one it was: connect, disconnect, notifications switched on or off. Handles get reused, the
// epoch does not.
bool blelink_gap_link(uint16_t *conn, unsigned *epoch);

// "Ekko-XXXX", or "" before the first sync. Never NULL.
const char *blelink_gap_name(void);

// ---- blelink.c ----

// The value handle of the TX characteristic (0 before the service is registered): subscribe
// events carry it.
uint16_t blelink_tx_handle(void);

// Forget a half-received line: the central that was sending it is gone.
void blelink_rx_reset(void);
