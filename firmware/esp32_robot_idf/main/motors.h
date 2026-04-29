#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "pin_config.h"

// L298N H-bridge driver. PWM rides the IN pins (ENA/ENB jumpered ON).
// Forward = IN1=PWM/IN2=LOW; reverse = IN1=LOW/IN2=PWM.
// signedSpeed range is [-100, 100]; magnitude > 100 clamps to 100.
//
// Two safety rungs match firmware/pi_robot/pi_robot.py:
//   - Watchdog: any non-zero apply arms a 500ms one-shot. Re-armed on
//     each apply; fires if the operator stops sending updates (BLE drop,
//     dashboard tab closed, etc.).
//   - Pulse:    LLM tool calls go through motors_pulse() with a bounded
//     duration. Speed clamped to LLM_MAX_SPEED, dur to LLM_MAX_DURATION_MS,
//     and a one-shot timer auto-stops at the end. A newer apply (joystick,
//     newer pulse) wins via pulse_id check inside the timer fire.
void motors_init(const pin_config_t *cfg);

// Persistent apply (joystick). Speed in [-100, 100].
void motors_apply(int8_t left, int8_t right);

// Time-bounded pulse (LLM safety). Speed clamped, dur clamped.
void motors_pulse(int8_t left, int8_t right, uint16_t dur_ms);

void motors_get(int8_t *left, int8_t *right);
bool motors_enabled(void);
