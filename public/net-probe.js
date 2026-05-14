// Unilateral WebRTC network probe + shared ICE-candidate parsing. Opens an
// RTCPeerConnection purely as a network diagnostic — no signaling, no peer.
// What the browser learns during candidate gathering reveals whether outbound
// STUN reaches its server (srflx candidate present), the device's public IP,
// and what NAT shape the network presents — independent of any pair attempt.
//
// Why it exists: pair failures look identical in the dialog ("waiting for
// phone…") whether the network is healthy or hostile. A unilateral probe is
// a cheap independent answer to "is this network's outbound UDP/STUN even
// working" before opening a real pair.

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];
const DEFAULT_TIMEOUT_MS = 2000;

// SDP candidate line shape:
//   candidate:<foundation> <component> <proto> <pri> <addr> <port> typ <type> [...]
// We accept either an RTCIceCandidate-like object (has .type/.address) or a
// raw wire-format JSON {candidate, sdpMid, sdpMLineIndex} where only the
// SDP string is reliably populated.
export function parseCandidate(c) {
  if (!c) return null;
  const sdp = c.candidate || "";
  if (!sdp) return null;
  let type = c.type || null;
  let address = c.address || null;
  let port = c.port || null;
  let protocol = c.protocol || null;
  const m = /\btyp\s+(\S+)/.exec(sdp);
  if (m && !type) type = m[1];
  const parts = sdp.split(/\s+/);
  if (parts.length >= 6) {
    if (!protocol) protocol = parts[2];
    if (!address)  address  = parts[4];
    if (!port)     port     = Number(parts[5]) || null;
  }
  return { type, address, port, protocol, sdp };
}

export async function probeNetwork({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const startedAt = performance.now();
  const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  // Data channel must exist before createOffer or no candidates gather.
  pc.createDataChannel("probe");
  const candidates = [];
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  pc.addEventListener("icecandidate", (e) => {
    if (e.candidate && e.candidate.candidate) {
      const parsed = parseCandidate(e.candidate);
      if (parsed) candidates.push(parsed);
    } else {
      resolveDone();  // null/empty candidate = gathering complete
    }
  });
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
  } catch (err) {
    try { pc.close(); } catch {}
    return {
      ok: false,
      error: String((err && err.message) || err),
      durationMs: performance.now() - startedAt,
      candidates: [],
      candidateTypes: [],
      stunReachable: false,
      publicIp: null,
      mdnsObfuscated: false,
    };
  }
  await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs))]);
  try { pc.close(); } catch {}
  const types = [...new Set(candidates.map((c) => c.type).filter(Boolean))];
  const srflx = candidates.find((c) => c.type === "srflx");
  // Chrome obfuscates host candidates as <hash>.local mDNS unless the page
  // has explicit host-candidate permission; flag it so consumers know
  // local-IP is not visible.
  const mdnsObfuscated = candidates.some((c) => c.type === "host" && /\.local$/i.test(c.address || ""));
  return {
    ok: true,
    candidateTypes: types,
    stunReachable: types.includes("srflx"),
    publicIp: srflx ? srflx.address : null,
    mdnsObfuscated,
    durationMs: performance.now() - startedAt,
    candidates,
  };
}

let _last = null;
export function lastNetProbe() { return _last; }

// Per-server reachability + latency. Runs one short probe per iceServers
// entry so per-server outcome is attributable — answers "I can reach Google
// STUN but Cloudflare's TURN is unreachable" vs the aggregate yes/no that
// probeNetwork() returns. Latency = time from setLocalDescription to the
// first non-host candidate (srflx for STUN, relay for TURN), the moment
// the server's role is functionally fulfilled.
export async function probeIceReachability(iceServers, { timeoutMs = 2500 } = {}) {
  const out = [];
  for (const server of iceServers || []) {
    const ts = performance.now();
    const pc = new RTCPeerConnection({ iceServers: [server] });
    pc.createDataChannel("probe");
    const candidates = [];
    let firstHitMs = null;
    const done = new Promise((resolve) => {
      pc.addEventListener("icecandidate", (e) => {
        if (!e.candidate) return resolve();
        const p = parseCandidate(e.candidate);
        if (!p) return;
        candidates.push(p);
        if (firstHitMs === null && (p.type === "srflx" || p.type === "relay")) {
          firstHitMs = Math.round(performance.now() - ts);
        }
      });
    });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs))]);
    } catch { /* gather failure is captured below as reachable=false */ }
    try { pc.close(); } catch {}
    const types = [...new Set(candidates.map((c) => c.type).filter(Boolean))];
    out.push({
      urls: server.urls,
      reachable: firstHitMs !== null,
      latencyMs: firstHitMs,
      types,
    });
  }
  return out;
}

if (typeof window !== "undefined") {
  window.probeNetwork = async (opts) => {
    _last = await probeNetwork(opts);
    return _last;
  };
  window.lastNetProbe = lastNetProbe;
  window.probeIceReachability = probeIceReachability;
}
