// Type → runtime-constructor map, keyed by fw-info.caps entry `type`.
import { makeToggleCap,             setRender as setToggleRender     } from "./toggle.js";
import { makeSignedPairCap,         setRender as setSignedPairRender } from "./signed-pair.js";
import { makeCommandCap                                              } from "./command.js";
import { makeWifiScanCap,           setRender as setWifiScanRender   } from "./wifi-scan.js";
import { makeWebrtcInstallableCap,  setRender as setWebrtcRender     } from "./webrtc-installable.js";
import { makeMjpegStreamCap,        setRender as setMjpegRender      } from "./mjpeg-stream.js";
import { makeBleSnapshotCap,        setRender as setBleSnapshotRender} from "./ble-snapshot.js";

export const RUNTIMES = {
  "toggle":              makeToggleCap,
  "signed-pair":         makeSignedPairCap,
  "command":             makeCommandCap,
  "wifi-scan":           makeWifiScanCap,
  "webrtc-installable":  makeWebrtcInstallableCap,
  "mjpeg-stream":        makeMjpegStreamCap,
  "ble-snapshot":        makeBleSnapshotCap,
};

export function setRuntimeRenderer(fn) {
  setToggleRender(fn);
  setSignedPairRender(fn);
  setWifiScanRender(fn);
  setWebrtcRender(fn);
  setMjpegRender(fn);
  setBleSnapshotRender(fn);
}
