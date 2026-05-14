#pragma once

// C-compatible API for the Kalman angle filter.
// Use this header from .c files; use kalman.hpp directly from .cpp files.

#ifdef __cplusplus
extern "C" {
#endif

typedef struct kalman_angle_s kalman_angle_t;

kalman_angle_t *kalman_angle_create(float q_angle, float q_bias, float r_measure);
float           kalman_angle_update(kalman_angle_t *k, float gyro_rate_dps,
                                    float accel_angle_deg, float dt_s);
float           kalman_angle_get(const kalman_angle_t *k);
void            kalman_angle_reset(kalman_angle_t *k, float initial_angle);
void            kalman_angle_destroy(kalman_angle_t *k);

#ifdef __cplusplus
}
#endif
