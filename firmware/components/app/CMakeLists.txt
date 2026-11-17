# hud_view.c is pure (screen decisions, no drawing) and host-tested.
idf_component_register(
    SRCS "app.c" "app_link.c" "app_screen.c" "app_screen_live.c" "hud_view.c"
    INCLUDE_DIRS "include"
    REQUIRES ui theme haptic mic proto hostlink esp_timer
)
