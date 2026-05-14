#include "pid/pid.h"

#include <math.h>

static float clampf(float v, float lo, float hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

void pid_init(pid_t *p, float kp, float ki, float kd, float output_limit) {
    p->kp           = kp;
    p->ki           = ki;
    p->kd           = kd;
    p->integral     = 0.0f;
    p->prev_error   = 0.0f;
    p->output_limit = output_limit;
}

float pid_compute(pid_t *p, float error, float dt_s) {
    // Integrate with anti-windup: clamp so Ki*integral never exceeds output_limit.
    p->integral += error * dt_s;
    if (p->ki > 1e-9f) {
        float ilimit = p->output_limit / p->ki;
        p->integral = clampf(p->integral, -ilimit, ilimit);
    }

    float derivative = (dt_s > 1e-9f) ? (error - p->prev_error) / dt_s : 0.0f;
    p->prev_error = error;

    float out = p->kp * error + p->ki * p->integral + p->kd * derivative;
    return clampf(out, -p->output_limit, p->output_limit);
}

void pid_reset_integral(pid_t *p) {
    p->integral = 0.0f;
}

void pid_set_gains(pid_t *p, float kp, float ki, float kd) {
    p->kp = kp;
    p->ki = ki;
    p->kd = kd;
}
