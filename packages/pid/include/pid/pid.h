#pragma once

// Generic discrete PID with clamped integral (anti-windup).
//
// All state lives in the struct so you can run multiple independent loops
// (balance loop, heading loop, etc.) without globals.
//
// Output = Kp*e + Ki*integral + Kd*derivative
//   - integral is clamped to ±(output_limit / Ki) so it can never drive
//     the I-term past the full output range on its own.
//   - output is clamped to ±output_limit.
//   - derivative is on error, not measurement — simpler and fine for
//     a balance bot where setpoint changes are slow.

typedef struct {
    float kp;
    float ki;
    float kd;
    float integral;
    float prev_error;
    float output_limit;
} pid_t;

// Initialize with gains and a symmetric output clamp (±output_limit).
void  pid_init(pid_t *p, float kp, float ki, float kd, float output_limit);

// Compute one tick. Returns clamped output. dt_s: seconds since last call.
float pid_compute(pid_t *p, float error, float dt_s);

// Zero the integral accumulator. Call on I-dump timer fire.
void  pid_reset_integral(pid_t *p);

// Live gain update without resetting accumulated state.
void  pid_set_gains(pid_t *p, float kp, float ki, float kd);
