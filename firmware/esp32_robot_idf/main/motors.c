#include "motors.h"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_timer.h"

#include "encoders.h"
#include "gatt_svr.h"

static const char *TAG = "motors";

// LEDC timer shared with flash (same 1 kHz / 8-bit). Two driving modes,
// chosen at init based on pin_config:
//
//   MODE_DIR  (motor_ena / motor_enb both -1)
//     Legacy mode for L298Ns whose ENA/ENB are tied HIGH externally
//     (jumper to +5V). PWM rides whichever direction pin is the active
//     one (forward when speed > 0, backward when < 0); the other
//     direction pin is held LOW. Uses 4 LEDC channels (one per IN pin).
//
//   MODE_EN   (motor_ena / motor_enb both >= 0)
//     PWM rides ENA / ENB; IN1..IN4 are digital direction outputs.
//     Matches the Pi side's gpiozero Motor(enable=) behavior. Uses 2
//     LEDC channels (one per enable pin); IN1..IN4 are plain GPIO out.
//
// MODE_DIR is the historical AI-Thinker setup. MODE_EN matches the Pi
// behavior and lets a DevKit / C3 user wire ENA/ENB to MCU pins for
// proper per-motor speed control without dumping a PWM channel on each
// direction pin.
#define MOTOR_MODE       LEDC_LOW_SPEED_MODE
#define MOTOR_TIMER      LEDC_TIMER_0
#define MOTOR_FREQ_HZ    1000
#define MOTOR_RES        LEDC_TIMER_8_BIT

#define MOTOR_WATCHDOG_MS    500
#define LLM_MAX_SPEED        40
#define LLM_MAX_DURATION_MS  2000

// Stall rung: a commanded side that hasn't ticked for STALL_THRESHOLD_MS
// is jammed (wall, gear bind, broken motor wire). Cut power before the
// H-bridge cooks. Rolling per-side baseline — any tick advances the
// clock for that side. STALL_MIN_SPEED suppresses false trips at low
// joystick magnitudes where low-PPR encoders legitimately won't tick
// inside the window. No-op when encoders aren't wired.
#define STALL_CHECK_MS       50
#define STALL_THRESHOLD_MS   200
#define STALL_MIN_SPEED      10

// Direction pins: l_fwd, l_bwd, r_fwd, r_bwd.
static int s_pin[4] = { -1, -1, -1, -1 };
static int s_ena = -1, s_enb = -1;
static bool s_use_en_pwm = false;
// MODE_DIR uses ch[0..3] for L-fwd, L-bwd, R-fwd, R-bwd PWM.
// MODE_EN  uses ch[0]   for ENA PWM and ch[1] for ENB PWM (other
//          channels unused; IN1..IN4 are plain GPIO outputs).
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
static esp_timer_handle_t s_stall_timer;
static uint32_t s_stall_base_l, s_stall_base_r;
static int64_t  s_stall_base_us_l, s_stall_base_us_r;

// Drive one motor. idx=0 → left (uses s_pin[0..1] and ENA / channel 0),
// idx=1 → right (uses s_pin[2..3] and ENB / channel 1). Both modes
// clamp magnitude to [0..100] and map to 0..255 duty (8-bit LEDC).
static void drive_motor(int idx, int8_t signed_speed) {
    if (!s_attached) return;
    int magnitude = signed_speed < 0 ? -signed_speed : signed_speed;
    if (magnitude > 100) magnitude = 100;
    uint32_t duty = ((uint32_t)magnitude * 255) / 100;
    const ledc_channel_t fwd_ch = s_chan[idx * 2];
    const ledc_channel_t bwd_ch = s_chan[idx * 2 + 1];
    const int fwd_pin = s_pin[idx * 2];
    const int bwd_pin = s_pin[idx * 2 + 1];

    if (s_use_en_pwm) {
        // Direction on IN-fwd / IN-bwd (digital), magnitude on EN-PWM.
        // signed_speed == 0 → both direction lines LOW (coast); the EN
        // PWM going to 0 also disables the driver, redundant but cheap.
        gpio_set_level(fwd_pin, signed_speed > 0 ? 1 : 0);
        gpio_set_level(bwd_pin, signed_speed < 0 ? 1 : 0);
        const ledc_channel_t en_ch = (idx == 0) ? LEDC_CHANNEL_0 : LEDC_CHANNEL_1;
        ledc_set_duty(MOTOR_MODE, en_ch, duty);
        ledc_update_duty(MOTOR_MODE, en_ch);
        return;
    }
    // MODE_DIR: PWM on whichever IN is the active direction.
    if (signed_speed >= 0) {
        ledc_set_duty(MOTOR_MODE, fwd_ch, duty);
        ledc_set_duty(MOTOR_MODE, bwd_ch, 0);
    } else {
        ledc_set_duty(MOTOR_MODE, fwd_ch, 0);
        ledc_set_duty(MOTOR_MODE, bwd_ch, duty);
    }
    ledc_update_duty(MOTOR_MODE, fwd_ch);
    ledc_update_duty(MOTOR_MODE, bwd_ch);
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
    drive_motor(0, 0);
    drive_motor(1, 0);
    esp_timer_stop(s_stall_timer);
    gatt_svr_notify_motor();
}

