#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Single hardcoded config: QVGA, JPEG quality 18, fb_count=2 in PSRAM.
// Bigger frames hurt classic ESP32 (DTLS is CPU-bound for WebRTC; coex
// pressure rises on HTTP MJPEG). The transport toggle (WebRTC vs HTTP
// MJPEG) covers the latency-vs-cross-network axis. Add a runtime
// resolution toggle if higher-res becomes a real need — OV3660 supports
// set_framesize() at runtime.
bool camera_init(void);
bool camera_ready(void);
int camera_init_error(void);
