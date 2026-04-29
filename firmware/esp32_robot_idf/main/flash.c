#include "flash.h"

#include "driver/ledc.h"
#include "esp_log.h"

#include "gatt_svr.h"
#include "pin_config.h"

static const char *TAG = "flash";

#define FLASH_TIMER   LEDC_TIMER_0
#define FLASH_CHANNEL LEDC_CHANNEL_4   // motors take 0..3
#define FLASH_MODE    LEDC_LOW_SPEED_MODE

static int s_pin = -1;
static bool s_attached = false;
static uint8_t s_level = 0;

void flash_init(int pin) {
    s_pin = pin;
    if (!pin_valid(pin)) {
        ESP_LOGI(TAG, "pin -1, cap disabled");
        return;
    }
    ledc_channel_config_t ch = {
        .gpio_num = pin,
        .speed_mode = FLASH_MODE,
        .channel = FLASH_CHANNEL,
        .timer_sel = FLASH_TIMER,
        .duty = 0,
        .hpoint = 0,
    };
    if (ledc_channel_config(&ch) != ESP_OK) {
        ESP_LOGE(TAG, "ledc_channel_config failed on GPIO %d", pin);
        return;
    }
    s_attached = true;
    ESP_LOGI(TAG, "PWM ready on GPIO %d", pin);
}

void flash_apply(uint8_t level) {
    if (level > 100) level = 100;
    s_level = level;
    if (s_attached) {
        uint32_t duty = ((uint32_t)level * 255) / 100;
        ledc_set_duty(FLASH_MODE, FLASH_CHANNEL, duty);
        ledc_update_duty(FLASH_MODE, FLASH_CHANNEL);
    }
    gatt_svr_notify_flash();
}

uint8_t flash_level(void) { return s_level; }
bool flash_enabled(void) { return s_attached; }
