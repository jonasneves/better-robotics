#pragma once

// WebRTC peer — connects to wss://signal.neevs.io/esp32-rtc-<robot_name>/ws,
// negotiates SDP+ICE with the dashboard, completes a peer connection.
//
// Phase 2.D.1 covers signaling + libpeer scaffold only. Phase 2.D.2 wires
// data channels (ota / logs / ops); Phase 2.D.3 sends camera frames as
// binary on a `video` data channel (browsers can't decode MJPEG video
// tracks, so we route around the codec gap with a binary channel).
//
// Wire protocol matches firmware/pi_robot/pi_robot_rtc.py — same room
// shape (`<role>-rtc-<robotId>`), same signal frames, same role filter
// (only "dashboard-*" peers accepted). The ESP32 plays the answerer.
void webrtc_peer_init(const char *robot_name);
