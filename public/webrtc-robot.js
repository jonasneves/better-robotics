// Browser ↔ robot WebRTC peer manager.
//
// SDP signaling routes through wss://signal.neevs.io/<roomId>/ws — the same
// rendezvous phone-pair already uses. Pi-side daemon (pi_robot_rtc.py)
// joins the same room; offer/answer + ICE candidates trickle through the
// WebSocket. Data channel is P2P after handshake.
//
// Mixed-Content workaround: HTTPS dashboard fetching HTTP from a private
// IP is blocked by the browser before PNA preflight runs. Routing through
// HTTPS WebSocket sidesteps the gate entirely.
//
// Wire format mirrors pairing.js (the phone-pair flow):
//   client → server: { type: "signal", peer: "<myPeerId>", data: {...} }
//   server → client: same shape, broadcast to other peers in the room
// Room IDs are deterministic — `pi-rtc-<robotId>` — so the dashboard can
// find each robot without a separate discovery step.

import { SIGNAL_WS_URL, fetchIceServers, makePeerId } from "./pairing.js";

const ICE_TIMEOUT_MS = 30000;

// Per-robot peer connections, lazy-built. Keyed by robot id.
const _peers = new Map();  // robotId → { pc, ws, channels: Map<label, ch> }

// roomId derives from the robot's NAME (BR-XXXX), not its BLE device id.
// The Pi-side daemon computes the same name from /proc/cpuinfo, so both
// sides land in the same room without separate discovery.
function roomIdFor(robotName) { return `pi-rtc-${robotName}`; }

// Open (or reuse) a peer connection to the robot, then ensure a DataChannel
// with the requested label exists and is open. Resolves to the channel.
//
// Phase 1.A creates one PC per call (single-channel, fresh handshake each
// time). Multi-channel multiplexing — opening a second label on an existing
// PC — is a follow-up.
export async function openChannel(robotId, robotName, label, { onStatus = () => {} } = {}) {
  // Tear down any prior peer for this robot — single-PC model for now.
  closePeer(robotId);

  const myPeerId = makePeerId("dashboard");
  const roomId = roomIdFor(robotName);
  onStatus("Opening signal channel…");
  const iceServers = await fetchIceServers();
  const pc = new RTCPeerConnection({ iceServers });
  const ws = new WebSocket(`${SIGNAL_WS_URL}/${roomId}/ws`);
  const entry = { pc, ws, channels: new Map() };
  _peers.set(robotId, entry);

  // ICE trickle: every local candidate goes through the WS as it arrives.
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
      fail(new Error("Couldn't reach the robot's WebRTC peer within 30 s. Is pi-robot-rtc.service running?"));
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
      // Pi presents as desktop-<id> in the existing protocol shape.
      if (!String(msg.peer || "").startsWith("desktop-")) return;
      try { await applySignal(msg.data); } catch (err) { fail(err); }
    });
    ws.addEventListener("error", () => fail(new Error("Signal channel error")));
    ws.addEventListener("close", () => {
      // Channel may have already opened — don't fail if we got here past resolve.
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
