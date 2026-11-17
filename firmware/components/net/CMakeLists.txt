idf_component_register(
    SRCS "net.c" "net_http.c" "upload_plan.c" "net_serve.c" "serve_gate.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_wifi esp_netif esp_event nvs_flash esp_http_client esp_timer mbedtls esp_http_server
)