static void stall_check(void *arg) {
    if (!encoders_enabled()) return;
    uint32_t cur_l, cur_r;
    encoders_get(&cur_l, &cur_r);
    int64_t now = esp_timer_get_time();
    int8_t abs_l = s_left < 0 ? -s_left : s_left;
    int8_t abs_r = s_right < 0 ? -s_right : s_right;
    bool stalled = false;

    if (abs_l >= STALL_MIN_SPEED) {
        if (cur_l != s_stall_base_l) {
            s_stall_base_l = cur_l;
            s_stall_base_us_l = now;
        } else if (now - s_stall_base_us_l > (int64_t)STALL_THRESHOLD_MS * 1000) {
            stalled = true;
        }
    }
    if (abs_r >= STALL_MIN_SPEED) {
        if (cur_r != s_stall_base_r) {
            s_stall_base_r = cur_r;
            s_stall_base_us_r = now;
        } else if (now - s_stall_base_us_r > (int64_t)STALL_THRESHOLD_MS * 1000) {
            stalled = true;
        }
    }
    if (stalled) {
        ESP_LOGW(TAG, "stall, stopping");
        motors_apply(0, 0);
    }
}

void motors_init(const pin_config_t *cfg) {
    if (!pin_motors_configured(cfg)) {
        ESP_LOGI(TAG, "pins -1, cap disabled");
        return;
    }
    s_pin[0] = cfg->motor_l_fwd;
    s_pin[1] = cfg->motor_l_bwd;
    s_pin[2] = cfg->motor_r_fwd;
    s_pin[3] = cfg->motor_r_bwd;
    s_ena = cfg->motor_ena;
    s_enb = cfg->motor_enb;
    // Mode selection: both ENA and ENB wired → PWM-on-enable. Either
    // unwired → fall back to PWM-on-direction (legacy AI-Thinker shape).
    s_use_en_pwm = (s_ena >= 0 && s_enb >= 0);

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

    if (s_use_en_pwm) {
        // PWM on ENA / ENB (channels 0, 1). Direction pins are plain GPIO.
        const int en_pins[2] = { s_ena, s_enb };
        for (int i = 0; i < 2; i++) {
            ledc_channel_config_t ch = {
                .gpio_num = en_pins[i],
                .speed_mode = MOTOR_MODE,
                .channel = s_chan[i],
                .timer_sel = MOTOR_TIMER,
                .duty = 0,
                .hpoint = 0,
            };
            if (ledc_channel_config(&ch) != ESP_OK) {
                ESP_LOGE(TAG, "ledc_channel_config failed on EN GPIO %d", en_pins[i]);
                return;
            }
        }
        // Direction pins as outputs, initialized LOW.
        for (int i = 0; i < 4; i++) {
            gpio_reset_pin(s_pin[i]);
            gpio_set_direction(s_pin[i], GPIO_MODE_OUTPUT);
            gpio_set_level(s_pin[i], 0);
        }
        ESP_LOGI(TAG, "PWM-on-enable mode, L=%d/%d ENA=%d R=%d/%d ENB=%d",
                 s_pin[0], s_pin[1], s_ena, s_pin[2], s_pin[3], s_enb);
    } else {
        // PWM on all 4 direction pins (channels 0..3).
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
        ESP_LOGI(TAG, "PWM-on-direction mode, L=%d/%d R=%d/%d (ENA/ENB tied HIGH externally)",
                 s_pin[0], s_pin[1], s_pin[2], s_pin[3]);
    }
    s_attached = true;

    esp_timer_create_args_t wargs = { .callback = watchdog_fire, .name = "motor_wd" };
    esp_timer_create(&wargs, &s_watchdog_timer);
    esp_timer_create_args_t pargs = { .callback = pulse_fire, .name = "motor_pulse" };
    esp_timer_create(&pargs, &s_pulse_timer);
    esp_timer_create_args_t sargs = { .callback = stall_check, .name = "motor_stall" };
    esp_timer_create(&sargs, &s_stall_timer);
}

void motors_apply(int8_t left, int8_t right) {
    s_left = left;
    s_right = right;
    s_pulse_id++;
    drive_motor(0, left);
    drive_motor(1, right);

    esp_timer_stop(s_watchdog_timer);
    esp_timer_stop(s_stall_timer);
    if (left != 0 || right != 0) {
        esp_timer_start_once(s_watchdog_timer, (uint64_t)MOTOR_WATCHDOG_MS * 1000);
        if (encoders_enabled()) {
            encoders_get(&s_stall_base_l, &s_stall_base_r);
            s_stall_base_us_l = s_stall_base_us_r = esp_timer_get_time();
            esp_timer_start_periodic(s_stall_timer, (uint64_t)STALL_CHECK_MS * 1000);
        }
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
