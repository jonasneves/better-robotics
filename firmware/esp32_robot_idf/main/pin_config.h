#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// -1 = "not wired, disable this cap."
//
// Motor wiring has two modes, mirroring the Pi side's gpiozero Motor()
// constructor:
//   - PWM-on-direction (motor_ena/motor_enb = -1): firmware drives PWM
//     on motor_l_fwd / motor_l_bwd directly. ENA/ENB on the L298N are
//     tied HIGH externally (factory jumpers or a wire to the L298N's
//     own +5V rail). 4 LEDC channels.
//   - PWM-on-enable  (motor_ena and motor_enb >= 0): PWM on the enable
//     pins, IN1..IN4 are digital direction lines. Matches the Pi
//     side's behavior when enable= is set on Motor(). 2 LEDC channels.
typedef struct {
    int led;
    int flash;
    int motor_l_fwd;
    int motor_l_bwd;
    int motor_r_fwd;
    int motor_r_bwd;
    int motor_ena;   // optional; -1 = PWM-on-direction mode
    int motor_enb;   // optional; -1 = PWM-on-direction mode
    int enc_l;
    int enc_r;
} pin_config_t;

bool pin_valid(int pin);
bool pin_motors_configured(const pin_config_t *cfg);

// Load from NVS namespace "pins". Defaults are board-dependent — see
// pin_config.c's CONFIG_BR_BOARD_* switch.
void pin_config_load(pin_config_t *out);

// Handle a JSON write from the BLE pin-config char. Validates against the
// board's forbidden set, persists valid pins to NVS, and arms a deferred
// reboot so the new pins take effect on next boot. Invalid writes are
// dropped silently — the dashboard's editor catches most of these
// client-side; the firmware-side check is the second line of defense.
void pin_config_handle_write(const uint8_t *json, size_t len);
