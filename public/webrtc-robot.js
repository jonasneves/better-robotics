// Browser ↔ robot WebRTC peer manager.
//
// Two signaling transports, chosen at openChannel time:
//
//  1. BLE-signaling (preferred when signalChar is present): chunked SDP
//     write to SIGNAL_CHAR_UUID; chunked answer back via notify on the
//     same char. ICE then runs P2P on the LAN — no internet rendezvous,
//     no Mixed-Content / PNA exposure. The robot is already authenticated
//     via the BLE pairing.
//
//  2. wss://signal.neevs.io fallback: the original path. Used when
//     signalChar isn't available (older firmware, or cross-network
//     pairing where BLE isn't reachable).
//
// Wire format on the SIGNAL char (both directions, mirrors OTA/snapshot):
//   0x01 [u16 BE total]   begin
//   0x02 [bytes]          chunk (≤ 100 B payload, fits any plausible MTU)
//   0x03                  commit
//   0xFF [utf8 msg]       error (notify-only)

import { SIGNAL_WS_URL, fetchIceServers, makePeerId } from "./pairing.js";

const ICE_TIMEOUT_MS = 30000;
const BLE_SIG_CHUNK  = 100;

// Per-platform room prefix + accepted-peer prefix for the wss fallback.
// Pi rtc daemon presents as "desktop-<id>"; ESP32 as "esp32-<id>".
const ROBOT_ROOM_CONFIG = {
  pi:    { roomPrefix: "pi-rtc-",    accept: "desktop-" },
  esp32: { roomPrefix: "esp32-rtc-", accept: "esp32-" },
};
function configFor(robotType) {
  return ROBOT_ROOM_CONFIG[robotType] || ROBOT_ROOM_CONFIG.pi;
}

// Per-robot peer connections, lazy-built. Keyed by robot id.
const _peers = new Map();  // robotId → { pc, ws?, channels: Map<label, ch> }

// Open (or replace) a peer connection to the robot, ensure a DataChannel
// with the requested label is open, return the channel. Single-PC model
// per robot — opening a second time tears the prior peer down.
//
// opts:
//   robotType:   "pi" | "esp32"   — picks wss room shape if BLE absent
//   signalChar:  BluetoothRemoteGATTCharacteristic — if present, BLE path
//   onStatus:    (msg) => void    — progress messages for UI
//
// Selector: try BLE-signaling when signalChar is present. On any failure
// (handshake timeout, char write rejected, BLE disconnect mid-flight),
// fall through to wss. The wss path is the last-resort relay for
// cross-network access; rolling out 2.F.1 means the BLE path covers the
// daily LAN flow but transient BLE issues don't strand the operator.
export async function openChannel(robotId, robotName, label, opts = {}) {
  const { signalChar, onStatus = () => {} } = opts;
  if (signalChar) {
    try {
      return await openChannelViaBLE(robotId, label, signalChar, opts);
    } catch (err) {
      onStatus(`BLE signaling failed (${err.message}); trying signal.neevs.io…`);
      console.warn("[webrtc-robot] BLE signaling failed, falling back to wss:", err);
      // Fall through to wss. closePeer(robotId) was already called inside
      // openChannelViaBLE on its way out, so wss starts from a clean slate.
    }
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

  const channel = pc.createDataChannel(label, { ordered: true });
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
    // libpeer's create_answer hardcodes the data-channel mid as
    // "datachannel" (sdp.c:75) and the BUNDLE group as "datachannel"
    // (sdp.c:103). Browsers auto-assign mids ("0", "1", ...). Without
    // patching, Chrome's setRemoteDescription rejects libpeer's answer
    // with "The order of m-lines in answer doesn't match order in offer"
    // because the mids differ. Rewriting our offer to use libpeer's
    // expected mid up-front makes both sides consistent.
    offer.sdp = patchOfferForLibpeer(offer.sdp);
    await pc.setLocalDescription(offer);

    // Non-trickle ICE: wait for gathering to complete so the SDP carries
    // every candidate inline. Bounded — if mDNS / private candidates
    // hang, we ship what we have after 3 s rather than stalling forever.
    await waitForIceGathering(pc, 3000);

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

// Match libpeer's hardcoded mid for the data channel m-section. Single
// m-line per session in our use (one data channel per peer), so a
// straight rename is enough; multi-channel peers will need a richer
// patch keyed off m=application sections individually.
function patchOfferForLibpeer(sdp) {
  const midMatch = sdp.match(/^a=mid:(\S+)$/m);
  if (!midMatch) return sdp;
  const browserMid = midMatch[1];
  if (browserMid === "datachannel") return sdp;  // already matches
  return sdp
    .replaceAll(`a=mid:${browserMid}`, "a=mid:datachannel")
    .replaceAll(`BUNDLE ${browserMid}`, "BUNDLE datachannel");
}

async function sendChunked(char, bytes) {
  const total = bytes.length;
  if (total === 0 || total > 0xFFFF) {
    throw new Error(`offer size out of range: ${total}`);
  }
  const begin = new Uint8Array(3);
  begin[0] = 0x01;
  begin[1] = (total >> 8) & 0xff;
  begin[2] = total & 0xff;
  await char.writeValueWithResponse(begin);
  for (let off = 0; off < total; off += BLE_SIG_CHUNK) {
    const take = Math.min(BLE_SIG_CHUNK, total - off);
    const buf = new Uint8Array(1 + take);
    buf[0] = 0x02;
    buf.set(bytes.subarray(off, off + take), 1);
    await char.writeValueWithResponse(buf);
  }
  await char.writeValueWithResponse(new Uint8Array([0x03]));
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

// ── wss://signal.neevs.io fallback path ─────────────────────────────────

async function openChannelViaWss(robotId, robotName, label, opts) {
  const { onStatus = () => {}, robotType = "pi" } = opts;
  closePeer(robotId);

  const myPeerId = makePeerId("dashboard");
  const cfg = configFor(robotType);
  const roomId = `${cfg.roomPrefix}${robotName}`;
  onStatus("Opening signal channel…");
  const iceServers = await fetchIceServers();
  const pc = new RTCPeerConnection({ iceServers });
  const ws = new WebSocket(`${SIGNAL_WS_URL}/${roomId}/ws`);
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

  const channel = pc.createDataChannel(label, { ordered: true });
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
      fail(new Error(`Couldn't reach the robot's WebRTC peer within 30 s. Is ${robotType === "esp32" ? "the ESP32" : "pi-robot-rtc.service"} running?`));
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
        // Same libpeer mid patch as the BLE path. Both signaling
        // transports drive the same libpeer build on the chip.
        offer.sdp = patchOfferForLibpeer(offer.sdp);
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
