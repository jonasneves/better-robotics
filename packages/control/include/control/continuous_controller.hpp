#pragma once
#include "pose_controller.hpp"

struct ContinuousParams {
    double k_rho           = 0.3;
    double k_alpha         = 0.8;
    double k_beta          = -0.15;
    double k_theta         = 0.5;
    double dist_threshold  = 0.05;   // meters — switch to heading-only below this
    double dist_tolerance  = 0.02;   // meters
    double angle_tolerance = 0.05;   // radians
    double max_v           = 0.5;    // m/s
    double max_omega       = 1.5;    // rad/s
};

class ContinuousController : public PoseController {
public:
    explicit ContinuousController(ContinuousParams params = {});

    void setGoal(Pose2D goal) override;
    ControlOutput tick(Pose2D current) override;
    bool isDone() const override;
    void cancel() override;

private:
    ContinuousParams params_;
    Pose2D goal_{};
    bool active_ = false;
    bool done_   = false;
};
