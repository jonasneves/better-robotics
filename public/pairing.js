// Two-browser WebRTC pairing against signal.neevs.io with catwatcher-style
// resilience — the signaling WebSocket stays open for the life of the
// session, carries ICE trickles both ways, and survives transient drops
// via ICE restart instead of a fresh pair flow. Only a hard failure
// (channel closed and ICE restart didn't recover within the grace window)
// counts as "disconnected, rescan QR".
//
// Signal protocol (~/Github/jonasneves/signal/src/server/room.js):
//   connect wss://signal.neevs.io/{room}/ws
//   send   { type: "signal", peer: myPeerId, data: { offer|answer|ice } }
//   recv   { type: "state",  peers: { peerId: lastSignal } }  // once, on connect
//          { type: "signal", peer: theirPeerId, data: {...} }
//
// Protocol roles: phone is OFFERER (joins second, has something to offer),
// desktop is ANSWERER. peerId = role + "-" + nonce so re-scanning the QR
// or leaving a stale tab open doesn't collide with a fresh session under a
// fixed role key. The server's `state` snapshot is how late-joiners recover
// a signal sent before they arrived; we apply it only when we're not
// already on a healthy connection.
const SIGNAL_WS_URL = "wss://signal.neevs.io";
// proxy.neevs.io mints short-lived Cloudflare Realtime TURN creds. STUN
// servers stay in-line as a zero-roundtrip fallback so a degraded proxy
// (offline, rate-limited, mis-deployed) still gives us STUN-only pairing
// instead of nothing.
const TURN_ENDPOINT = "https://proxy.neevs.io/cloudflare/turn";
const STUN_FALLBACK = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

async function fetchIceServers() {
  try {
    const r = await fetch(TURN_ENDPOINT, { method: "POST" });
    if (!r.ok) throw new Error(`turn: ${r.status}`);
    const { iceServers } = await r.json();
    dbg("turn: fetched", iceServers.length, "server(s)");
    return [...STUN_FALLBACK, ...iceServers];
  } catch (err) {
    dbg("turn: fetch failed, STUN-only", err.message || err);
    return STUN_FALLBACK;
  }
}
const HEARTBEAT_MS = 20000;   // Cloudflare closes idle WebSockets ~100s; ping well below that.
const DISCONNECT_GRACE_MS = 10000;  // Transient ICE `disconnected` can recover on its own.
// Backpressure: DataChannel.bufferedAmount grows unbounded if we outrun the
// peer. Text/joypad traffic is tiny so we rarely get near this; the queue is
// insurance for whoever later ships camera frames or audio chunks over the
// same channel. Queue drops oldest at QUEUE_MAX so a wedged receiver doesn't
// OOM the sender.
const BACKPRESSURE_HIGH = 1_000_000;
const BACKPRESSURE_LOW  =   200_000;
const QUEUE_MAX = 1000;
// 30s is for ICE negotiation specifically — the post-offer handshake between
// desktop and phone. We deliberately do NOT time the pre-offer wait (user
// picking up phone, unlocking, scanning the QR) because that easily exceeds
// 30s for normal humans and isn't a real failure. Pre-offer wait stays open
// as long as the dialog is — cleanup happens on dialog close.
const ICE_TIMEOUT_MS = 30000;

// Verbose transition logging, opt-in via ?debug or #debug in the URL. When
// set, dbg() mirrors to both console and any subscribed sinks (the floating
// in-page panel, so phones can diagnose without remote DevTools).
export const DEBUG = typeof location !== "undefined" && /\bdebug\b/.test((location.search || "") + (location.hash || ""));
const _logSinks = new Set();
export function onDebugLog(fn) { _logSinks.add(fn); return () => _logSinks.delete(fn); }

