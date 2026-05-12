#pragma once

// 2-state discrete Kalman filter for IMU angle + gyro-bias estimation.
// Drop-in upgrade over a complementary filter: same inputs, less phase lag,
// online gyro-bias correction.
//
// State:  x = [angle, gyro_bias]
// Input:  gyro rate (deg/s)  — corrected internally for bias
// Meas:   accel-derived angle (deg)
//
// Noise tuning guide:
//   q_angle   — how fast true angle can change unexpectedly (smaller → smoother)
//   q_bias    — how fast gyro bias drifts (very small, bias is near-constant)
//   r_measure — accel noise; increase if your accel is noisy or bot vibrates

namespace kalman {

struct AngleConfig {
    float q_angle   = 0.001f;
    float q_bias    = 0.003f;
    float r_measure = 0.03f;
};

class AngleFilter {
public:
    explicit AngleFilter(AngleConfig cfg = {});

    // Feed one sample. Returns filtered angle in degrees.
    float update(float gyro_rate_dps, float accel_angle_deg, float dt_s);

    float angle() const { return angle_; }
    float bias()  const { return bias_; }

    void reset(float initial_angle = 0.0f);

private:
    AngleConfig cfg_;
    float angle_;
    float bias_;
    float P_[2][2];  // error covariance matrix
};

} // namespace kalman
