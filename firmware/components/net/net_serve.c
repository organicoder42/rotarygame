// net_serve.c — esp_http_server wrapped in the same discipline as the upload path: the body is
// received through one NET_CHUNK buffer in PSRAM and handed on piece by piece, so peak heap does
// not depend on body size. The admission rules live in serve_gate.c (pure, host-tested).
#include "net_serve.h"
#include "net.h"
#include "serve_gate.h"
#include "wifi_secrets.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_timer.h"
#include <stdio.h>

#ifndef KNOB_SERVE_TOKEN          // older wifi_secrets.h files do not define it: open endpoint
#define KNOB_SERVE_TOKEN ""
#endif

static const char *TAG = "serve";

static net_serve_sink_t s_sink;
static size_t           s_max_body;
static uint8_t         *s_chunk;   // own buffer, not the upload's: both may run at the same time

static void log_internal_heap(const char *phase)
{
    ESP_LOGI(TAG, "heap[%s]: internal free=%u min=%u", phase,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
}

// ---------------------------------------------------------------- GET /status --

static esp_err_t status_get(httpd_req_t *req)
{
    char body[96];
    snprintf(body, sizeof(body), "{\"rssi\":%d,\"free_internal\":%u,\"uptime_s\":%u}\n", net_rssi(),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)(esp_timer_get_time() / 1000000));
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, body);
}

// ----------------------------------------------------------------- POST /data --

// Answer a refused request. Always answer: a caller left without a response waits out its own
// timeout and then retries.
static esp_err_t refuse(httpd_req_t *req, serve_verdict_t verdict)
{
    switch (verdict) {
    case SERVE_UNAUTHORISED: return httpd_resp_send_err(req, HTTPD_401_UNAUTHORIZED, "missing or wrong X-Token");
    case SERVE_EMPTY:        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "empty body");
    default:
        httpd_resp_set_status(req, "413 Payload Too Large");
        return httpd_resp_sendstr(req, "body too large\n");
    }
}

static esp_err_t data_post(httpd_req_t *req)
{
    char token[64];
    bool has_token = httpd_req_get_hdr_value_str(req, "X-Token", token, sizeof(token)) == ESP_OK;
    serve_verdict_t verdict = serve_gate(KNOB_SERVE_TOKEN, has_token ? token : NULL,
                                         req->content_len, s_max_body);
    if (verdict != SERVE_ACCEPT) return refuse(req, verdict);

    size_t total = req->content_len, got = 0;
    while (got < total) {
        size_t want = total - got < NET_CHUNK ? total - got : NET_CHUNK;
        int n = httpd_req_recv(req, (char *)s_chunk, want);
        if (n <= 0) {   // timeout or error. No retry: every retry is more time nobody else is served.
            ESP_LOGW(TAG, "POST /data: gave up at %u/%u B (%d)", (unsigned)got, (unsigned)total, n);
            return ESP_FAIL;                              // ESP_FAIL closes the connection
        }
        if (s_sink) s_sink(s_chunk, (size_t)n, got, total);
        got += (size_t)n;
    }
    ESP_LOGI(TAG, "POST /data: %u B", (unsigned)total);
    return httpd_resp_sendstr(req, "ok\n");
}

// ---------------------------------------------------------------------- start --

bool net_serve_start(net_serve_sink_t sink, size_t max_body)
{
    if (s_chunk) return true;   // already running
    s_sink = sink;
    s_max_body = max_body;
    s_chunk = heap_caps_malloc(NET_CHUNK, MALLOC_CAP_SPIRAM);
    if (!s_chunk) { ESP_LOGE(TAG, "chunk alloc failed"); return false; }

    log_internal_heap("before serve");
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();          // port 80, 4 KB stack, priority 5
    cfg.max_open_sockets  = 3;       // default 7; every open socket costs internal RAM
    cfg.lru_purge_enable  = true;    // drop the oldest idle connection instead of refusing a new one
    cfg.recv_wait_timeout = NET_SERVE_RECV_TIMEOUT_S;     // a stalled sender must not hold the server
    cfg.send_wait_timeout = NET_SERVE_RECV_TIMEOUT_S;
    httpd_handle_t server = NULL;
    if (httpd_start(&server, &cfg) != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed");
        heap_caps_free(s_chunk);
        s_chunk = NULL;
        return false;
    }
    static const httpd_uri_t status = { .uri = "/status", .method = HTTP_GET,  .handler = status_get };
    static const httpd_uri_t data   = { .uri = "/data",   .method = HTTP_POST, .handler = data_post };
    httpd_register_uri_handler(server, &status);
    httpd_register_uri_handler(server, &data);
    log_internal_heap("after serve");

    if (KNOB_SERVE_TOKEN[0] == '\0') ESP_LOGW(TAG, "no KNOB_SERVE_TOKEN: POST /data is open to this network");
    ESP_LOGI(TAG, "listening on :80 (GET /status, POST /data up to %u B)", (unsigned)max_body);
    return true;
}
