#pragma once
#include "pose_controller.hpp"

struct SpinMoveSpinParams {
    double k_spin          = 0.8;
    double k_drive         = 0.4;
    double k_heading       = 0.3;   // drift correction during drive phase
    double angle_tolerance = 0.05;  // radians
    double dist_tolerance  = 0.02;  // meters
    double max_v           = 0.5;   // m/s
    double max_omega       = 1.5;   // rad/s
};

class SpinMoveSpinController : public PoseController {
public:
    explicit SpinMoveSpinController(SpinMoveSpinParams params = {});

    void setGoal(Pose2D goal) override;
    ControlOutput tick(Pose2D current) override;
    bool isDone() const override;
    void cancel() override;

private:
    enum class Phase { SPIN_TO_GOAL, DRIVE, SPIN_TO_HEADING, DONE };

    SpinMoveSpinParams params_;
    Pose2D goal_{};
    Phase  phase_  = Phase::DONE;
    bool   active_ = false;
};
