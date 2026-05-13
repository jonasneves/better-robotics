const STORAGE_KEY = "better-robotics:known";

export const state = {
  devices: new Map(),
};

// app.js registers its onDisconnected here. Late-bound to keep state.js
// free of any UI dependency.
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
      // ArUco marker ID bound to this robot. Null = unbound; detection falls
      // back to positional `entries[m.id]` so zero-config still works for
      // single-robot use. Manual binding via window.bindArucoMarker — see DEV.md.
      arucoMarkerId: typeof e.arucoMarkerId === "number" ? e.arucoMarkerId : null,
    });
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
}

export function loadKnown() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}

export function makeEntry(id, name, fwType = null, { autoReconnect = false, lastConnectedAt = 0, arucoMarkerId = null } = {}) {
  return {
    id, name,
    // Platform label shown as a badge on the card. Cached from fw-info.type
    // on first connect so the badge survives disconnects / page reloads.
    fwType,
    autoReconnect,
    lastConnectedAt,
    // ArUco marker assignment — see persist() comment. null = positional fallback.
    arucoMarkerId,
    // Latest overhead-camera pose. { x, y, headingDeg, markerSizeMm, updatedAt }
    // or null when no detection yet. Consumers MUST check updatedAt for
    // staleness before steering — producer never clears stale entries.
    arucoPosition: null,
    device: null,
    // Set when a cached gatt.connect() failed (typically after a robot reboot:
    // Chrome keeps the BluetoothDevice handle, but the bonded GATT session
    // can't be re-established without a fresh requestDevice). Causes the
    // button to render as "Re-pair" instead of "Connect", so the next click
    // hits the chooser path. Not persisted — fresh handles on page load
    // start with this false.
    staleHandle: false,
    status: "idle",
    ledChar: null, ledOn: false,
    wifiScanChar: null, wifiJoinChar: null, wifiStatusChar: null,
    wifiStatus: { st: "idle" }, wifiNetworks: null, wifiScanning: false,
    otaDataChar: null, otaStatusChar: null, otaStatus: { st: "idle" }, fwInfo: null,
    // Browser-side OTA-sent counter — bytes for which writeValueWithResponse
    // has resolved (≈ ATT_WRITE_RSP, which arrives only after the firmware's
    // onWrite callback returns). More accurate than otaStatus.n on active
    // uploads — that one's throttled (every 32 KB or 250 ms on ESP32). Lives
    // in-memory only; resets to 0 on page load. patchOtaSection picks the
    // higher of the two via Math.max so post-refresh display falls back to
    // firmware-reported.
    otaSent: 0,
    // Motors fields (motorsChar, motorsLeft/Right, motorsSending, motorsPending)
    // are assigned by the signed-pair runtime's initEntry() on connect.
    cameraSignalChar: null, cameraStatusChar: null,
    cameraPc: null, cameraStream: null,
    cameraRecvBuf: null, cameraStatus: null,
    // A paired phone's camera mounted on this robot (phone-as-eye). Set by
    // helpers.js's "Attach to robot" gesture; consumed by perception.js +
    // pip-tools so VLM/detector tools can reason over multiple cameras at
    // once. Cleared on detach or phone disconnect. attachedFromPhoneId is
    // the source phone's pairing roomId so detach can find it.
    attachedCameraStream: null,
    attachedFromPhoneId: null,
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
