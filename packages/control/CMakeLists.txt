cmake_minimum_required(VERSION 3.14)
project(control VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CONTROL_SOURCES
    src/diff_drive.cpp
    src/continuous_controller.cpp
    src/spin_move_spin_controller.cpp
)

add_library(control ${CONTROL_SOURCES})
target_include_directories(control PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>
)

# Python extension — built only when pybind11 is available.
# On the Pi: pip install pybind11, then cmake -DBUILD_PYTHON=ON ..
option(BUILD_PYTHON "Build pybind11 Python extension" OFF)
if(BUILD_PYTHON)
    find_package(pybind11 REQUIRED)
    pybind11_add_module(control_py python/bindings.cpp ${CONTROL_SOURCES})
    target_include_directories(control_py PRIVATE include)
    set_target_properties(control_py PROPERTIES OUTPUT_NAME "control")
endif()
