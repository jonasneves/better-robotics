"""Motion control for differential drive robots.

Mirrors the interface of packages/control (C++). When that library is compiled
and importable as `control`, swap the import below; until then this pure-Python
implementation runs on the Pi unchanged.
"""

import math


def _normalize_angle(a: float) -> float:
    a = math.fmod(a + math.pi, 2.0 * math.pi)
    if a < 0.0:
        a += 2.0 * math.pi
    return a - math.pi


class Pose2D:
    def __init__(self, x: float = 0.0, y: float = 0.0, theta: float = 0.0):
        self.x = x
        self.y = y
        self.theta = theta


class ControlOutput:
    def __init__(self, v: float = 0.0, omega: float = 0.0):
        self.v = v          # linear velocity  (m/s)
        self.omega = omega  # angular velocity (rad/s)


class WheelSpeeds:
    def __init__(self, left: float = 0.0, right: float = 0.0):
        self.left = left    # [-100, 100]
        self.right = right  # [-100, 100]


class DiffDriveConfig:
    def __init__(self,
                 wheel_separation: float = 0.15,
                 wheel_radius: float = 0.033,
                 max_wheel_speed: float = 0.5):
        self.wheel_separation = wheel_separation  # meters, center to center
        self.wheel_radius = wheel_radius          # meters
        self.max_wheel_speed = max_wheel_speed    # m/s


def to_wheel_speeds(output: ControlOutput, config: DiffDriveConfig) -> WheelSpeeds:
    v_left  = output.v - output.omega * config.wheel_separation / 2.0
    v_right = output.v + output.omega * config.wheel_separation / 2.0
    scale = 100.0 / config.max_wheel_speed if config.max_wheel_speed > 0.0 else 0.0
    return WheelSpeeds(
        max(-100.0, min(100.0, v_left  * scale)),
        max(-100.0, min(100.0, v_right * scale)),
    )


class ContinuousController:
    """Single continuous control law: v = k_rho·ρ·cos(α), ω = k_alpha·α + k_beta·β.
    Switches to heading-only spin when within dist_threshold of goal."""

    def __init__(self,
                 k_rho: float          = 0.3,
                 k_alpha: float        = 0.8,
                 k_beta: float         = -0.15,
                 k_theta: float        = 0.5,
                 dist_threshold: float = 0.05,
                 dist_tolerance: float = 0.02,
                 angle_tolerance: float = 0.05,
                 max_v: float          = 0.5,
                 max_omega: float      = 1.5):
        self.k_rho           = k_rho
        self.k_alpha         = k_alpha
        self.k_beta          = k_beta
        self.k_theta         = k_theta
        self.dist_threshold  = dist_threshold
        self.dist_tolerance  = dist_tolerance
        self.angle_tolerance = angle_tolerance
        self.max_v           = max_v
        self.max_omega       = max_omega
        self._goal: Pose2D | None = None
        self._active = False
        self._done   = False

    def setGoal(self, goal: Pose2D) -> None:
        self._goal   = goal
        self._active = True
        self._done   = False

    def isDone(self) -> bool:
        return self._done

    def cancel(self) -> None:
        self._done   = True
        self._active = False

    def tick(self, current: Pose2D) -> ControlOutput:
        if not self._active or self._done or self._goal is None:
            return ControlOutput()
        dx  = self._goal.x - current.x
        dy  = self._goal.y - current.y
        rho = math.sqrt(dx * dx + dy * dy)
        if rho < self.dist_threshold:
            heading_error = _normalize_angle(self._goal.theta - current.theta)
            if abs(heading_error) < self.angle_tolerance:
                self._done   = True
                self._active = False
                return ControlOutput()
            omega = max(-self.max_omega, min(self.max_omega, self.k_theta * heading_error))
            return ControlOutput(0.0, omega)
        phi   = math.atan2(dy, dx)
        alpha = _normalize_angle(phi - current.theta)
        beta  = _normalize_angle(self._goal.theta - phi)
        v     = max(-self.max_v,     min(self.max_v,     self.k_rho * rho * math.cos(alpha)))
        omega = max(-self.max_omega, min(self.max_omega, self.k_alpha * alpha + self.k_beta * beta))
        return ControlOutput(v, omega)


class SpinMoveSpinController:
    """Three-phase controller: rotate to face goal, drive forward, rotate to final heading."""

    _SPIN_TO_GOAL    = "spin_to_goal"
    _DRIVE           = "drive"
    _SPIN_TO_HEADING = "spin_to_heading"
    _DONE            = "done"

    def __init__(self,
                 k_spin: float          = 0.8,
                 k_drive: float         = 0.4,
                 k_heading: float       = 0.3,
                 angle_tolerance: float = 0.05,
                 dist_tolerance: float  = 0.02,
                 max_v: float           = 0.5,
                 max_omega: float       = 1.5):
        self.k_spin          = k_spin
        self.k_drive         = k_drive
        self.k_heading       = k_heading
        self.angle_tolerance = angle_tolerance
        self.dist_tolerance  = dist_tolerance
        self.max_v           = max_v
        self.max_omega       = max_omega
        self._goal: Pose2D | None = None
        self._phase  = self._DONE
        self._active = False

    def setGoal(self, goal: Pose2D) -> None:
        self._goal   = goal
        self._phase  = self._SPIN_TO_GOAL
        self._active = True

    def isDone(self) -> bool:
        return self._phase == self._DONE

    def cancel(self) -> None:
        self._phase  = self._DONE
        self._active = False

    def tick(self, current: Pose2D) -> ControlOutput:
        if not self._active or self._phase == self._DONE or self._goal is None:
            return ControlOutput()
        dx  = self._goal.x - current.x
        dy  = self._goal.y - current.y
        rho = math.sqrt(dx * dx + dy * dy)
        if self._phase == self._SPIN_TO_GOAL:
            alpha = _normalize_angle(math.atan2(dy, dx) - current.theta)
            if abs(alpha) < self.angle_tolerance:
                self._phase = self._DRIVE
                return ControlOutput()
            omega = max(-self.max_omega, min(self.max_omega, self.k_spin * alpha))
            return ControlOutput(0.0, omega)
        if self._phase == self._DRIVE:
            if rho < self.dist_tolerance:
                self._phase = self._SPIN_TO_HEADING
                return ControlOutput()
            heading_error = _normalize_angle(math.atan2(dy, dx) - current.theta)
            v     = max(-self.max_v,     min(self.max_v,     self.k_drive * rho))
            omega = max(-self.max_omega, min(self.max_omega, self.k_heading * heading_error))
            return ControlOutput(v, omega)
        if self._phase == self._SPIN_TO_HEADING:
            heading_error = _normalize_angle(self._goal.theta - current.theta)
            if abs(heading_error) < self.angle_tolerance:
                self._phase  = self._DONE
                self._active = False
                return ControlOutput()
            omega = max(-self.max_omega, min(self.max_omega, self.k_spin * heading_error))
            return ControlOutput(0.0, omega)
        return ControlOutput()
