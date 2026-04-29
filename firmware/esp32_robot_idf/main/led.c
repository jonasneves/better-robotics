#include "led.h"

#include "driver/gpio.h"
#include "esp_log.h"

#include "gatt_svr.h"
#include "pin_config.h"

static const char *TAG = "led";

static int s_pin = -1;
static bool s_on = false;

void led_init(int pin) {
    s_pin = pin;
    if (!pin_valid(pin)) {
        ESP_LOGI(TAG, "pin -1, cap disabled");
        return;
    }
    gpio_reset_pin(pin);
    gpio_set_direction(pin, GPIO_MODE_OUTPUT);
    gpio_set_level(pin, 1);  // active-low — high = off
    s_on = false;
}

void led_apply(bool on) {
    s_on = on;
    if (pin_valid(s_pin)) {
        gpio_set_level(s_pin, on ? 0 : 1);
    }
    gatt_svr_notify_led();
}

bool led_state(void) { return s_on; }
bool led_enabled(void) { return pin_valid(s_pin); }
