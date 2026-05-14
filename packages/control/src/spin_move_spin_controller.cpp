#include "control/spin_move_spin_controller.hpp"
#include <algorithm>
#include <cmath>

SpinMoveSpinController::SpinMoveSpinController(SpinMoveSpinParams params)
    : params_(params) {}

void SpinMoveSpinController::setGoal(Pose2D goal) {
    goal_   = goal;
    phase_  = Phase::SPIN_TO_GOAL;
    active_ = true;
}

bool SpinMoveSpinController::isDone() const {
    return phase_ == Phase::DONE;
}

void SpinMoveSpinController::cancel() {
    phase_  = Phase::DONE;
    active_ = false;
}

ControlOutput SpinMoveSpinController::tick(Pose2D current) {
    if (!active_ || phase_ == Phase::DONE) return {0.0, 0.0};

    double dx  = goal_.x - current.x;
    double dy  = goal_.y - current.y;
    double rho = std::sqrt(dx * dx + dy * dy);

    switch (phase_) {
        case Phase::SPIN_TO_GOAL: {
            double alpha = normalize_angle(std::atan2(dy, dx) - current.theta);
            if (std::abs(alpha) < params_.angle_tolerance) {
                phase_ = Phase::DRIVE;
                return {0.0, 0.0};
            }
            return {0.0, std::clamp(params_.k_spin * alpha,
                                    -params_.max_omega, params_.max_omega)};
        }
        case Phase::DRIVE: {
            if (rho < params_.dist_tolerance) {
                phase_ = Phase::SPIN_TO_HEADING;
                return {0.0, 0.0};
            }
            double heading_error = normalize_angle(std::atan2(dy, dx) - current.theta);
            double v     = std::clamp(params_.k_drive * rho,
                                      -params_.max_v, params_.max_v);
            double omega = std::clamp(params_.k_heading * heading_error,
                                      -params_.max_omega, params_.max_omega);
            return {v, omega};
        }
        case Phase::SPIN_TO_HEADING: {
            double heading_error = normalize_angle(goal_.theta - current.theta);
            if (std::abs(heading_error) < params_.angle_tolerance) {
                phase_  = Phase::DONE;
                active_ = false;
                return {0.0, 0.0};
            }
            return {0.0, std::clamp(params_.k_spin * heading_error,
                                    -params_.max_omega, params_.max_omega)};
        }
        case Phase::DONE:
            break;
    }
    return {0.0, 0.0};
}
