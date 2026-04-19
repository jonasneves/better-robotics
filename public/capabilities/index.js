// Hand-written capabilities. Remaining: ota (bridges Pi bundle-OTA and
// ESP32 legacy single-file OTA — cross-platform, not purely one type).
// Every other capability has moved to a runtime constructor under
// ./runtime/. Adding a new capability of a migrated type is one schema
// entry on firmware + zero browser code.
import { ota, setRender as setOtaRender } from "./ota.js";
import { setRuntimeRenderer } from "./runtime/index.js";

export const ALL = [ota];

export function setCapabilityRenderer(fn) {
  setOtaRender(fn);
  setRuntimeRenderer(fn);
}
