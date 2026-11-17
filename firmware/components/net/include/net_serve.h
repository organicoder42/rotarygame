#pragma once
// net_serve — a small HTTP server so a laptop or another device on the same Wi-Fi can call the
// knob. Depends on: esp_http_server, serve_gate (pure rules), wifi_secrets.h (optional token).
// Two routes:
//   GET  /status  -> {"rssi":-60,"free_internal":180000,"uptime_s":42}
//   POST /data    -> the body is handed to your sink in pieces; answers "ok" when all arrived
// Plain HTTP for a network you trust. If KNOB_SERVE_TOKEN is set in wifi_secrets.h, POST /data
// requires the header `X-Token: <token>`.
//
// Measured on a K518 (no TLS, no upload running): the server costs ~8 KB of internal RAM, a
// 250 KB POST takes 1-2 s, and the server task keeps ~1.3 KB of its 4 KB stack free.
// ONE task serves every request in turn: a sender that goes quiet mid-body blocks all other
// requests for about twice NET_SERVE_RECV_TIMEOUT_S before it is dropped.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define NET_SERVE_RECV_TIMEOUT_S 5

// Receives one piece of a POST /data body. `offset` is where this piece starts, `total` the size
// of the whole body; the last piece has offset + len == total. Pieces are whatever the network
// delivers (typically 2-3 KB, never more than NET_CHUNK): do not assume a piece is a whole record.
// `data` is only valid during the call — copy what you keep. Runs on the SERVER task: return
// quickly, and never touch LVGL without ui_lock(). A body that is cut off mid-way simply stops
// arriving; the next body starts again at offset 0.
typedef void (*net_serve_sink_t)(const uint8_t *data, size_t len, size_t offset, size_t total);

// Start the server on port 80. Call once, after net_init(); it listens on every interface and
// survives Wi-Fi reconnects. Bodies larger than `max_body` are refused with 413 before any byte
// is read. Returns false if the buffer or the server could not be created.
bool net_serve_start(net_serve_sink_t sink, size_t max_body);
