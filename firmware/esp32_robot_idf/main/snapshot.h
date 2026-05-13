#pragma once

// BLE snapshot — captures one frame and streams it over the snapshot-
// data char as opcode-tagged frames:
//   0x01 [size:u32 BE]   begin
//   0x02 [payload]       chunk (≤ SNAPSHOT_CHUNK_BYTES)
//   0x03                 commit
//   0xFF [utf8 msg]      error (e.g. "no-camera", "fb-get-failed")
//
// One transfer at a time — overlapping requests during a transfer are
// dropped silently (no error notify, the ongoing transfer continues).
void snapshot_request(void);
