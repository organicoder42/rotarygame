# PDM microphone -> per-block sound level. mic_level.c is pure and host-tested.
idf_component_register(
    SRCS "mic.c" "mic_level.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_driver_i2s esp_timer board
)
