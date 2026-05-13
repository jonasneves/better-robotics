// ESP32 has no fallback signaling path — BLE pair is the precondition
// for using the dashboard at all, so signaling rides BLE only. (Pi
// uses wss because aiortc handles WebSocket trivially.)
//
// Wire format on the SIGNAL char (both directions, mirrors OTA/snapshot):
//   0x01 [u16 BE total]   begin
//   0x02 [bytes]          chunk (≤ 100 B payload, fits any plausible MTU)
//   0x03                  commit
//   0xFF [utf8 msg]       error (notify-only)

import { fetchIceServers, makePeerId } from "./pairing.js";
import { SIGNAL_WS } from "./endpoints.js";

// 90s. ESP32 + libpeer's ICE pairing is sequential — each candidate pair
// tested with STUN connectivity checks + retries, no parallelism. With
// 5-6 candidate pairs to walk through (host/srflx/relay × both sides),
// reaching "connected" routinely takes 50-60s even on a healthy LAN.
// Saw the chip log "pc state: connected" 1s after the previous 60s
// timeout fired — barely too tight. Pi/aiortc completes ICE in ~2-3s,
// so the headroom only matters for the ESP32 failure-message UX.
const ICE_TIMEOUT_MS = 90000;
const BLE_SIG_CHUNK  = 100;

// wss-path peer-id prefixes. Pi rtc daemon presents as "desktop-<id>".
const PI_WSS_CONFIG = { roomPrefix: "pi-rtc-", accept: "desktop-" };

// Per-robot peer connections, lazy-built. Keyed by robot id.
const _peers = new Map();  // robotId → { pc, ws?, channels: Map<label, ch> }

// PCs owned by other modules (e.g. webrtc-installable's Pi camera path)
// that want to appear in lastRobotWebRTCDiagnostic alongside the channels
// _peers tracks. Keyed by `${robotId}::${label}`.
const _externalPeers = new Map();
export function registerExternalPc(robotId, label, pc) {
  _externalPeers.set(`${robotId}::${label}`, { robotId, label, pc });
}
export function unregisterExternalPc(robotId, label) {
  _externalPeers.delete(`${robotId}::${label}`);
}

// Open (or replace) a peer connection to the robot, ensure a DataChannel
// with the requested label is open, return the channel. Single-PC model
// per robot — opening a second time tears the prior peer down.
//
// opts:
//   robotType:   "pi" | "esp32"   — picks the signaling path
//   signalChar:  BluetoothRemoteGATTCharacteristic — required for ESP32
//   onStatus:    (msg) => void    — progress messages for UI
//
// Selector by robot type: ESP32 uses BLE-signaling (signalChar required);
// Pi uses wss. No fallback — if BLE fails on ESP32, surface it directly
// so the operator knows the BLE link is the problem, not signaling.
export async function openChannel(robotId, robotName, label, opts = {}) {
  const { signalChar, robotType } = opts;
  if (robotType === "esp32") {
    if (!signalChar) throw new Error("ESP32 needs a BLE signal char — pair the robot first");
    return openChannelViaBLE(robotId, label, signalChar, opts);
  }
  return openChannelViaWss(robotId, robotName, label, opts);
}

// ── BLE signaling path ──────────────────────────────────────────────────