function dbg(...args) {
  if (!DEBUG) return;
  try { console.log("[pairing]", performance.now().toFixed(0) + "ms", ...args); } catch {}
  if (!_logSinks.size) return;
  const ts = new Date().toISOString().slice(11, 23);
  const msg = args.map(x => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ");
  for (const fn of _logSinks) { try { fn(`${ts} ${msg}`); } catch {} }
}

// Auto-install a floating log panel when ?debug is set so phone-side issues
// are diagnosable without remote DevTools. Pointer-events: none lets the
// user tap through it. Module side-effect on purpose — nothing to remember
// to wire up from callers.
if (DEBUG && typeof document !== "undefined") {
  const install = () => {
    if (document.getElementById("__pairing_debug_panel")) return;
    const panel = document.createElement("pre");
    panel.id = "__pairing_debug_panel";
    panel.style.cssText = "position:fixed;right:8px;bottom:8px;max-width:60vw;max-height:40vh;overflow:auto;margin:0;padding:8px;font:11px ui-monospace,monospace;background:rgba(0,0,0,0.85);color:#8f8;z-index:99999;border-radius:4px;white-space:pre-wrap;pointer-events:none;";
    document.body.appendChild(panel);
    onDebugLog((line) => {
      panel.textContent += line + "\n";
      panel.scrollTop = panel.scrollHeight;
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
}

function makePeerId(role) {
  return role + "-" + Math.random().toString(36).slice(2, 8);
}

// Exports for callers that build their own room flow on top of the same
// signal.neevs.io infrastructure (e.g. webrtc-robot.js for shell channels).
export { SIGNAL_WS_URL, fetchIceServers, makePeerId };

// State snapshots can carry stale entries from prior sessions. Apply only
// semantic-describe (offer/answer); ICE candidates tied to a dead pc would
// be rejected anyway. Filter to the opposite role's prefix so our own stale
// entries from a previous tab don't echo back into this session.
function extractFromState(peers, selfPeerId, otherRolePrefix) {
  const out = [];
  for (const k of Object.keys(peers || {})) {
    if (k === selfPeerId) continue;
    if (!k.startsWith(otherRolePrefix + "-")) continue;
    const d = peers[k];
    if (d && (d.offer || d.answer)) out.push(d);
  }
  return out;
}

// Peer — JSON-framed data channel wrapper with a multi-state status channel
// so UI can show connecting / connected / reconnecting / failed accurately.
class Peer {
  constructor({ pc, channel, ws, myPeerId, otherRolePrefix, roomId }) {
    this._pc = pc;
    this._channel = channel;
    this._ws = ws;
    this._myPeerId = myPeerId;
    this._otherRolePrefix = otherRolePrefix;
    // roomId lets us reopen the signaling WS when iOS backgrounds the tab
    // and silently kills it — we rejoin the same room instead of a fresh pair.
    this._roomId = roomId;
    this._onMessage = () => {};
    this._onStatus = () => {};
    this._onClose = () => {};
    this._status = "connected";
    this._graceTimer = null;
    this._heartbeatTimer = null;
    this._sendQueue = [];
    this._reopening = false;
    this._visibilityHandler = null;

    channel.bufferedAmountLowThreshold = BACKPRESSURE_LOW;
    channel.addEventListener("bufferedamountlow", () => this._drainQueue());
    channel.addEventListener("message", (e) => {
      try { this._onMessage(JSON.parse(e.data)); } catch { /* drop malformed */ }
    });
    channel.addEventListener("close", () => {
      // Data channel gone is terminal — can't recover without rebuilding PC.
      this._setStatus("failed", "Data channel closed");
      this._finalClose();
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") {
        if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
        this._setStatus("connected");
      } else if (s === "disconnected") {
        // Often recovers on its own (e.g. phone tab re-foregrounded). Wait.
        this._setStatus("reconnecting", "Connection dropped, waiting…");
        if (!this._graceTimer) {
          this._graceTimer = setTimeout(() => {
            this._graceTimer = null;
            if (pc.iceConnectionState === "disconnected") {
              // Still stuck — ask WebRTC to rebuild the path.
              this._attemptIceRestart();
            }
          }, DISCONNECT_GRACE_MS);
        }
      } else if (s === "failed") {
        this._setStatus("reconnecting", "Restarting connection…");
        this._attemptIceRestart();
      }
    });

    // Media-track plumbing. Either side may addTrack; negotiationneeded
    // fires, _renegotiate offers, the other side answers via the existing
    // _applySignal offer handler (which rolls back if it catches itself
    // mid-negotiation). Glare is bounded by _negotiating + signalingState
    // guards. Not full Perfect Negotiation but sufficient for sequential
    // addTrack flows (the common case: one side shares, the other receives).
    this._onTrack = null;
    this._pendingTracks = [];
    this._negotiating = false;
    // Buffer track events that arrive before the consumer wires onTrack —
    // happens when desktop initiates a renegotiation immediately after the
    // channel opens, before phone.js has its handlers attached.
    pc.addEventListener("track", (e) => {
      if (this._onTrack) { try { this._onTrack(e); } catch {} }
      else this._pendingTracks.push(e);
    });
    pc.addEventListener("negotiationneeded", () => this._renegotiate());

    this._startHeartbeat();
    this._installSignalHandlers();
    this._installVisibilityRecovery();
  }

  async _renegotiate() {
    // Either role may initiate a media-add renegotiation. The _negotiating
    // flag + stable-signalingState check keep us from offering on top of
    // an in-flight negotiation; _applySignal's rollback handles the rare
    // glare case where both sides offer simultaneously.
    if (this._negotiating) return;
    if (this._pc.signalingState !== "stable") return;
    this._negotiating = true;
    try {
      const offer = await this._pc.createOffer();
      await this._pc.setLocalDescription(offer);
      this._ws.send(JSON.stringify({ type: "signal", peer: this._myPeerId, data: { offer } }));
    } catch (err) {
      console.warn("[pair] renegotiate failed", err);
    } finally {
      this._negotiating = false;
    }
  }

  _setStatus(status, detail) {
    if (this._status === status) return;
    this._status = status;
    try { this._onStatus(status, detail); } catch {}
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      if (this._ws.readyState === WebSocket.OPEN) {
        try { this._ws.send(JSON.stringify({ type: "ping" })); } catch {}
      }
    }, HEARTBEAT_MS);
  }

  _isConnected() {
    const s = this._pc.iceConnectionState;
    return s === "connected" || s === "completed";
  }

  // Only the phone (offerer) initiates an ICE restart. Desktop sits and waits
  // for the fresh offer — its existing signal handler will set the remote
  // description and answer, same as initial negotiation.
  async _attemptIceRestart() {
    if (!this._myPeerId.startsWith("phone-")) return;
    try {
      this._pc.restartIce();
      const offer = await this._pc.createOffer({ iceRestart: true });
      await this._pc.setLocalDescription(offer);
      this._ws.send(JSON.stringify({ type: "signal", peer: this._myPeerId, data: { offer } }));
    } catch (err) {
      // If restart itself fails, mark failed and let the caller rebuild.
      this._setStatus("failed", `Restart failed: ${err.message || err}`);
      this._finalClose();
    }
  }

  // Signals after data channel is up — subsequent offer/answer rounds for
  // ICE restart, and late-arriving ICE candidates. Handles `state` too for
  // the case where a visibility-recovery WS reopen picks up an offer that
  // arrived while we were backgrounded.
  _installSignalHandlers() {
    this._ws.addEventListener("message", async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "signal") {
        if (msg.peer === this._myPeerId) return;
        await this._applySignal(msg.data);
      } else if (msg.type === "state") {
        // Healthy connection → skip. Replaying an old offer on a working pc
        // would tear it down. We only want state during initial connect and
        // during active reconnect.
        if (this._isConnected()) { dbg("peer state skipped (already connected)"); return; }
        for (const d of extractFromState(msg.peers, this._myPeerId, this._otherRolePrefix)) {
          await this._applySignal(d);
        }
      }
    });
  }

  async _applySignal(data) {
    if (!data) return;
    try {
      if (data.offer) {
        // If we're mid-negotiation (phone sent a rapid-fire ICE-restart
        // before our prior answer made it through), rollback to stable so
        // setRemoteDescription doesn't InvalidStateError. Safe on already-
        // stable pc; try/catch because rollback on "stable" itself throws
        // on some UAs.
        if (this._pc.signalingState !== "stable") {
          try { await this._pc.setLocalDescription({ type: "rollback" }); } catch {}
        }
        await this._pc.setRemoteDescription(data.offer);
        const answer = await this._pc.createAnswer();
        await this._pc.setLocalDescription(answer);
        this._ws.send(JSON.stringify({ type: "signal", peer: this._myPeerId, data: { answer } }));
      }
      if (data.answer) await this._pc.setRemoteDescription(data.answer);
      if (data.ice)    { try { await this._pc.addIceCandidate(data.ice); } catch {} }
    } catch (err) {
      dbg("peer signal error", err.message || err);
    }
  }

  // iOS Safari kills idle WebSockets when the tab backgrounds; even a 20s
  // heartbeat can't save it. When the tab comes back, the data channel may
  // still negotiate but the signal WS is gone, so any ICE restart we try
  // sends into the void. Rejoin the same room first, rewire handlers, then
  // kick an ICE restart — gets us from "frozen" to recovered in ~1s instead
  // of waiting for the eventual ICE failure timeout.
  _installVisibilityRecovery() {
    if (typeof document === "undefined") return;
    this._visibilityHandler = () => {
      if (document.visibilityState !== "visible") return;
      const s = this._ws.readyState;
      if (s === WebSocket.OPEN || s === WebSocket.CONNECTING) return;
      if (this._reopening) return;
      this._reopenSignal();
    };
    document.addEventListener("visibilitychange", this._visibilityHandler);
  }

  _reopenSignal() {
    this._reopening = true;
    this._setStatus("reconnecting", "Signal channel dropped, reopening…");
    const newWs = openSignalWs(this._roomId);
    newWs.addEventListener("open", () => {
      const oldWs = this._ws;
      this._ws = newWs;
      this._installSignalHandlers();
      // ICE-trickle handler on the PC uses this._ws via the closure in
      // wireIceTrickle — old handler still exists but its captured ws is
      // closed, so its send() guard (readyState === OPEN) skips. Harmless
      // extra listener; avoids an awkward removeEventListener dance.
      wireIceTrickle(this._pc, this._ws, this._myPeerId);
      try { oldWs.close(); } catch {}
      this._reopening = false;
      this._attemptIceRestart();
    });
    newWs.addEventListener("error", () => {
      this._reopening = false;
      this._setStatus("failed", "Signal reconnect failed");
      this._finalClose();
    });
  }

  _drainQueue() {
    while (this._sendQueue.length > 0
           && this._channel.readyState === "open"
           && this._channel.bufferedAmount < BACKPRESSURE_HIGH) {
      try { this._channel.send(this._sendQueue.shift()); } catch { break; }
    }
  }

  _finalClose() {
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this._visibilityHandler) {
      document.removeEventListener("visibilitychange", this._visibilityHandler);
      this._visibilityHandler = null;
    }
    try { this._ws.close(); } catch {}
    try { this._onClose(); } catch {}
  }

  send(obj) {
    if (this._channel.readyState !== "open") return;
    const payload = JSON.stringify(obj);
    // Queue if we're above the high-water mark OR the queue is already
    // draining — draining in order matters, so never jump the line.
    if (this._channel.bufferedAmount > BACKPRESSURE_HIGH || this._sendQueue.length > 0) {
      if (this._sendQueue.length >= QUEUE_MAX) this._sendQueue.shift();
      this._sendQueue.push(payload);
      return;
    }
    try { this._channel.send(payload); } catch {}
  }
  onMessage(cb) { this._onMessage = cb; }
  onStatus(cb)  { this._onStatus = cb; try { cb(this._status); } catch {} }  // fire initial
  onClose(cb)   { this._onClose = cb; }
  onTrack(cb)   {
    this._onTrack = cb;
    if (this._pendingTracks.length) {
      const queued = this._pendingTracks;
      this._pendingTracks = [];
      for (const e of queued) { try { cb(e); } catch {} }
    }
  }
  // addTrack returns the RTCRtpSender so caller can later removeTrack(sender).
  // Triggers negotiationneeded → _renegotiate. Caller does not await.
  addTrack(track, stream) {
    if (this._pc.signalingState === "closed") return null;
    return this._pc.addTrack(track, stream);
  }
  removeTrack(sender) {
    if (!sender || this._pc.signalingState === "closed") return;
    try { this._pc.removeTrack(sender); } catch {}
  }
  close() {
    this._setStatus("failed", "Closed by caller");
    this._finalClose();
    try { this._channel.close(); } catch {}
    try { this._pc.close(); } catch {}
  }
}

