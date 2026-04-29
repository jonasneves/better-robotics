#pragma once

#include <stdbool.h>
#include <stdint.h>

// White flash LED — PWM brightness 0..100. Same LEDC config as motors
// (1 kHz, 8-bit) but on its own channel so motor PWM doesn't bleed into
// flash output. pin = -1 disables the cap.
void flash_init(int pin);
void flash_apply(uint8_t level);
uint8_t flash_level(void);
bool flash_enabled(void);