async function openChannelViaBLE(robotId, label, signalChar, opts) {
  const { onStatus = () => {} } = opts;
  closePeer(robotId);

  onStatus("Opening peer over BLE…");
  // STUN-only is fine — for LAN both peers' local candidates are enough;
  // STUN as fallback covers any in-house NAT segments.
  const iceServers = await fetchIceServers();
  const pc = new RTCPeerConnection({ iceServers });
  const entry = { pc, channels: new Map() };
  _peers.set(robotId, entry);

  // Unreliable + unordered — video frames are independent; a lost chunk
  // means the chip's next frame supersedes it anyway. Ordered/reliable
  // channels stall the whole stream waiting for retransmits we'd throw
  // away. The chip's reassembly already drops partial frames whose
  // frame_id is older than a newer one in flight.
  const channel = pc.createDataChannel(label, { ordered: false, maxRetransmits: 0 });
  entry.channels.set(label, channel);

  // Listener for chunked answer notify. Installed before we send the
  // offer so we can't miss a fast reply.
  let answerResolve, answerReject;
  const answerPromise = new Promise((resolve, reject) => {
    answerResolve = resolve;
    answerReject = reject;
  });
  let total = 0, received = 0;
  const chunks = [];
  const onSignal = (e) => {
    const data = new Uint8Array(e.target.value.buffer);
    if (data.length === 0) return;
    const op = data[0];
    if (op === 0x01) {
      if (data.length < 3) return;
      total = (data[1] << 8) | data[2];
      received = 0;
      chunks.length = 0;
    } else if (op === 0x02) {
      chunks.push(data.subarray(1));
      received += data.length - 1;
    } else if (op === 0x03) {
      signalChar.removeEventListener("characteristicvaluechanged", onSignal);
      if (received !== total) {
        answerReject(new Error(`answer size mismatch ${received}/${total}`));
        return;
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }
      answerResolve(new TextDecoder().decode(merged));
    } else if (op === 0xFF) {
      signalChar.removeEventListener("characteristicvaluechanged", onSignal);
      const msg = new TextDecoder().decode(data.subarray(1));
      answerReject(new Error(`signaling: ${msg}`));
    }
  };
  signalChar.addEventListener("characteristicvaluechanged", onSignal);

  try {
    onStatus("Generating offer…");
    const offer = await pc.createOffer();
    // No MID rewrite here — esp_peer always emits MID="0" in its answer,
    // and chip-side webrtc_peer.c rewrites the answer's BUNDLE/mid back
    // to the offer's MID before forwarding over BLE.
    await pc.setLocalDescription(offer);

    // Non-trickle ICE: wait for gathering to complete so the SDP carries
    // every candidate inline. Bounded — if mDNS / private candidates
    // hang, we ship what we have after 3 s rather than stalling forever.
    await waitForIceGathering(pc, 3000);

    // Browser-as-brain: resolve hostnames + flatten the ICE-server list
    // and push it to the chip before the offer. Chip skips DNS + HTTPS
    // entirely — saved ~6 s of "Fail to resolve server address" stalls
    // on iCloud-Private-Relay-style networks.
    onStatus("Sending ICE servers…");
    const chipIce = await iceServersForChip(iceServers);
    const iceBytes = new TextEncoder().encode(JSON.stringify({ ice: chipIce }));
    await sendChunkedOp(signalChar, iceBytes, 0x04, 0x05, 0x06);

    onStatus("Writing offer over BLE…");
    const sdpBytes = new TextEncoder().encode(pc.localDescription.sdp);
    await sendChunked(signalChar, sdpBytes);

    onStatus("Waiting for answer…");
    const answerSdp = await Promise.race([
      answerPromise,
      timeoutAfter(ICE_TIMEOUT_MS, "BLE signaling timeout"),
    ]);

    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    onStatus("Answer received, opening channel…");

    return await openWhenReady(channel, robotId);
  } catch (err) {
    closePeer(robotId);
    signalChar.removeEventListener("characteristicvaluechanged", onSignal);
    throw err;
  }
}

async function sendChunked(char, bytes) {
  return sendChunkedOp(char, bytes, 0x01, 0x02, 0x03);
}

async function sendChunkedOp(char, bytes, beginOp, chunkOp, commitOp) {
  const total = bytes.length;
  if (total === 0 || total > 0xFFFF) {
    throw new Error(`payload size out of range: ${total}`);
  }
  const begin = new Uint8Array(3);
  begin[0] = beginOp;
  begin[1] = (total >> 8) & 0xff;
  begin[2] = total & 0xff;
  await char.writeValueWithResponse(begin);
  for (let off = 0; off < total; off += BLE_SIG_CHUNK) {
    const take = Math.min(BLE_SIG_CHUNK, total - off);
    const buf = new Uint8Array(1 + take);
    buf[0] = chunkOp;
    buf.set(bytes.subarray(off, off + take), 1);
    await char.writeValueWithResponse(buf);
  }
  await char.writeValueWithResponse(new Uint8Array([commitOp]));
}

