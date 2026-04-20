// Generic two-browser WebRTC pairing against signal.neevs.io — opaque JSON
// relay, one-hour room TTL, no auth (room IDs are unguessable capabilities).
// Desktop calls hostPairingRoom() and hands the resulting URL to a phone via
// QR; phone calls joinPairingRoom(id). Both sides end up with a Peer that
// wraps an RTCDataChannel with a simple send/onMessage/onClose surface.
//
// Signal protocol (see ~/Github/jonasneves/signal/API.md):
//   connect wss://signal.neevs.io/{room}/ws
//   send   { type: "signal", peer: myRole, data: { offer|answer|ice } }
//   recv   { type: "state",  peers: {...} }
//          { type: "signal", peer: theirRole, data: {...} }
const SIGNAL_WS_URL = "wss://signal.neevs.io";
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// Thin wrapper over RTCDataChannel: JSON framing + close observability.
class Peer {
  constructor(pc, channel) {
    this._pc = pc;
    this._channel = channel;
    this._onMessage = () => {};
    this._onClose = () => {};
    channel.addEventListener("message", (e) => {
      try { this._onMessage(JSON.parse(e.data)); }
      catch { /* drop malformed frames */ }
    });
    const dispatchClose = () => this._onClose();
    channel.addEventListener("close", dispatchClose);
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        dispatchClose();
      }
    });
  }
  send(obj) {
    if (this._channel.readyState !== "open") return;
    try { this._channel.send(JSON.stringify(obj)); } catch { /* closing */ }
  }
  onMessage(cb) { this._onMessage = cb; }
  onClose(cb)   { this._onClose = cb; }
  close() {
    try { this._channel.close(); } catch {}
    try { this._pc.close(); } catch {}
  }
}

function openSignalWs(roomId) {
  return new WebSocket(`${SIGNAL_WS_URL}/${roomId}/ws`);
}

function wireIceTrickle(pc, ws, myRole) {
  pc.addEventListener("icecandidate", (e) => {
    if (e.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "signal", peer: myRole, data: { ice: e.candidate } }));
    }
  });
}

// Desktop side: fresh room, create offer once the phone shows up in the room
// state. Returns { roomId, waitForPeer: () => Promise<Peer> }.
export function hostPairingRoom() {
  const roomId = crypto.randomUUID();
  const myRole = "desktop";
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = pc.createDataChannel("pip");
  const ws = openSignalWs(roomId);
  wireIceTrickle(pc, ws, myRole);

  let offerSent = false;
  const peerPromise = new Promise((resolve, reject) => {
    const fail = (err) => { ws.close(); pc.close(); reject(err); };

    ws.addEventListener("message", async (e) => {
      const msg = JSON.parse(e.data);
      // Phone joining causes the room state to list a non-desktop peer — kick
      // the offer at that moment so the phone has a remote description ready
      // by the time it sends its answer.
      if (msg.type === "state" && !offerSent
          && Object.keys(msg.peers || {}).some(r => r !== myRole)) {
        offerSent = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: "signal", peer: myRole, data: { offer } }));
      }
      if (msg.type === "signal" && msg.peer !== myRole) {
        if (msg.data?.answer) await pc.setRemoteDescription(msg.data.answer);
        if (msg.data?.ice)   { try { await pc.addIceCandidate(msg.data.ice); } catch {} }
      }
    });

    ws.addEventListener("error", () => fail(new Error("signal socket failed")));

    channel.addEventListener("open", () => {
      ws.close();  // signaling done once the data channel is up
      resolve(new Peer(pc, channel));
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") fail(new Error("WebRTC connection failed"));
    });
  });

  return {
    roomId,
    waitForPeer: () => peerPromise,
    cancel: () => { ws.close(); pc.close(); },
  };
}

// Phone side: join an existing room, answer the desktop's offer, return the
// data channel via ondatachannel.
export function joinPairingRoom(roomId) {
  const myRole = "phone";
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const ws = openSignalWs(roomId);
  wireIceTrickle(pc, ws, myRole);

  return new Promise((resolve, reject) => {
    const fail = (err) => { ws.close(); pc.close(); reject(err); };

    pc.addEventListener("datachannel", (e) => {
      e.channel.addEventListener("open", () => {
        ws.close();
        resolve(new Peer(pc, e.channel));
      });
    });

    ws.addEventListener("message", async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "signal" && msg.peer !== myRole) {
        if (msg.data?.offer) {
          await pc.setRemoteDescription(msg.data.offer);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(JSON.stringify({ type: "signal", peer: myRole, data: { answer } }));
        }
        if (msg.data?.ice) { try { await pc.addIceCandidate(msg.data.ice); } catch {} }
      }
    });

    ws.addEventListener("error", () => fail(new Error("signal socket failed")));
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") fail(new Error("WebRTC connection failed"));
    });
  });
}
