#include <pybind11/pybind11.h>
#include "control/pose2d.hpp"
#include "control/control_output.hpp"
#include "control/diff_drive.hpp"
#include "control/continuous_controller.hpp"
#include "control/spin_move_spin_controller.hpp"

namespace py = pybind11;

PYBIND11_MODULE(control, m) {
    py::class_<Pose2D>(m, "Pose2D")
        .def(py::init<double, double, double>(),
             py::arg("x") = 0.0, py::arg("y") = 0.0, py::arg("theta") = 0.0)
        .def_readwrite("x",     &Pose2D::x)
        .def_readwrite("y",     &Pose2D::y)
        .def_readwrite("theta", &Pose2D::theta);

    py::class_<ControlOutput>(m, "ControlOutput")
        .def(py::init<double, double>(),
             py::arg("v") = 0.0, py::arg("omega") = 0.0)
        .def_readwrite("v",     &ControlOutput::v)
        .def_readwrite("omega", &ControlOutput::omega);

    py::class_<WheelSpeeds>(m, "WheelSpeeds")
        .def(py::init<double, double>(),
             py::arg("left") = 0.0, py::arg("right") = 0.0)
        .def_readwrite("left",  &WheelSpeeds::left)
        .def_readwrite("right", &WheelSpeeds::right);

    py::class_<DiffDriveConfig>(m, "DiffDriveConfig")
        .def(py::init<double, double, double>(),
             py::arg("wheel_separation") = 0.15,
             py::arg("wheel_radius")     = 0.033,
             py::arg("max_wheel_speed")  = 0.5)
        .def_readwrite("wheel_separation", &DiffDriveConfig::wheel_separation)
        .def_readwrite("wheel_radius",     &DiffDriveConfig::wheel_radius)
        .def_readwrite("max_wheel_speed",  &DiffDriveConfig::max_wheel_speed);

    m.def("to_wheel_speeds", &to_wheel_speeds, py::arg("output"), py::arg("config"));

    py::class_<ContinuousController>(m, "ContinuousController")
        .def(py::init<ContinuousParams>(), py::arg("params") = ContinuousParams{})
        .def("setGoal", &ContinuousController::setGoal)
        .def("tick",    &ContinuousController::tick)
        .def("isDone",  &ContinuousController::isDone)
        .def("cancel",  &ContinuousController::cancel);

    py::class_<SpinMoveSpinController>(m, "SpinMoveSpinController")
        .def(py::init<SpinMoveSpinParams>(), py::arg("params") = SpinMoveSpinParams{})
        .def("setGoal", &SpinMoveSpinController::setGoal)
        .def("tick",    &SpinMoveSpinController::tick)
        .def("isDone",  &SpinMoveSpinController::isDone)
        .def("cancel",  &SpinMoveSpinController::cancel);
}
