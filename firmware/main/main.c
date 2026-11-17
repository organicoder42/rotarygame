// main.c — boot order for the Ekko controller. Each init owns one piece of hardware; app_init
// wires them together. Display before anything that draws, backlight right after the display
// (the panel is dark until the LEDC channel drives it), haptics on the bus the display's touch
// controller opened, the app last because it starts the microphone and the host link.
// No Wi-Fi and no NVS: nothing in this firmware uses the radio or stores anything.
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "ui.h"
#include "backlight.h"
#include "haptic.h"
#include "app.h"
#ifdef CONFIG_KNOB_TESTCTL
#include "testctl.h"
#endif

static const char *TAG = "main";

static void log_heap(const char *phase)
{
    ESP_LOGI(TAG, "heap[%s]: internal free=%u min=%u, psram free=%u", phase,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}

void app_main(void)
{
    log_heap("boot");
    ui_init();                     // ST77916 + CST816 + LVGL (owns the lock from here on)
    backlight_init();              // panel visible
    haptic_init(ui_i2c_bus());     // DRV2605L on the touch bus; no-op if absent
    app_init();                    // screen + inputs + microphone + host link (needs all above)
#ifdef CONFIG_KNOB_TESTCTL
    testctl_init();                // dev-only console: takes the lines that are not protocol
#endif
    log_heap("after init");
}
