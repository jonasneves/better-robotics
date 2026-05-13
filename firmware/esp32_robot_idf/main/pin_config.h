#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// -1 = "not wired, disable this cap."
typedef struct {
    int led;
    int flash;
    int motor_l_fwd;
    int motor_l_bwd;
    int motor_r_fwd;
    int motor_r_bwd;
} pin_config_t;

bool pin_valid(int pin);
bool pin_motors_configured(const pin_config_t *cfg);

// Load from NVS namespace "pins". Defaults are the AI-Thinker layout
// (LED=33, FLASH=4, motors 14/15/13/12) — see pin_config.c.
void pin_config_load(pin_config_t *out);

// Handle a JSON write from the BLE pin-config char. Validates against the
// camera-reserved set, persists valid pins to NVS, and arms a deferred
// reboot so the new pins take effect on next boot. Invalid writes are
// dropped silently — the dashboard's editor catches most of these
// client-side; the firmware-side check is the second line of defense.
void pin_config_handle_write(const uint8_t *json, size_t len);