function openSignalWs(roomId) {
  return new WebSocket(`${SIGNAL_WS_URL}/${roomId}/ws`);
}

// Adapter that exposes a WebSocket-shaped surface backed by a lobby
// (e.g. ble-mailbox.js or signal-sdk's discover). Lets pairing.js's
// existing WebSocket-coupled code path carry WebRTC SDP/ICE through
// the BLE-mailbox lobby — same flow, different transport.
//
// Maps:
//   send(text)   → lobby.publish(unique-id, {app:'pairing-signal',
//                  room, peer, data}) — only "signal" type messages;
//                  pings/state are dropped (lobby pubsub doesn't need
//                  keepalives, and the chip's ring serves as a small
//                  state replay automatically).
//   onmessage    ← lobby.onChange filtered by app+room, excluding
//                  ourselves; reshaped into {type:'signal', peer, data}
//                  to match server.js's wire format.
//
// readyState is set OPEN on the next microtask so listeners registered
// synchronously after construction (wireIceTrickle, addEventListener
// "open") still fire before any messages dispatch.
class LobbySignalChannel {
  constructor({ lobby, roomId, myPeerId }) {
    this._lobby = lobby;
    this._roomId = roomId;
    this._myPeerId = myPeerId;
    this._messageHandlers = new Set();
    this._openHandlers = new Set();
    this._closeHandlers = new Set();
    this._closed = false;
    this.readyState = 0; // CONNECTING
    this._unsub = lobby.onChange((ads) => {
      if (this._closed) return;
      for (const ad of ads) {
        const d = ad.data;
        if (!d || d.app !== 'pairing-signal') continue;
        if (d.room !== roomId) continue;
        if (d.peer === myPeerId) continue;
        const wsMsg = JSON.stringify({ type: 'signal', peer: d.peer, data: d.data });
        // Microtask defer so consumers that addEventListener after
        // construction still receive everything in order.
        Promise.resolve().then(() => {
          if (this._closed) return;
          for (const fn of this._messageHandlers) {
            try { fn({ data: wsMsg }); } catch {}
          }
        });
      }
    });
    Promise.resolve().then(() => {
      if (this._closed) return;
      this.readyState = 1; // OPEN
      for (const fn of this._openHandlers) { try { fn({}); } catch {} }
    });
  }
  send(text) {
    if (this._closed || this.readyState !== 1) return;
    let msg; try { msg = JSON.parse(text); } catch { return; }
    if (msg.type !== 'signal') return;  // pings/state — drop
    const id = `pairing-signal:${this._roomId}:${this._myPeerId}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this._lobby.publish(id, {
      app: 'pairing-signal',
      room: this._roomId,
      peer: this._myPeerId,
      data: msg.data,
    }, 30000);
  }
  close() {
    if (this._closed) return;
    this._closed = true;
    this.readyState = 3; // CLOSED
    if (this._unsub) try { this._unsub(); } catch {}
    Promise.resolve().then(() => {
      for (const fn of this._closeHandlers) { try { fn({}); } catch {} }
    });
  }
  addEventListener(event, fn) {
    if (event === 'message') this._messageHandlers.add(fn);
    else if (event === 'close') this._closeHandlers.add(fn);
    else if (event === 'open') {
      this._openHandlers.add(fn);
      if (this.readyState === 1) Promise.resolve().then(() => { if (!this._closed) try { fn({}); } catch {} });
    }
    // 'error' isn't synthesized — lobby drops on close, not on transient failures
  }
  removeEventListener(event, fn) {
    if (event === 'message') this._messageHandlers.delete(fn);
    else if (event === 'close') this._closeHandlers.delete(fn);
    else if (event === 'open') this._openHandlers.delete(fn);
  }
}
export { LobbySignalChannel };

function wireIceTrickle(pc, ws, myPeerId) {
  pc.addEventListener("icecandidate", (e) => {
    if (e.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "signal", peer: myPeerId, data: { ice: e.candidate } }));
    }
  });
}

// Desktop: opens the room, waits for the phone's offer, answers.
// Returns { roomId, waitForPeer: () => Promise<Peer>, cancel() }.
// onStatus fires at pre-Peer stages ("phone connected, negotiating…",
// "establishing channel…") so the pair dialog can show distinct states
// instead of a frozen "waiting for phone" when something's silently wedged.
export async function hostPairingRoom({ onStatus = () => {}, extraLobbies = [] } = {}) {
  const roomId = crypto.randomUUID();
  const myPeerId = makePeerId("desktop");
  const otherRolePrefix = "phone";
  dbg("desktop: opening room", roomId, "peerId=", myPeerId);
  const iceServers = await fetchIceServers();
  const pc = new RTCPeerConnection({ iceServers });
  // wss is the always-on default channel — covers iPhone (no Web BT)
  // and any cross-network peer. Each extra lobby (Phase 2.F.2 BLE-mailbox
  // is the first) adds a parallel signaling path; whichever transport
  // delivers the offer becomes the active channel for the rest of the
  // negotiation. Same room, same peerIds, same wire format.
  const ws = openSignalWs(roomId);
  const channels = [ws];
  for (const lobby of extraLobbies) {
    channels.push(new LobbySignalChannel({ lobby, roomId, myPeerId }));
  }
  // Until the offer arrives we don't know which transport the phone is
  // on. Trickle ICE goes through every channel; the phone receives one
  // copy and ignores the rest (peer-id filter handles dedupe at the
  // application layer; addIceCandidate is idempotent on duplicates).
  pc.addEventListener("icecandidate", (e) => {
    if (!e.candidate) return;
    const text = JSON.stringify({ type: "signal", peer: myPeerId, data: { ice: e.candidate } });
    for (const ch of channels) {
      if (ch.readyState === 1 /* OPEN */) { try { ch.send(text); } catch {} }
    }
  });
  let resolvePeer, rejectPeer;
  const peerPromise = new Promise((res, rej) => { resolvePeer = res; rejectPeer = rej; });
  let resolved = false;
  const pendingIce = [];
  // Once the phone's offer arrives, this is the channel we commit to —
  // answer + post-handshake renegotiation/ICE-restart all flow through
  // it, and we close the others so they don't burn battery.
  let activeChannel = null;

  let timeoutId = null;
  const armIceTimeout = () => {
    if (timeoutId) return;
    timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      dbg("desktop: ICE timeout");
      for (const ch of channels) { try { ch.close(); } catch {} }
      try { pc.close(); } catch {}
      rejectPeer(new Error("Phone connected but couldn't establish a peer-to-peer link within 30s. Network may be blocking WebRTC."));
    }, ICE_TIMEOUT_MS);
  };

  ws.addEventListener("open",  () => dbg("desktop ws: open"));
  ws.addEventListener("close", () => dbg("desktop ws: close"));
  pc.addEventListener("iceconnectionstatechange", () => dbg("desktop ice", pc.iceConnectionState));
  pc.addEventListener("connectionstatechange",    () => dbg("desktop pc",  pc.connectionState));

  pc.addEventListener("datachannel", (e) => {
    dbg("desktop: ondatachannel");
    try { onStatus("Phone connected, establishing channel…"); } catch {}
    e.channel.addEventListener("open", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      dbg("desktop: channel open, resolving peer");
      resolvePeer(new Peer({ pc, channel: e.channel, ws: activeChannel || ws, myPeerId, otherRolePrefix, roomId }));
    });
  });

  const applySignal = async (data, sourceChannel) => {
    if (!data) return;
    if (data.offer) {
      dbg("desktop: offer received via", sourceChannel === ws ? "wss" : "lobby");
      try { onStatus("Phone connected, negotiating…"); } catch {}
      // Commit to whichever transport delivered the offer. Close the
      // others so they stop accepting ads from a different (stray) phone
      // that might also be on the lobby.
      activeChannel = sourceChannel;
      for (const ch of channels) {
        if (ch !== activeChannel) { try { ch.close(); } catch {} }
      }
      armIceTimeout();
      await pc.setRemoteDescription(data.offer);
      for (const c of pendingIce) { try { await pc.addIceCandidate(c); } catch {} }
      pendingIce.length = 0;
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      activeChannel.send(JSON.stringify({ type: "signal", peer: myPeerId, data: { answer } }));
      dbg("desktop: answer sent");
    }
    if (data.ice) {
      if (pc.remoteDescription) { try { await pc.addIceCandidate(data.ice); } catch {} }
      else pendingIce.push(data.ice);
    }
  };

  for (const ch of channels) {
    ch.addEventListener("message", async (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "signal") {
        if (msg.peer === myPeerId) return;
        if (msg.peer && msg.peer.startsWith("desktop-")) return;
        await applySignal(msg.data, ch);
      } else if (msg.type === "state") {
        for (const d of extractFromState(msg.peers, myPeerId, otherRolePrefix)) {
          dbg("desktop: replaying state entry");
          await applySignal(d, ch);
        }
      }
    });
  }

  // wss-specific failure surfacing — extra lobbies don't fail loudly
  // (they degrade silently to "no offer received"), but the wss path is
  // worth distinguishing so the user knows whether to fix internet vs
  // BLE proximity.
  ws.addEventListener("error", () => {
    if (!resolved && channels.length === 1) {
      // wss-only host (no extra lobbies): a wss error means total signaling failure.
      resolved = true;
      clearTimeout(timeoutId);
      pc.close();
      rejectPeer(new Error(
        "Couldn't reach the pairing server (signal.neevs.io). " +
        "Check your network — captive portals, strict firewalls, " +
        "and some carrier hotspots block WebSocket connections.",
      ));
    }
  });

  return {
    roomId,
    waitForPeer: () => peerPromise,
    cancel: () => {
      clearTimeout(timeoutId);
      for (const ch of channels) { try { ch.close(); } catch {} }
      pc.close();
    },
  };
}

// Phone: joins the room, creates data channel + offer on WS open, processes answer.
// onStatus fires at each negotiation stage ("opening signal channel…",
// "offer sent, waiting…", etc.) so phone.js can surface exactly where the
// pair is — instead of a single "connecting…" blob that hides every stall.
export async function joinPairingRoom(roomId, { onStatus = () => {}, lobby = null } = {}) {
  const myPeerId = makePeerId("phone");
  const otherRolePrefix = "desktop";
  dbg("phone: joining room", roomId, "peerId=", myPeerId, "via=", lobby ? "lobby" : "wss");
  try { onStatus("Opening signal channel…"); } catch {}
  const iceServers = await fetchIceServers();
  const pc = new RTCPeerConnection({ iceServers });
  const channel = pc.createDataChannel("pip");
  // When the caller hands us a lobby, route signaling through that
  // instead of opening signal.neevs.io. Same wire format on both —
  // LobbySignalChannel mimics enough WebSocket API that the rest of
  // this function doesn't care which transport is underneath.
  const ws = lobby
    ? new LobbySignalChannel({ lobby, roomId, myPeerId })
    : openSignalWs(roomId);
  wireIceTrickle(pc, ws, myPeerId);

  ws.addEventListener("close", () => dbg("phone ws: close"));
  pc.addEventListener("connectionstatechange", () => dbg("phone pc", pc.connectionState));
  pc.addEventListener("iceconnectionstatechange", () => {
    const s = pc.iceConnectionState;
    dbg("phone ice", s);
    if (s === "checking") { try { onStatus("Finding network path…"); } catch {} }
    else if (s === "connected" || s === "completed") { try { onStatus("Network path ready, opening channel…"); } catch {} }
  });

  return new Promise((resolve, reject) => {
    let resolved = false;
    let timeoutId;
    const pendingIce = [];
    const fail = (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      try { ws.close(); } catch {}
      try { pc.close(); } catch {}
      reject(err);
    };

    // Phone-side ICE timer — page is already loaded by the time we get here,
    // so this measures negotiation only (no human reaction time included).
    timeoutId = setTimeout(() => {
      dbg("phone: ICE timeout");
      fail(new Error("Couldn't reach the desktop within 30s — try refreshing the QR there."));
    }, ICE_TIMEOUT_MS);

    channel.addEventListener("open", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      dbg("phone: channel open, resolving peer");
      resolve(new Peer({ pc, channel, ws, myPeerId, otherRolePrefix, roomId }));
    });

    const applySignal = async (data) => {
      if (!data) return;
      if (data.answer) {
        dbg("phone: answer received");
        try { onStatus("Desktop answered. Negotiating…"); } catch {}
        await pc.setRemoteDescription(data.answer);
        for (const c of pendingIce) { try { await pc.addIceCandidate(c); } catch {} }
        pendingIce.length = 0;
      }
      if (data.ice) {
        if (pc.remoteDescription) { try { await pc.addIceCandidate(data.ice); } catch {} }
        else pendingIce.push(data.ice);
      }
    };

    ws.addEventListener("open", async () => {
      dbg("phone ws: open");
      try {
        try { onStatus("Signal channel open. Creating offer…"); } catch {}
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: "signal", peer: myPeerId, data: { offer } }));
        try { onStatus("Offer sent. Waiting for desktop…"); } catch {}
      } catch (err) { fail(err); }
    });

    ws.addEventListener("message", async (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "signal") {
        if (msg.peer === myPeerId) return;
        if (msg.peer && msg.peer.startsWith("phone-")) return;
        await applySignal(msg.data);
      } else if (msg.type === "state") {
        for (const d of extractFromState(msg.peers, myPeerId, otherRolePrefix)) {
          dbg("phone: replaying state entry");
          await applySignal(d);
        }
      }
    });

    ws.addEventListener("error", () => fail(new Error("Signal channel failed. Check your internet and try again.")));
    pc.addEventListener("connectionstatechange", () => {
      // Only fail the INITIAL connect this way; once Peer is constructed,
      // its own iceconnectionstatechange handler owns lifecycle.
      if (!resolved && pc.connectionState === "failed") fail(new Error("Couldn't reach the desktop's network. Check both devices are online."));
    });
  });
}
