const STORAGE_KEY = "better-robotics:known";
const ROBOTS_KEY  = "better-robotics:robots";

// state.devices is the BLE-peer layer (one entry per paired BluetoothDevice,
// holds its characteristics, current cap state, DOM node, etc.). state.robots
// is the new logical-grouping layer added in Pass 1 of working.md item F:
// each robot has members[] of device IDs, so an ESP32-eye + Pi-brain combo
// renders as one card while still pairing as two BLE peers under the hood.
//
// Single-device robots (the existing universe) auto-migrate: each device
// becomes a one-member robot whose id == deviceId. New robots get fresh
// UUIDs once the user explicitly merges two paired devices.
export const state = {
  devices: new Map(),
  robots:  new Map(),  // robotId -> { id, name, members: [deviceId, ...] }
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
  persistRobots();
}

function persistRobots() {
  const out = [];
  for (const r of state.robots.values()) {
    out.push({
      id: r.id, name: r.name, members: r.members.slice(),
      // capSourcePrefs: when both members of a composite robot declare the
      // same cap (e.g., both have "motors"), this map's deviceId for that
      // cap name wins over the default first-member-wins. Empty for the
      // common case (no overlap, or default is fine).
      capSourcePrefs: { ...(r.capSourcePrefs || {}) },
    });
  }
  localStorage.setItem(ROBOTS_KEY, JSON.stringify(out));
}

export function loadKnown() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}

// Hydrate state.robots from localStorage (or migrate). Idempotent — calling
// twice is a no-op. Auto-migration: any paired device that isn't already a
// member of some robot becomes a one-member robot named after itself.
// Pre-F users see no UX change — every robot still has exactly one member.
export function loadRobots() {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(ROBOTS_KEY) || "[]"); }
  catch { raw = []; }
  state.robots.clear();
  const claimed = new Set();
  for (const r of raw) {
    const members = (r.members || []).filter(m => typeof m === "string");
    const capSourcePrefs = (r.capSourcePrefs && typeof r.capSourcePrefs === "object")
      ? { ...r.capSourcePrefs } : {};
    state.robots.set(r.id, { id: r.id, name: r.name || r.id, members, capSourcePrefs });
    for (const m of members) claimed.add(m);
  }
  // Wrap any unclaimed paired devices as one-member robots. Uses the device
  // id as the robot id so existing localStorage URLs / dashboards / replay
  // records (anything keyed by id) keep resolving without a fixup pass.
  for (const d of loadKnown()) {
    if (claimed.has(d.id)) continue;
    state.robots.set(d.id, { id: d.id, name: d.name || d.id, members: [d.id], capSourcePrefs: {} });
  }
  persistRobots();
}

// Set or clear the preferred member for a given cap on a robot. Used by
// the cap-section's swap action when a composite robot has overlap caps
// and the user picked a non-default source.
export function setCapSourcePref(robotId, capName, deviceId) {
  const r = state.robots.get(robotId);
  if (!r) return null;
  if (!r.capSourcePrefs) r.capSourcePrefs = {};
  if (deviceId == null) delete r.capSourcePrefs[capName];
  else r.capSourcePrefs[capName] = deviceId;
  persistRobots();
  return r;
}

// Look up the robot a given device belongs to. Used by the renderer to
// decide which card a per-device event (BLE notify, cap state change)
// should attribute to.
export function robotFor(deviceId) {
  for (const r of state.robots.values()) {
    if (r.members.includes(deviceId)) return r;
  }
  return null;
}

// Combine two robots into one. The destination keeps its id + name + any
// capSourcePrefs it had; the source's members merge into destination's
// members[]; the source robot is removed. Source's capSourcePrefs are
// dropped (they referenced a robot that no longer exists; the user can
// re-pick any conflicts post-merge via the cap-section swap action).
export function mergeRobots(srcId, destId) {
  if (srcId === destId) return state.robots.get(destId) || null;
  const src  = state.robots.get(srcId);
  const dest = state.robots.get(destId);
  if (!src || !dest) return null;
  for (const m of src.members) {
    if (!dest.members.includes(m)) dest.members.push(m);
  }
  state.robots.delete(srcId);
  persistRobots();
  return dest;
}

// Split a member out of its current robot into a new one-member robot.
// Mirror of mergeRobots — user might compose then decompose. Returns the
// new robot, or null if the member wasn't found.
export function splitMember(deviceId) {
  for (const r of state.robots.values()) {
    const i = r.members.indexOf(deviceId);
    if (i < 0) continue;
    if (r.members.length === 1) return r;  // already standalone
    r.members.splice(i, 1);
    const fresh = { id: deviceId, name: deviceId, members: [deviceId] };
    const device = state.devices.get(deviceId);
    if (device) fresh.name = device.name;
    state.robots.set(fresh.id, fresh);
    persistRobots();
    return fresh;
  }
  return null;
}

// Rename a robot. Names are user-meaningful only — no ID semantics, so
// renaming doesn't affect localStorage keys or BLE pairings.
export function renameRobot(robotId, name) {
  const r = state.robots.get(robotId);
  if (!r) return null;
  r.name = name;
  persistRobots();
  return r;
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
  // New paired device → auto-create a one-member robot. The user can later
  // merge it into an existing robot via the menu (working.md item F).
  if (!robotFor(device.id)) {
    state.robots.set(device.id, {
      id: device.id, name: device.name || device.id, members: [device.id],
      capSourcePrefs: {},
    });
  }
  persist();
  return entry;
}
