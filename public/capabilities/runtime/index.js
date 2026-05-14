// Type → runtime-constructor map, keyed by fw-info.caps entry `type`.
import { makeToggleCap            } from "./toggle.js";
import { makeLevelCap             } from "./level.js";
import { makeSignedPairCap        } from "./signed-pair.js";
import { makeCommandCap           } from "./command.js";
import { makeWifiScanCap          } from "./wifi-scan.js";
import { makeWebrtcInstallableCap } from "./webrtc-installable.js";
import { makeMjpegStreamCap       } from "./mjpeg-stream.js";
import { makeBleSnapshotCap       } from "./ble-snapshot.js";
import { makeBalanceBotCap        } from "./balance-bot.js";
import { setRender as setBusRender } from "./render-bus.js";

export const RUNTIMES = {
  "toggle":              makeToggleCap,
  "level":               makeLevelCap,
  "signed-pair":         makeSignedPairCap,
  "command":             makeCommandCap,
  "wifi-scan":           makeWifiScanCap,
  "webrtc-installable":  makeWebrtcInstallableCap,
  "mjpeg-stream":        makeMjpegStreamCap,
  "ble-snapshot":        makeBleSnapshotCap,
  "balance-bot":         makeBalanceBotCap,
};

// All runtime caps share render-bus.js for the back-channel to the
// dashboard's renderEntry. One setter, one binding — no per-module
// plumbing fan-out.
export function setRuntimeRenderer(fn) { setBusRender(fn); }
