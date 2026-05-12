#pragma once

// Discrete complementary filter for IMU pitch estimation.
// Blends gyro integration (fast, drifts long-term) with accel-derived angle
// (slow, noisy short-term) using a fixed trust ratio alpha.
//
// Typical alpha at 100 Hz: 0.98 — accel corrects ~2% per tick (~50 ticks to
// full correction). Lower loop rates need a smaller alpha to avoid drift.
// Raise alpha to trust the gyro more; lower it to follow the accel faster.

typedef struct {
    float alpha;
    float angle;
} comp_filter_t;

// Initialize with trust ratio and a known starting angle (degrees).
void  comp_filter_init(comp_filter_t *f, float alpha, float initial_angle_deg);

// Feed one sample. Returns filtered angle in degrees.
float comp_filter_update(comp_filter_t *f, float gyro_rate_dps,
                         float accel_angle_deg, float dt_s);

float comp_filter_angle(const comp_filter_t *f);
