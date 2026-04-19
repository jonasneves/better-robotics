// Type → runtime-constructor map. When a robot's fw-info.caps entry has a
// type listed here, the dashboard instantiates a capability from schema +
// no hand-written JS is needed for that capability of that type.
//
// As more types migrate, add them here. Capabilities not yet migrated stay
// in capabilities/*.js as hand-written modules; both run side-by-side
// during the transition.
import { makeToggleCap,             setRender as setToggleRender     } from "./toggle.js";
import { makeSignedPairCap,         setRender as setSignedPairRender } from "./signed-pair.js";
import { makeCommandCap,            setRender as setCommandRender    } from "./command.js";
import { makeWifiScanCap,           setRender as setWifiScanRender   } from "./wifi-scan.js";
import { makeWebrtcInstallableCap,  setRender as setWebrtcRender     } from "./webrtc-installable.js";

export const RUNTIMES = {
  "toggle":              makeToggleCap,
  "signed-pair":         makeSignedPairCap,
  "command":             makeCommandCap,
  "wifi-scan":           makeWifiScanCap,
  "webrtc-installable":  makeWebrtcInstallableCap,
};

export function setRuntimeRenderer(fn) {
  setToggleRender(fn);
  setSignedPairRender(fn);
  setCommandRender(fn);
  setWifiScanRender(fn);
  setWebrtcRender(fn);
}
