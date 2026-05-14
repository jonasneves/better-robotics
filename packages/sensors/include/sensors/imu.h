#pragma once

#include <stdbool.h>
#include "driver/i2c.h"
#include "esp_err.h"

// MPU6050 via I2C. Outputs pitch angle only — this is all a two-wheeled
// balance bot needs. Filter is selected at build time via menuconfig:
//   BALANCE_BOT_IMU_FILTER_COMPLEMENTARY — fixed-ratio blend (default)
//   BALANCE_BOT_IMU_FILTER_KALMAN        — 2-state Kalman with bias correction
//
// Axis convention (chip mounted flat, Y-axis pointing up when balanced):
//   pitch > 0  — robot tilts forward (top toward front)
//   pitch < 0  — robot tilts backward
// Flip CONFIG_BALANCE_BOT_IMU_PITCH_INVERT if your mount reverses this.

esp_err_t imu_init(i2c_port_t port, int sda_pin, int scl_pin, uint8_t addr);

// Call every control-loop tick. dt_s: elapsed seconds since last call.
// Reads all 14 MPU6050 registers in one I2C transaction and updates the
// internal complementary filter. No-op if imu_init failed.
void imu_update(float dt_s);

float imu_pitch_deg(void);
bool  imu_ready(void);
