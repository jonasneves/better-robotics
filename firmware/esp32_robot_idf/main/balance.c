#include "sdkconfig.h"
#if CONFIG_BALANCE_BOT_ENABLED

#include "balance.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "gatt_svr.h"
#include "sensors/imu.h"
#include "motors.h"
#include "pid/pid.h"

static const char *TAG = "balance";

// ── Tuning constants ────────────────────────────────────────────────────────

#define BALANCE_TASK_HZ     100
#define BALANCE_DT_S        (1.0f / BALANCE_TASK_HZ)

// How many degrees of setpoint shift a full joystick deflection produces.
// Small: bot leans gently and moves slowly. Too large: unstable.
#define LEAN_MAX_DEG        5.0f

// Differential motor units added for turning (out of ±95 total).
#define TURN_MAX_EFFORT     30.0f

// Safety cutoff — stop motors if |pitch| exceeds this (bot has fallen).
#define FALLEN_THRESHOLD_DEG 45.0f

// Motor output headroom — keep below 100 so the H-bridge isn't saturated
// while the turn differential is added.
#define MOTOR_LIMIT         95.0f

// State notify cadence: every N balance ticks (~10 Hz at 100 Hz loop rate).
#define NOTIFY_EVERY_N_TICKS 10

// Default PID starting point. These are intentionally conservative; the user
// tunes them live via the dashboard. Kp too high → oscillation. Kd too high
// → amplifies noise. Ki small so windup doesn't fight a fallen bot.
#define DEFAULT_KP  15.0f
#define DEFAULT_KI   0.5f
#define DEFAULT_KD   1.2f

// ── Shared state (guarded by s_mux) ────────────────────────────────────────

static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

static float s_lean_setpoint = 0.0f;   // degrees; modified by joystick
static float s_turn_effort   = 0.0f;   // raw motor units; added differentially
static int64_t s_cmd_last_us = 0;      // esp_timer_get_time() at last cmd write

// Joystick command timeout: if no cmd for this long, snap back to neutral.
// Prevents the bot from driving into a wall after BLE disconnects.
#define CMD_TIMEOUT_US (2LL * 1000000LL)

typedef enum { MODE_BALANCE, MODE_GOTO, MODE_FALLEN } balance_mode_t;
static balance_mode_t s_mode = MODE_BALANCE;

// Goto target — stored but not acted on until CV branch merges.
static struct {
    float x_mm;
    float y_mm;
    float theta_deg;
    bool  active;
} s_target;

// ── PID ─────────────────────────────────────────────────────────────────────

static pid_t s_pid;

// ── I-dump timer ─────────────────────────────────────────────────────────────

static esp_timer_handle_t s_idump_timer = NULL;
static int s_idump_interval_s = 0;

static void idump_cb(void *arg) {
    taskENTER_CRITICAL(&s_mux);
    pid_reset_integral(&s_pid);
    taskEXIT_CRITICAL(&s_mux);
    ESP_LOGI(TAG, "I-dump: integral reset");
}

static void set_idump_interval(int interval_s) {
    s_idump_interval_s = interval_s;
    esp_timer_stop(s_idump_timer);
    if (interval_s > 0) {
        esp_timer_start_periodic(s_idump_timer,
                                 (int64_t)interval_s * 1000000LL);
    }
}

// ── Cached JSON buffers ──────────────────────────────────────────────────────

#define PID_JSON_BUF   128
#define STATE_JSON_BUF 128

static char s_pid_json[PID_JSON_BUF];
static char s_state_json[STATE_JSON_BUF];

static void build_pid_json(void) {
    float kp, ki, kd;
    taskENTER_CRITICAL(&s_mux);
    kp = s_pid.kp;
    ki = s_pid.ki;
    kd = s_pid.kd;
    taskEXIT_CRITICAL(&s_mux);
    snprintf(s_pid_json, PID_JSON_BUF,
             "{\"p\":%.4g,\"i\":%.4g,\"d\":%.4g,\"idump_s\":%d}",
             kp, ki, kd, s_idump_interval_s);
}

