#pragma once
#include "pose2d.hpp"
#include "control_output.hpp"

class PoseController {
public:
    virtual ~PoseController() = default;
    virtual void setGoal(Pose2D goal) = 0;
    virtual ControlOutput tick(Pose2D current) = 0;
    virtual bool isDone() const = 0;
    virtual void cancel() = 0;
};
