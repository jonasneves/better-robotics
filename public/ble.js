// BLE service + characteristic UUIDs. Must match firmware/pi_robot/pi_robot.py
// and firmware/esp32_robot/esp32_robot.ino exactly. All characteristics live
// inside one service; each represents one capability.
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

// Chunked-frame protocol shared by OTA and camera signaling. Begin carries a
// u32 big-endian length, chunks append, commit parses + acts, stop tears down.
export const CHUNK_BYTES = 180;  // safe under ATT MTU on macOS/Chrome.

export const decodeJson = (dv) => {
  try {
    const text = new TextDecoder().decode(dv);
    return text ? JSON.parse(text) : null;
  } catch { return null; }
};
export const encodeJson = (obj) => new TextEncoder().encode(JSON.stringify(obj));
