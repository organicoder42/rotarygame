// main.c — boot order for the Ekko controller. Each init owns one piece of hardware; app_init
// wires them together. NVS first, because the Bluetooth controller that app_init starts keeps
// its radio calibration there. Display before anything that draws, backlight right after the
// display (the panel is dark until the LEDC channel drives it), haptics on the bus the
// display's touch controller opened, the app last because it starts the microphone and both
// links to the browser (USB and Bluetooth LE).
// No Wi-Fi: the only radio user is Bluetooth LE. NVS holds nothing of ours: the firmware
// stores no settings, and the BLE name comes from the chip's address, not from a stored value.
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "nvs_flash.h"
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

// The `nvs` partition holds only the PHY calibration data, which the radio can always measure
// again, so a partition that is full or from another NVS version is simply erased. Without
// NVS the radio still works: it then runs the full calibration on every boot.
static void nvs_init(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "nvs: %s, erasing it", esp_err_to_name(err));
        err = nvs_flash_erase();
        if (err == ESP_OK) err = nvs_flash_init();
    }
    if (err != ESP_OK) ESP_LOGE(TAG, "nvs: %s. The radio calibrates from scratch on every boot", esp_err_to_name(err));
}

void app_main(void)
{
    log_heap("boot");
    nvs_init();                    // before app_init: the BT controller loads its PHY calibration from NVS
    ui_init();                     // ST77916 + CST816 + LVGL (owns the lock from here on)
    backlight_init();              // panel visible
    haptic_init(ui_i2c_bus());     // DRV2605L on the touch bus; no-op if absent
    app_init();                    // screen + inputs + microphone + USB link + Bluetooth LE (needs all above)
#ifdef CONFIG_KNOB_TESTCTL
    testctl_init();                // dev-only console: takes the USB lines that are not protocol
#endif
    log_heap("after init");        // controller + NimBLE host are allocated by now; advertising starts
                                   // a moment later and logs the heap again ("advertising as ...")
}
