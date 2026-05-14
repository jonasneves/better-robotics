#include "kalman/kalman.hpp"
#include "kalman/kalman.h"

namespace kalman {

AngleFilter::AngleFilter(AngleConfig cfg)
    : cfg_(cfg), angle_(0.0f), bias_(0.0f)
{
    P_[0][0] = 0.0f; P_[0][1] = 0.0f;
    P_[1][0] = 0.0f; P_[1][1] = 0.0f;
}

float AngleFilter::update(float gyro_rate_dps, float accel_angle_deg, float dt_s) {
    // Predict step — integrate gyro (bias-corrected) and propagate covariance.
    angle_ += dt_s * (gyro_rate_dps - bias_);
    P_[0][0] += dt_s * (dt_s * P_[1][1] - P_[0][1] - P_[1][0] + cfg_.q_angle);
    P_[0][1] -= dt_s * P_[1][1];
    P_[1][0] -= dt_s * P_[1][1];
    P_[1][1] += cfg_.q_bias * dt_s;

    // Update step — H = [1, 0]: accel measures angle directly.
    float S  = P_[0][0] + cfg_.r_measure;
    float K0 = P_[0][0] / S;
    float K1 = P_[1][0] / S;

    float y = accel_angle_deg - angle_;
    angle_ += K0 * y;
    bias_  += K1 * y;

    float P00 = P_[0][0];
    float P01 = P_[0][1];
    P_[0][0] -= K0 * P00;
    P_[0][1] -= K0 * P01;
    P_[1][0] -= K1 * P00;
    P_[1][1] -= K1 * P01;

    return angle_;
}

void AngleFilter::reset(float initial_angle) {
    angle_   = initial_angle;
    bias_    = 0.0f;
    P_[0][0] = 0.0f; P_[0][1] = 0.0f;
    P_[1][0] = 0.0f; P_[1][1] = 0.0f;
}

} // namespace kalman

// ── C wrappers ────────────────────────────────────────────────────────────

struct kalman_angle_s : public kalman::AngleFilter {
    kalman_angle_s(float q_angle, float q_bias, float r_measure)
        : kalman::AngleFilter({q_angle, q_bias, r_measure}) {}
};

kalman_angle_t *kalman_angle_create(float q_angle, float q_bias, float r_measure) {
    return new kalman_angle_s(q_angle, q_bias, r_measure);
}

float kalman_angle_update(kalman_angle_t *k, float gyro_rate_dps,
                          float accel_angle_deg, float dt_s) {
    return k->update(gyro_rate_dps, accel_angle_deg, dt_s);
}

float kalman_angle_get(const kalman_angle_t *k) {
    return k->angle();
}

void kalman_angle_reset(kalman_angle_t *k, float initial_angle) {
    k->reset(initial_angle);
}

void kalman_angle_destroy(kalman_angle_t *k) {
    delete k;
}