static void build_state_json(float pitch, float setpoint, balance_mode_t mode) {
    const char *mode_str;
    switch (mode) {
        case MODE_GOTO:   mode_str = "goto";    break;
        case MODE_FALLEN: mode_str = "fallen";  break;
        default:          mode_str = "balance"; break;
    }
    snprintf(s_state_json, STATE_JSON_BUF,
             "{\"pitch\":%.2f,\"sp\":%.2f,\"mode\":\"%s\"}",
             pitch, setpoint, mode_str);
}

// ── Enabled flag ─────────────────────────────────────────────────────────────

static bool s_enabled = false;
bool balance_enabled(void) { return s_enabled; }

// ── 100 Hz control task ──────────────────────────────────────────────────────

static void balance_task(void *arg) {
    TickType_t last_wake = xTaskGetTickCount();
    const TickType_t period = pdMS_TO_TICKS(1000 / BALANCE_TASK_HZ);
    int notify_counter = 0;

    while (1) {
        vTaskDelayUntil(&last_wake, period);

        imu_update(BALANCE_DT_S);
        float pitch = imu_pitch_deg();

        taskENTER_CRITICAL(&s_mux);
        float lean = s_lean_setpoint;
        float turn = s_turn_effort;
        balance_mode_t mode = s_mode;

        // Command timeout — snap to neutral if operator disappeared.
        if (s_cmd_last_us > 0 &&
            esp_timer_get_time() - s_cmd_last_us > CMD_TIMEOUT_US) {
            s_lean_setpoint = 0.0f;
            s_turn_effort   = 0.0f;
            lean = turn = 0.0f;
        }
        taskEXIT_CRITICAL(&s_mux);

        // Safety: stop and mark fallen if tipped past recovery angle.
        if (fabsf(pitch) > FALLEN_THRESHOLD_DEG) {
            motors_apply(0, 0);
            taskENTER_CRITICAL(&s_mux);
            s_mode = MODE_FALLEN;
            taskEXIT_CRITICAL(&s_mux);
            mode = MODE_FALLEN;
            goto notify_check;
        }

        // If we were fallen and recovered (someone picked the bot up),
        // clear the state and reset the PID.
        if (mode == MODE_FALLEN) {
            taskENTER_CRITICAL(&s_mux);
            s_mode = MODE_BALANCE;
            pid_reset_integral(&s_pid);
            taskEXIT_CRITICAL(&s_mux);
            mode = MODE_BALANCE;
        }

        {
            // Compute balance effort.
            taskENTER_CRITICAL(&s_mux);
            float effort = pid_compute(&s_pid, lean - pitch, BALANCE_DT_S);
            taskEXIT_CRITICAL(&s_mux);

            // Clamp total effort before adding turn differential.
            float effort_clamped = effort;
            if (effort_clamped >  MOTOR_LIMIT) effort_clamped =  MOTOR_LIMIT;
            if (effort_clamped < -MOTOR_LIMIT) effort_clamped = -MOTOR_LIMIT;

            float left  = effort_clamped + turn;
            float right = effort_clamped - turn;
            if (left  >  MOTOR_LIMIT) left  =  MOTOR_LIMIT;
            if (left  < -MOTOR_LIMIT) left  = -MOTOR_LIMIT;
            if (right >  MOTOR_LIMIT) right =  MOTOR_LIMIT;
            if (right < -MOTOR_LIMIT) right = -MOTOR_LIMIT;

            motors_apply((int8_t)left, (int8_t)right);
        }

notify_check:
        if (++notify_counter >= NOTIFY_EVERY_N_TICKS) {
            notify_counter = 0;
            build_state_json(pitch, lean, mode);
            gatt_svr_notify_balance_state();
        }
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

void balance_init(void) {
    // Create I-dump timer (stopped; started when user sets idump_s > 0).
    esp_timer_create_args_t ta = { .callback = idump_cb, .name = "idump" };
    esp_timer_create(&ta, &s_idump_timer);

    esp_err_t err = imu_init(
        (i2c_port_t)CONFIG_BALANCE_BOT_I2C_PORT,
        CONFIG_BALANCE_BOT_I2C_SDA,
        CONFIG_BALANCE_BOT_I2C_SCL,
        (uint8_t)CONFIG_BALANCE_BOT_IMU_ADDR
    );
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "IMU init failed — balance disabled");
        return;
    }

    pid_init(&s_pid, DEFAULT_KP, DEFAULT_KI, DEFAULT_KD, MOTOR_LIMIT);
    build_pid_json();
    build_state_json(imu_pitch_deg(), 0.0f, MODE_BALANCE);

    s_enabled = true;

    // Pin to core 1; NimBLE host runs on core 0 by default.
    xTaskCreatePinnedToCore(balance_task, "balance", 4096, NULL, 5, NULL, 1);
    ESP_LOGI(TAG, "balance task started at %d Hz", BALANCE_TASK_HZ);
}

