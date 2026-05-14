#pragma once
#include "control_output.hpp"

struct DiffDriveConfig {
    double wheel_separation;  // meters, center to center
    double wheel_radius;      // meters
    double max_wheel_speed;   // m/s
};

struct WheelSpeeds {
    double left;   // [-100, 100]
    double right;  // [-100, 100]
};

WheelSpeeds to_wheel_speeds(ControlOutput output, const DiffDriveConfig& config);
