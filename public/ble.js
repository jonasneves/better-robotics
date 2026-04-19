// UUIDs must match firmware/pi_robot/pi_robot.py and firmware/esp32_robot/esp32_robot.ino exactly.
export const SERVICE_UUID          = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d91";
export const LED_CHAR_UUID         = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d92";
export const WIFI_SCAN_CHAR_UUID   = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d93";
export const WIFI_JOIN_CHAR_UUID   = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d94";
export const WIFI_STATUS_CHAR_UUID = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d95";
export const OTA_DATA_CHAR_UUID    = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d96";
export const OTA_STATUS_CHAR_UUID  = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d97";
export const FW_INFO_CHAR_UUID     = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d98";
export const MOTOR_CHAR_UUID       = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d99";
export const CAMERA_SIGNAL_CHAR_UUID = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d9a";
export const CAMERA_STATUS_CHAR_UUID = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d9b";
export const OPS_CHAR_UUID            = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d9c";
export const ROBOT_STATUS_CHAR_UUID   = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d9d";
export const OPS_RESPONSE_CHAR_UUID   = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d9e";
export const TELEMETRY_CHAR_UUID      = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d9f";

// Chunked-frame protocol shared by OTA and camera signaling: begin carries a
// u32 big-endian length, chunks append, commit parses + acts, stop tears down.
export const CHUNK_BYTES = 180;  // safe under ATT MTU on macOS/Chrome.

// Canonical capability-name → char UUID(s). Lets fw-info.caps stay tiny (must
// fit in one ~180 B ATT read) — the dashboard looks up chars by cap name.
export const UUIDS_BY_CAP = {
  led:    LED_CHAR_UUID,
  motors: MOTOR_CHAR_UUID,
  wifi:   { scan: WIFI_SCAN_CHAR_UUID, join: WIFI_JOIN_CHAR_UUID, status: WIFI_STATUS_CHAR_UUID },
  ota:    { data: OTA_DATA_CHAR_UUID, status: OTA_STATUS_CHAR_UUID },
  camera: { signal: CAMERA_SIGNAL_CHAR_UUID, status: CAMERA_STATUS_CHAR_UUID },
  ops:    OPS_CHAR_UUID,
};

export const decodeJson = (dv) => {
  try {
    const text = new TextDecoder().decode(dv);
    return text ? JSON.parse(text) : null;
  } catch { return null; }
};
export const encodeJson = (obj) => new TextEncoder().encode(JSON.stringify(obj));
