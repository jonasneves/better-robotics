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

// Boot-time probe. Initializes the camera briefly to verify the sensor
// is present + addressable, then deinits to free the ~32 KB contiguous
// internal DMA buffer. Sets the present/error state queried by fw_info
// so the dashboard can advertise the capability without keeping the
// hardware online at idle. Returns true if the camera is reachable.
bool camera_probe(void);

// Capability advertisement state, set by camera_probe().
bool camera_present(void);
int  camera_init_error(void);

// Refcounted acquire/release. Consumers (webrtc video pump, http_stream
// MJPEG handler, snapshot task) call acquire when they need frames and
// release when they don't. The 0→1 transition runs esp_camera_init();
// the N→0 transition runs esp_camera_deinit() and reclaims the DMA
// buffer. Multiple overlapping consumers share one initialized cam_hal.
// Idle cost = zero. Concurrent acquires from different tasks are safe
// (mutex-guarded). acquire returns false if the camera isn't present.
bool camera_acquire(void);
void camera_release(void);
