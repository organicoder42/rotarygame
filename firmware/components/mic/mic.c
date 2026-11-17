// mic.c — I2S PDM RX + reader task. Configuration is the known-good one from the board skill
// (jc3636k518-device/references/microphone.md): 24 kHz, mono, LEFT slot, 16-bit.
#include "mic.h"
#include "mic_level.h"
#include "board.h"
#include "driver/i2s_pdm.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "mic";

#define BLOCK_MS         10u
#define SAMPLE_RATE_HZ   24000u
#define BLOCK_SAMPLES    (SAMPLE_RATE_HZ * BLOCK_MS / 1000u)   // 240
#define SETTLE_BLOCKS    (200u / BLOCK_MS)   // the stream starts with a loud transient
#define READ_TIMEOUT_MS  200u
#define TASK_STACK       4096u
#define STACK_LOG_BLOCKS 1000u                   // log the stack low-water mark after 10 s of work

static i2s_chan_handle_t s_rx;
static mic_block_cb_t    s_on_block;
static int16_t           s_buf[BLOCK_SAMPLES];   // static: nothing this size goes on the stack

static bool channel_start(void)
{
    i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    chan.dma_frame_num = BLOCK_SAMPLES;
    esp_err_t err = i2s_new_channel(&chan, NULL, &s_rx);
    if (err != ESP_OK) { ESP_LOGE(TAG, "i2s_new_channel: %s", esp_err_to_name(err)); return false; }

    i2s_pdm_rx_config_t cfg = {
        .clk_cfg  = I2S_PDM_RX_CLK_DEFAULT_CONFIG(SAMPLE_RATE_HZ),
        .slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = { .clk = BOARD_MIC_CLK, .din = BOARD_MIC_DIN,
                      .invert_flags = { .clk_inv = false } },
    };
    cfg.slot_cfg.slot_mask = I2S_PDM_SLOT_LEFT;   // reading both slots pins the level at full scale
    err = i2s_channel_init_pdm_rx_mode(s_rx, &cfg);
    if (err == ESP_OK) err = i2s_channel_enable(s_rx);
    if (err != ESP_OK) { ESP_LOGE(TAG, "PDM RX start: %s", esp_err_to_name(err)); return false; }
    return true;
}

static void mic_task(void *arg)
{
    (void)arg;
    mic_level_state_t level_state = {0};
    uint32_t blocks = 0, read_errors = 0;
    for (;;) {
        size_t got = 0;
        esp_err_t err = i2s_channel_read(s_rx, s_buf, sizeof(s_buf), &got,
                                         pdMS_TO_TICKS(READ_TIMEOUT_MS));
        if (err != ESP_OK || got < sizeof(int16_t)) {
            if ((read_errors++ % 50u) == 0)
                ESP_LOGE(TAG, "read failed (%s, %u bytes), %u so far", esp_err_to_name(err),
                         (unsigned)got, (unsigned)read_errors);
            vTaskDelay(pdMS_TO_TICKS(BLOCK_MS));   // a read that fails at once must not starve LVGL
            continue;
        }
        // The filter runs during the settle time too, so it has converged when levels start.
        int level = mic_level_block(&level_state, s_buf, got / sizeof(int16_t));
        if (++blocks <= SETTLE_BLOCKS) continue;
        s_on_block(level, (uint32_t)(esp_timer_get_time() / 1000));
        if (blocks == STACK_LOG_BLOCKS)
            ESP_LOGI(TAG, "stack low-water mark: %u bytes free of %u",
                     (unsigned)uxTaskGetStackHighWaterMark(NULL), TASK_STACK);
    }
}

bool mic_init(mic_block_cb_t on_block)
{
    if (!on_block) { ESP_LOGE(TAG, "mic_init: no callback"); return false; }
    s_on_block = on_block;
    if (!channel_start()) return false;
    if (xTaskCreate(mic_task, "mic", TASK_STACK, NULL, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "mic task not created");
        return false;
    }
    ESP_LOGI(TAG, "PDM mic up: %u Hz, %u-sample blocks", SAMPLE_RATE_HZ, (unsigned)BLOCK_SAMPLES);
    return true;
}
