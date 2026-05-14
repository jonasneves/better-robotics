#include "control/diff_drive.hpp"
#include <algorithm>
#include <cmath>

WheelSpeeds to_wheel_speeds(ControlOutput output, const DiffDriveConfig& config) {
    double v_left  = output.v - output.omega * config.wheel_separation / 2.0;
    double v_right = output.v + output.omega * config.wheel_separation / 2.0;

    double scale = config.max_wheel_speed > 0.0 ? 100.0 / config.max_wheel_speed : 0.0;
    return {
        std::clamp(v_left  * scale, -100.0, 100.0),
        std::clamp(v_right * scale, -100.0, 100.0),
    };
}
