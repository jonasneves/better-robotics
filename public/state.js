// Entry is the unit of state. One per paired robot. Each capability stores
// its live references directly on the entry (ledChar, motorChar, wifiStatus,
// cameraPc, etc.) — flat for ergonomics; a capability's section in the card
// is the only place that reads/writes its own fields.
const STORAGE_KEY = "better-robotics:known";

export const state = {
  // id -> entry. Multi-robot: each entry tracks its own status; no "active"
  // robot concept. The LLM-orchestrator future calls tools against entry.id.
  devices: new Map(),
};

// Lazy injection to avoid a circular dep with connect.js. Set at init time.
let _onDisconnectedById = () => {};
export function setDisconnectHandler(fn) { _onDisconnectedById = fn; }

export function persist() {
  const out = [];
  for (const e of state.devices.values()) out.push({ id: e.id, name: e.name });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
}

export function loadKnown() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}

export function makeEntry(id, name) {
  return {
    id, name,
    device: null,
    status: "idle",
    // Per-capability fields. Kept flat on the entry so that each capability
    // module only needs to know its own prefix. Adding a capability adds
    // fields here + a new file under capabilities/.
    ledChar: null, ledOn: false,
    wifiScanChar: null, wifiJoinChar: null, wifiStatusChar: null,
    wifiStatus: { st: "idle" }, wifiNetworks: null, wifiScanning: false,
    otaDataChar: null, otaStatusChar: null, otaStatus: { st: "idle" }, fwInfo: null,
    motorChar: null, motorLeft: 0, motorRight: 0,
    motorSending: false, motorPending: null,
    cameraSignalChar: null, cameraStatusChar: null,
    cameraPc: null, cameraStream: null,
    cameraRecvBuf: null, cameraStatus: null,
    lastEvent: null,
    // DOM node owned by render.js. Null until first mounted. Per-entry node
    // ownership is what lets a notify for robot A skip robot B's DOM —
    // foundation for the LLM-orchestrator direction.
    node: null,
  };
}

export function attachDevice(entry, device) {
  entry.device = device;
  device.addEventListener("gattserverdisconnected", () => _onDisconnectedById(entry.id));
}

export function entryFor(device) {
  const existing = state.devices.get(device.id);
  if (existing) {
    if (!existing.device) attachDevice(existing, device);
    return existing;
  }
  const entry = makeEntry(device.id, device.name || device.id);
  attachDevice(entry, device);
  state.devices.set(device.id, entry);
  persist();
  return entry;
}
