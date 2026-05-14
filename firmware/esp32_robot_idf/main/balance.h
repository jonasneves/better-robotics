#pragma once

#include <stdbool.h>
#include <stdint.h>

// Balance bot state machine + 100 Hz FreeRTOS task.
//
// Control layers (inner to outer):
//   1. Balance PID   — closes on IMU pitch; output = raw motor effort.
//   2. Drive layer   — joystick lean% shifts the balance setpoint, creating
//                      a controlled forward/backward tilt.
//   3. Turn layer    — joystick turn% adds a signed differential on top of
//                      the balance output, independent of lean.
//
// Goto mode is a Phase-1 stub: the BLE characteristic is fully wired and
// the target is stored, but the controller stays in balance-only mode until
// CV localization (cv branch) provides a position fix.
//
// Thread safety: lean_setpoint / turn_effort / pid gains are updated from
// the NimBLE host task and read from the balance task on core 1. A
// portMUX_TYPE spinlock guards every cross-task write/read pair.

void balance_init(void);

// BLE characteristic handlers — called from gatt_svr.c.
void        balance_handle_cmd(int8_t lean_pct, int8_t turn_pct);
void        balance_handle_pid_write(const uint8_t *json, uint16_t len);
void        balance_handle_target_write(const uint8_t *json, uint16_t len);
const char *balance_pid_json(void);
const char *balance_state_json(void);

// True once imu_init succeeded and the task is running.
bool balance_enabled(void);
