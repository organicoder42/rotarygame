# The Ekko wire contract (../../PROTOCOL.md) as pure C: no ESP-IDF, FreeRTOS or LVGL includes.
# Host-tested in test/host/test_proto.c.
idf_component_register(
    SRCS "proto.c"
    INCLUDE_DIRS "include"
)
