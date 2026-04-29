#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// -1 = "not wired, disable this cap." Same sentinel the .ino used.
typedef struct {
    int led;
    int flash;
    int motor_l_in1;
    int motor_l_in2;
    int motor_r_in1;
    int motor_r_in2;
} pin_config_t;

bool pin_valid(int pin);
bool pin_motors_configured(const pin_config_t *cfg);

// Load from NVS namespace "pins". Defaults match the .ino's AI-Thinker
// layout (LED=33, FLASH=4, motors 14/15/13/12) so a fresh chip behaves
// like the Arduino firmware did out of the box.
void pin_config_load(pin_config_t *out);

// Handle a JSON write from the BLE pin-config char. Validates against the
// camera-reserved set, persists valid pins to NVS, and arms a deferred
// reboot so the new pins take effect on next boot. Invalid writes are
// dropped silently — the dashboard's editor catches most of these
// client-side; the firmware-side check is the second line of defense.
void pin_config_handle_write(const uint8_t *json, size_t len);
