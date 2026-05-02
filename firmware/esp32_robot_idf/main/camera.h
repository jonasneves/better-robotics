#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Single hardcoded config: QVGA, JPEG quality 18, fb_count=2 in PSRAM.
// Profiles (compact / standard / full) were dropped — the transport
// toggle (WebRTC vs HTTP MJPEG) covers the latency-vs-cross-network
// axis users actually care about, and bigger frames hurt classic ESP32
// either way (DTLS is CPU-bound on WebRTC, LAN is fine for HTTP at any
// resolution but coex pressure rises). Re-add a runtime resolution
// toggle if higher-res becomes a real need (OV3660 supports
// set_framesize() at runtime, no restart).
bool camera_init(void);
bool camera_ready(void);
int camera_init_error(void);
