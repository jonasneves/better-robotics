#include "complementary/complementary.h"

void comp_filter_init(comp_filter_t *f, float alpha, float initial_angle_deg) {
    f->alpha = alpha;
    f->angle = initial_angle_deg;
}

float comp_filter_update(comp_filter_t *f, float gyro_rate_dps,
                         float accel_angle_deg, float dt_s) {
    f->angle = f->alpha * (f->angle + gyro_rate_dps * dt_s)
             + (1.0f - f->alpha) * accel_angle_deg;
    return f->angle;
}

float comp_filter_angle(const comp_filter_t *f) {
    return f->angle;
}