void balance_handle_cmd(int8_t lean_pct, int8_t turn_pct) {
    float lean = (lean_pct / 100.0f) * LEAN_MAX_DEG;
    float turn = (turn_pct / 100.0f) * TURN_MAX_EFFORT;
    taskENTER_CRITICAL(&s_mux);
    s_lean_setpoint = lean;
    s_turn_effort   = turn;
    s_cmd_last_us   = esp_timer_get_time();
    taskEXIT_CRITICAL(&s_mux);
}

void balance_handle_pid_write(const uint8_t *data, uint16_t len) {
    if (len >= 128) return;
    char buf[129];
    memcpy(buf, data, len);
    buf[len] = '\0';

    cJSON *obj = cJSON_Parse(buf);
    if (!obj) return;

    cJSON *p     = cJSON_GetObjectItemCaseSensitive(obj, "p");
    cJSON *i     = cJSON_GetObjectItemCaseSensitive(obj, "i");
    cJSON *d     = cJSON_GetObjectItemCaseSensitive(obj, "d");
    cJSON *idump = cJSON_GetObjectItemCaseSensitive(obj, "idump_s");

    taskENTER_CRITICAL(&s_mux);
    if (cJSON_IsNumber(p)) s_pid.kp = (float)p->valuedouble;
    if (cJSON_IsNumber(i)) s_pid.ki = (float)i->valuedouble;
    if (cJSON_IsNumber(d)) s_pid.kd = (float)d->valuedouble;
    taskEXIT_CRITICAL(&s_mux);

    if (cJSON_IsNumber(idump)) {
        int iv = idump->valueint;
        if (iv < 0) iv = 0;
        set_idump_interval(iv);
    }

    cJSON_Delete(obj);

    build_pid_json();
    gatt_svr_notify_balance_pid();
    ESP_LOGI(TAG, "PID updated: %s", s_pid_json);
}

void balance_handle_target_write(const uint8_t *data, uint16_t len) {
    if (len >= 128) return;
    char buf[129];
    memcpy(buf, data, len);
    buf[len] = '\0';

    cJSON *obj = cJSON_Parse(buf);
    if (!obj) return;

    cJSON *x      = cJSON_GetObjectItemCaseSensitive(obj, "x");
    cJSON *y      = cJSON_GetObjectItemCaseSensitive(obj, "y");
    cJSON *theta  = cJSON_GetObjectItemCaseSensitive(obj, "theta");
    cJSON *active = cJSON_GetObjectItemCaseSensitive(obj, "active");

    if (cJSON_IsNumber(x))     s_target.x_mm      = (float)x->valuedouble;
    if (cJSON_IsNumber(y))     s_target.y_mm      = (float)y->valuedouble;
    if (cJSON_IsNumber(theta)) s_target.theta_deg = (float)theta->valuedouble;

    if (cJSON_IsBool(active)) {
        s_target.active = cJSON_IsTrue(active);
        // Phase 1 stub: accept the target but stay in balance-only mode.
        // The goto controller hooks in here once the cv branch merges and
        // provides a live cvPosition fix.
        taskENTER_CRITICAL(&s_mux);
        s_mode = s_target.active ? MODE_GOTO : MODE_BALANCE;
        taskEXIT_CRITICAL(&s_mux);
    }

    cJSON_Delete(obj);
    ESP_LOGI(TAG, "goto target: x=%.0f y=%.0f theta=%.0f active=%d",
             s_target.x_mm, s_target.y_mm, s_target.theta_deg,
             (int)s_target.active);
}

const char *balance_pid_json(void)   { return s_pid_json;   }
const char *balance_state_json(void) { return s_state_json; }

#endif // CONFIG_BALANCE_BOT_ENABLED
