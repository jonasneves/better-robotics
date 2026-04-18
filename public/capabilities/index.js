// Capability registry. Adding a new capability means:
//   1. Create capabilities/{name}.js exporting the capability object
//   2. Import it here and add to ALL
//   3. (Optional) Declare matching BLE char + config key on the firmware side
// connect() iterates ALL for probing; renderEntry() iterates for sections +
// wireActions + postRender; makeEntry() composes initEntry() contributions.
import { led,    setRender as setLedRender }    from "./led.js";
import { motors, setRender as setMotorsRender } from "./motors.js";
import { wifi,   setRender as setWifiRender }   from "./wifi.js";
import { ota,    setRender as setOtaRender }    from "./ota.js";
import { camera, setRender as setCameraRender } from "./camera.js";

export const ALL = [led, motors, wifi, ota, camera];

export function setCapabilityRenderer(fn) {
  setLedRender(fn);
  setMotorsRender(fn);
  setWifiRender(fn);
  setOtaRender(fn);
  setCameraRender(fn);
}
