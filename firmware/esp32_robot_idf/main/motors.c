#include "motors.h"

#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_timer.h"

#include "gatt_svr.h"

static const char *TAG = "motors";

// LEDC timer/channels — share TIMER_0 with flash (same 1 kHz / 8-bit).
// Channels 0..3 = motors L-IN1, L-IN2, R-IN1, R-IN2.
#define MOTOR_MODE       LEDC_LOW_SPEED_MODE
#define MOTOR_TIMER      LEDC_TIMER_0
#define MOTOR_FREQ_HZ    1000
#define MOTOR_RES        LEDC_TIMER_8_BIT

#define MOTOR_WATCHDOG_MS    500
#define LLM_MAX_SPEED        40
#define LLM_MAX_DURATION_MS  2000

static int s_pin[4] = { -1, -1, -1, -1 };
static const ledc_channel_t s_chan[4] = {
    LEDC_CHANNEL_0, LEDC_CHANNEL_1, LEDC_CHANNEL_2, LEDC_CHANNEL_3,
};
static bool s_attached = false;
static int8_t s_left = 0, s_right = 0;

// Newer-write-wins. motors_pulse() captures s_pulse_id at start; the
// pulse timer compares against current id at fire time. Any apply
// (joystick or fresh pulse) bumps the id, invalidating the pending stop.
static uint32_t s_pulse_id = 0;
static uint32_t s_active_pulse_id = 0;

static esp_timer_handle_t s_watchdog_timer;
static esp_timer_handle_t s_pulse_timer;

static void drive_half_bridge(ledc_channel_t in1, ledc_channel_t in2, int8_t signed_speed) {
    if (!s_attached) return;
    int magnitude = signed_speed < 0 ? -signed_speed : signed_speed;
    if (magnitude > 100) magnitude = 100;
    uint32_t duty = ((uint32_t)magnitude * 255) / 100;
    if (signed_speed >= 0) {
        ledc_set_duty(MOTOR_MODE, in1, duty);
        ledc_set_duty(MOTOR_MODE, in2, 0);
    } else {
        ledc_set_duty(MOTOR_MODE, in1, 0);
        ledc_set_duty(MOTOR_MODE, in2, duty);
    }
    ledc_update_duty(MOTOR_MODE, in1);
    ledc_update_duty(MOTOR_MODE, in2);
}

static void watchdog_fire(void *arg) {
    if (s_left != 0 || s_right != 0) {
        ESP_LOGI(TAG, "watchdog stop");
        motors_apply(0, 0);
    }
}

static void pulse_fire(void *arg) {
    // Skip if a newer write superseded the pulse this timer was armed for.
    if (s_active_pulse_id != s_pulse_id) return;
    ESP_LOGI(TAG, "pulse ended");
    s_left = 0;
    s_right = 0;
    drive_half_bridge(s_chan[0], s_chan[1], 0);
    drive_half_bridge(s_chan[2], s_chan[3], 0);
    gatt_svr_notify_motor();
}

void motors_init(const pin_config_t *cfg) {
    if (!pin_motors_configured(cfg)) {
        ESP_LOGI(TAG, "pins -1, cap disabled");
        return;
    }
    s_pin[0] = cfg->motor_l_in1;
    s_pin[1] = cfg->motor_l_in2;
    s_pin[2] = cfg->motor_r_in1;
    s_pin[3] = cfg->motor_r_in2;

    ledc_timer_config_t tcfg = {
        .speed_mode = MOTOR_MODE,
        .timer_num = MOTOR_TIMER,
        .duty_resolution = MOTOR_RES,
        .freq_hz = MOTOR_FREQ_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    if (ledc_timer_config(&tcfg) != ESP_OK) {
        ESP_LOGE(TAG, "ledc_timer_config failed");
        return;
    }
    for (int i = 0; i < 4; i++) {
        ledc_channel_config_t ch = {
            .gpio_num = s_pin[i],
            .speed_mode = MOTOR_MODE,
            .channel = s_chan[i],
            .timer_sel = MOTOR_TIMER,
            .duty = 0,
            .hpoint = 0,
        };
        if (ledc_channel_config(&ch) != ESP_OK) {
            ESP_LOGE(TAG, "ledc_channel_config failed on GPIO %d", s_pin[i]);
            return;
        }
    }
    s_attached = true;
    ESP_LOGI(TAG, "PWM ready, L=%d/%d R=%d/%d", s_pin[0], s_pin[1], s_pin[2], s_pin[3]);

    esp_timer_create_args_t wargs = { .callback = watchdog_fire, .name = "motor_wd" };
    esp_timer_create(&wargs, &s_watchdog_timer);
    esp_timer_create_args_t pargs = { .callback = pulse_fire, .name = "motor_pulse" };
    esp_timer_create(&pargs, &s_pulse_timer);
}

void motors_apply(int8_t left, int8_t right) {
    s_left = left;
    s_right = right;
    s_pulse_id++;
    drive_half_bridge(s_chan[0], s_chan[1], left);
    drive_half_bridge(s_chan[2], s_chan[3], right);

    esp_timer_stop(s_watchdog_timer);
    if (left != 0 || right != 0) {
        esp_timer_start_once(s_watchdog_timer, (uint64_t)MOTOR_WATCHDOG_MS * 1000);
    }
    gatt_svr_notify_motor();
    ESP_LOGI(TAG, "→ (%+d, %+d)", left, right);
}

void motors_pulse(int8_t left, int8_t right, uint16_t dur_ms) {
    if (left  < -LLM_MAX_SPEED) left  = -LLM_MAX_SPEED;
    if (left  >  LLM_MAX_SPEED) left  =  LLM_MAX_SPEED;
    if (right < -LLM_MAX_SPEED) right = -LLM_MAX_SPEED;
    if (right >  LLM_MAX_SPEED) right =  LLM_MAX_SPEED;
    if (dur_ms < 50)                  dur_ms = 50;
    if (dur_ms > LLM_MAX_DURATION_MS) dur_ms = LLM_MAX_DURATION_MS;

    motors_apply(left, right);              // bumps s_pulse_id
    s_active_pulse_id = s_pulse_id;         // claim this pulse
    esp_timer_stop(s_pulse_timer);
    esp_timer_start_once(s_pulse_timer, (uint64_t)dur_ms * 1000);
}

void motors_get(int8_t *left, int8_t *right) { *left = s_left; *right = s_right; }
bool motors_enabled(void) { return s_attached; }