// DoH lookup via Cloudflare 1.1.1.1 — browser already has working DNS
// for the page itself but JS can't query records directly. Returns the
// host unchanged on failure (chip falls back to its own getaddrinfo).
async function resolveHostA(host) {
  if (/^[\d.]+$/.test(host)) return host;            // already an IPv4 literal
  try {
    const r = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`,
      { headers: { Accept: "application/dns-json" } });
    if (!r.ok) return host;
    const json = await r.json();
    const a = json.Answer?.find((x) => x.type === 1)?.data;
    return a || host;
  } catch { return host; }
}

// Flatten + resolve the ICE-server list for the chip. Drops TCP/TLS
// transports (chip is UDP-only), substitutes hostnames with A-record
// IPs, dedupes, and prefers TURN over STUN — TURN gives the chip both
// relay fallback and srflx discovery, and TURN at non-standard ports
// (Cloudflare exposes :53) routes through networks that block STUN's
// 19302/3478. Capped at 4 to match chip MAX_ICE_SERVERS.
async function iceServersForChip(iceServers) {
  const seen = new Set();
  const turn = [];
  const stun = [];
  for (const s of iceServers) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    for (const url of urls) {
      if (/transport=tcp/i.test(url)) continue;
      const m = url.match(/^(turns?|stuns?):([^:]+):(\d+)(.*)$/i);
      if (!m) continue;
      const proto = m[1].toLowerCase();
      if (proto === "stuns" || proto === "turns") continue;  // no DTLS to TURN on chip
      const ip = await resolveHostA(m[2]);
      const flatUrl = `${proto}:${ip}:${m[3]}${m[4]}`;
      if (seen.has(flatUrl)) continue;
      seen.add(flatUrl);
      const flat = { url: flatUrl };
      if (s.username && s.credential) {
        flat.user = s.username;
        flat.pass = s.credential;
      }
      (proto === "turn" ? turn : stun).push(flat);
    }
  }
  return [...turn.slice(0, 3), ...stun.slice(0, 1)];
}

function waitForIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", onChange);
        clearTimeout(timer);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, timeoutMs);
  });
}

function timeoutAfter(ms, msg) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
}

function openWhenReady(channel, robotId) {
  return new Promise((resolve, reject) => {
    if (channel.readyState === "open") return resolve(channel);
    let resolved = false;
    const fail = (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      closePeer(robotId);
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error("ICE timeout")), ICE_TIMEOUT_MS);
    channel.addEventListener("open", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(channel);
    });
    channel.addEventListener("error", (e) => fail(new Error(e.message || "channel error")));
  });
}

// ── wss://signal.neevs.io path (Pi only) ────────────────────────────────

async function openChannelViaWss(robotId, robotName, label, opts) {
  const { onStatus = () => {} } = opts;
  closePeer(robotId);

  const myPeerId = makePeerId("dashboard");
  const cfg = PI_WSS_CONFIG;
  const roomId = `${cfg.roomPrefix}${robotName}`;
  onStatus("Opening signal channel…");
  const iceServers = await fetchIceServers();
  const pc = new RTCPeerConnection({ iceServers });
  const ws = new WebSocket(`${SIGNAL_WS}/${roomId}/ws`);
  const entry = { pc, ws, channels: new Map() };
  _peers.set(robotId, entry);

  // Trickle ICE — every local candidate goes through the WS as it arrives.
  pc.addEventListener("icecandidate", (e) => {
    if (!e.candidate) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: "signal",
      peer: myPeerId,
      data: {
        ice: {
          candidate: e.candidate.candidate,
          sdpMid: e.candidate.sdpMid,
          sdpMLineIndex: e.candidate.sdpMLineIndex,
        },
      },
    }));
  });

  pc.addEventListener("iceconnectionstatechange", () => {
    const s = pc.iceConnectionState;
    if (s === "checking") onStatus("Finding network path…");
    else if (s === "connected" || s === "completed") onStatus("Path ready, opening channel…");
    else if (s === "failed" || s === "disconnected" || s === "closed") closePeer(robotId);
  });

  // Unreliable + unordered — video frames are independent; a lost chunk
  // means the chip's next frame supersedes it anyway. Ordered/reliable
  // channels stall the whole stream waiting for retransmits we'd throw
  // away. The chip's reassembly already drops partial frames whose
  // frame_id is older than a newer one in flight.
  const channel = pc.createDataChannel(label, { ordered: false, maxRetransmits: 0 });
  entry.channels.set(label, channel);

  return new Promise((resolve, reject) => {
    let resolved = false;
    const fail = (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      closePeer(robotId);
      reject(err);
    };
    const timer = setTimeout(() => {
      fail(new Error("Couldn't reach the robot's WebRTC peer within 90 s. Is pi-robot-rtc.service running?"));
    }, ICE_TIMEOUT_MS);

    channel.addEventListener("open", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(channel);
    });
    channel.addEventListener("error", (e) => fail(new Error(e.message || "channel error")));

    const pendingIce = [];
    const applySignal = async (data) => {
      if (!data) return;
      if (data.answer) {
        await pc.setRemoteDescription({ type: data.answer.type, sdp: data.answer.sdp });
        for (const c of pendingIce) { try { await pc.addIceCandidate(c); } catch {} }
        pendingIce.length = 0;
      }
      if (data.ice) {
        if (pc.remoteDescription) { try { await pc.addIceCandidate(data.ice); } catch {} }
        else pendingIce.push(data.ice);
      }
    };

    ws.addEventListener("open", async () => {
      onStatus("Signal channel open. Creating offer…");
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({
          type: "signal",
          peer: myPeerId,
          data: { offer: { type: offer.type, sdp: offer.sdp } },
        }));
        onStatus("Offer sent. Waiting for robot…");
      } catch (err) { fail(err); }
    });
    ws.addEventListener("message", async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type !== "signal") return;
      if (msg.peer === myPeerId) return;
      if (!String(msg.peer || "").startsWith(cfg.accept)) return;
      try { await applySignal(msg.data); } catch (err) { fail(err); }
    });
    ws.addEventListener("error", () => fail(new Error("Signal channel error")));
    ws.addEventListener("close", () => {
      if (!resolved) fail(new Error("Signal channel closed before peer connected"));
    });
  });
}

export function closePeer(robotId) {
  const entry = _peers.get(robotId);
  if (!entry) return;
  for (const ch of entry.channels.values()) try { ch.close(); } catch {}
  try { entry.pc?.close(); } catch {}
  try { entry.ws?.close(); } catch {}
  _peers.delete(robotId);
}

// DevTools / Diagnostics-dialog handle: snapshot every active robot
// peer connection's getStats() output. Tells you which candidate-pair
// won (look for type=candidate-pair, state=succeeded) so you can
// answer "host vs srflx vs relay" without chrome://webrtc-internals.
// Returns a Promise — DevTools auto-awaits.
if (typeof window !== "undefined") {
  window.lastRobotWebRTCDiagnostic = async () => {
    const out = [];
    for (const [robotId, entry] of _peers.entries()) {
      const row = {
        robotId,
        state: {
          iceConnection: entry.pc?.iceConnectionState,
          connection: entry.pc?.connectionState,
          signaling: entry.pc?.signalingState,
          iceGathering: entry.pc?.iceGatheringState,
        },
        channels: [...entry.channels.keys()],
      };
      try {
        const report = await entry.pc.getStats();
        const stats = [];
        report.forEach((s) => stats.push(s));
        row.stats = stats;
      } catch (err) {
        row.statsError = err.message || String(err);
      }
      out.push(row);
    }
    for (const { robotId, label, pc } of _externalPeers.values()) {
      const row = {
        robotId, label,
        state: {
          iceConnection: pc?.iceConnectionState,
          connection: pc?.connectionState,
          signaling: pc?.signalingState,
          iceGathering: pc?.iceGatheringState,
        },
      };
      try {
        const report = await pc.getStats();
        const stats = [];
        report.forEach((s) => stats.push(s));
        row.stats = stats;
      } catch (err) {
        row.statsError = err.message || String(err);
      }
      out.push(row);
    }
    return out;
  };
}
