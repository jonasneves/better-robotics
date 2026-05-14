# ESP-IDF project — esp32_robot.
#
# Migration from firmware/esp32_robot/esp32_robot.ino (Arduino single-file
# sketch). Lives in parallel during the migration; the Arduino project stays
# the shipping firmware until this one is feature-complete and tested. See
# README.md in this directory for the migration arc.
#
# Target chip: ESP32-S3 (PSRAM + hardware H.264 encoder make camera-as-WebRTC-
# video-track viable). Classic ESP32 (AI-Thinker ESP32-CAM, the "MB" board) is
# the secondary target — same firmware via build-time flag, MJPEG-in-RTP
# fallback for the camera path since it lacks H.264 encoding.

cmake_minimum_required(VERSION 3.16)

# Apply local patches to managed components after the component-manager
# has fetched them but before they're built. Each patch is idempotent —
# `patch --forward` skips already-applied patches without erroring.
# See firmware/esp32_robot_idf/patches/ for the patch set.
set(MANAGED_COMPONENTS "${CMAKE_CURRENT_SOURCE_DIR}/managed_components")
set(PATCH_DIR "${CMAKE_CURRENT_SOURCE_DIR}/patches")
if(EXISTS "${MANAGED_COMPONENTS}" AND EXISTS "${PATCH_DIR}")
    file(GLOB LOCAL_PATCHES "${PATCH_DIR}/*.patch")
    foreach(PATCH IN LISTS LOCAL_PATCHES)
        execute_process(
            COMMAND patch -p2 -d "${MANAGED_COMPONENTS}" --forward --silent --batch
            INPUT_FILE "${PATCH}"
            RESULT_VARIABLE PATCH_RESULT
            OUTPUT_QUIET ERROR_QUIET
        )
        # patch returns 1 if already-applied (--forward); treat as success.
        if(NOT PATCH_RESULT EQUAL 0 AND NOT PATCH_RESULT EQUAL 1)
            message(WARNING "Patch ${PATCH} failed with code ${PATCH_RESULT}")
        endif()
    endforeach()
endif()

list(APPEND EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_SOURCE_DIR}/../../packages/pid"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../packages/sensors"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../packages/complementary"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../packages/kalman")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

project(esp32_robot)
