#pragma once
#include <cmath>

struct Pose2D {
    double x;
    double y;
    double theta;
};

inline double normalize_angle(double a) {
    a = std::fmod(a + M_PI, 2.0 * M_PI);
    if (a < 0.0) a += 2.0 * M_PI;
    return a - M_PI;
}
