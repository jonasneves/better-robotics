#pragma once

#include <stdbool.h>

// Status LED on classic ESP32-CAM is active-low (GPIO 33 sinks current
// through a series resistor to 3v3). pin = -1 disables the cap.
void led_init(int pin);
void led_apply(bool on);
bool led_state(void);
bool led_enabled(void);
