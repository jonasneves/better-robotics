const STORAGE_KEY = "better-robotics:known";

export const state = {
  devices: new Map(),
};

// Lazy injection to avoid a circular dep with connect.js.
let _onDisconnectedById = () => {};
export function setDisconnectHandler(fn) { _onDisconnectedById = fn; }

export function persist() {
  const out = [];
  for (const e of state.devices.values()) {
    out.push({
      id: e.id, name: e.name, fwType: e.fwType || null,
      // Intent signal: true when the user's last explicit wish was to be connected,
      // false when they clicked Disconnect. Unexpected drops leave it unchanged.
      autoReconnect: !!e.autoReconnect,
      lastConnectedAt: e.lastConnectedAt || 0,
    });
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
}

export function loadKnown() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}

export function makeEntry(id, name, fwType = null, { autoReconnect = false, lastConnectedAt = 0 } = {}) {
  return {
    id, name,
    // Platform label shown as a badge on the card. Cached from fw-info.type
    // on first connect so the badge survives disconnects / page reloads.
    fwType,
    autoReconnect,
    lastConnectedAt,
    device: null,
    status: "idle",
    ledChar: null, ledOn: false,
    wifiScanChar: null, wifiJoinChar: null, wifiStatusChar: null,
    wifiStatus: { st: "idle" }, wifiNetworks: null, wifiScanning: false,
    otaDataChar: null, otaStatusChar: null, otaStatus: { st: "idle" }, fwInfo: null,
    // Motors fields (motorsChar, motorsLeft/Right, motorsSending, motorsPending)
    // are assigned by the signed-pair runtime's initEntry() on connect.
    cameraSignalChar: null, cameraStatusChar: null,
    cameraPc: null, cameraStream: null,
    cameraRecvBuf: null, cameraStatus: null,
    lastEvent: null,
    capSchema: null,
    runtimeCaps: [],
    // Top-level "what is this robot doing" — populated from robot-status char
    // when present. Held after disconnect (as stickyStatus) so a drop that
    // followed 'rebooting' renders as "was rebooting", not a mystery.
    robotStatus: null,
    stickyStatus: null,
    stickyStatusTimer: null,
    // Periodic vitals from the telemetry char. null = robot doesn't publish.
    telemetry: null,
    // Chunked decoder state for ops-response; populated during connect.
    opsRespBuf: null,
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
