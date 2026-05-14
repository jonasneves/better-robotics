#include "control/continuous_controller.hpp"
#include <algorithm>
#include <cmath>

ContinuousController::ContinuousController(ContinuousParams params)
    : params_(params) {}

void ContinuousController::setGoal(Pose2D goal) {
    goal_   = goal;
    active_ = true;
    done_   = false;
}

bool ContinuousController::isDone() const { return done_; }

void ContinuousController::cancel() {
    done_   = true;
    active_ = false;
}

ControlOutput ContinuousController::tick(Pose2D current) {
    if (!active_ || done_) return {0.0, 0.0};

    double dx  = goal_.x - current.x;
    double dy  = goal_.y - current.y;
    double rho = std::sqrt(dx * dx + dy * dy);

    if (rho < params_.dist_threshold) {
        double heading_error = normalize_angle(goal_.theta - current.theta);
        if (std::abs(heading_error) < params_.angle_tolerance) {
            done_   = true;
            active_ = false;
            return {0.0, 0.0};
        }
        double omega = std::clamp(params_.k_theta * heading_error,
                                  -params_.max_omega, params_.max_omega);
        return {0.0, omega};
    }

    double phi   = std::atan2(dy, dx);
    double alpha = normalize_angle(phi - current.theta);
    double beta  = normalize_angle(goal_.theta - phi);

    double v     = std::clamp(params_.k_rho * rho * std::cos(alpha),
                              -params_.max_v, params_.max_v);
    double omega = std::clamp(params_.k_alpha * alpha + params_.k_beta * beta,
                              -params_.max_omega, params_.max_omega);

    return {v, omega};
}
