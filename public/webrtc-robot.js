// All robot WebRTC signaling rides BLE — chunked SDP on the SIGNAL char.
// ESP32 handles signaling in-firmware; Pi forwards the offer to a local
// aiortc daemon over a Unix socket and notifies the answer back. Either
// way, no internet rendezvous — pair = signal.
//
// Wire format on the SIGNAL char (both directions, mirrors OTA/snapshot):
//   0x01 [u16 BE total]                       offer begin
//   0x02 [bytes]                              offer chunk (≤ 100 B payload)
//   0x03                                      offer commit
//   0x04 [u16 BE total]                       ice-servers begin
//   0x05 [bytes]                              ice-servers chunk
//   0x06                                      ice-servers commit
//   0x07 [u16 BE cert_len][u16 BE key_len]   cert+key begin (5 bytes)
//   0x08 [bytes]                              cert+key chunk (cert PEM then key PEM)
//   0x09                                      cert+key commit
//   0xFF [utf8 msg]                           error (notify-only)
//
// The cert push is dashboard→chip only; the chip falls back to its own
// ECDSA self-sign if no cert arrives before dtls_srtp_init. See
// webrtc-cert.js for the keygen + self-sign and the matching firmware
// handler in webrtc_peer.c / dtls_srtp_supply_cert.

import { fetchIceServers } from "./pairing.js";
import { generateSessionCert } from "./webrtc-cert.js";

// 90s. ESP32 + libpeer's ICE pairing is sequential — each candidate pair
// tested with STUN connectivity checks + retries, no parallelism. With
// 5-6 candidate pairs to walk through (host/srflx/relay × both sides),
// reaching "connected" routinely takes 50-60s even on a healthy LAN.
// Saw the chip log "pc state: connected" 1s after the previous 60s
// timeout fired — barely too tight. Pi/aiortc completes ICE in ~2-3s,
// so the headroom only matters for the ESP32 failure-message UX.
const ICE_TIMEOUT_MS = 90000;
const BLE_SIG_CHUNK  = 100;

// Per-robot peer connections, lazy-built. Keyed by robot id.
const _peers = new Map();  // robotId → { pc, channels: Map<label, ch> }

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
//   robotType:   "pi" | "esp32"   — only used to skip the ICE-servers
//                                   push (ESP32 needs it; Pi resolves
//                                   its own servers in pi_robot_rtc.py)
//   signalChar:  BluetoothRemoteGATTCharacteristic — required
//   onStatus:    (msg) => void    — progress messages for UI
//
// BLE pair = signal. If signalChar is missing, the robot's firmware is
// too old to support this — surface that directly rather than falling
// back to a backend the user may not even have access to.
export async function openChannel(robotId, robotName, label, opts = {}) {
  const { signalChar } = opts;
  if (!signalChar) {
    throw new Error("WebRTC signaling needs a BLE signal characteristic — pair the robot first, or update its firmware");
  }
  return openChannelViaBLE(robotId, label, signalChar, opts);
}

// ── BLE signaling path ──────────────────────────────────────────────────

async function openChannelViaBLE(robotId, label, signalChar, opts) {
  const { onStatus = () => {}, robotType } = opts;
  closePeer(robotId);

  onStatus("Opening peer over BLE…");
  // STUN-only is fine — for LAN both peers' local candidates are enough;
  // STUN as fallback covers any in-house NAT segments.
  const iceServers = await fetchIceServers();
  const pc = new RTCPeerConnection({ iceServers });
  const entry = { pc, channels: new Map() };
  _peers.set(robotId, entry);

  // Per-label DC reliability. Video is unreliable+unordered — frames are
  // independent, a lost chunk means the next frame supersedes it anyway,
  // and SCTP head-of-line on a retransmit stalls the whole stream waiting
  // for a chunk we'd throw away. The chip's reassembly already drops
  // partial frames whose frame_id is older than a newer one in flight.
  //
  // Every other label is a byte stream (ota: firmware image, future:
  // log tail, PTY) where a single dropped or reordered chunk corrupts
  // the result. Those get SCTP's default ordered+reliable behavior.
  const dcOpts = label === "video"
    ? { ordered: false, maxRetransmits: 0 }
    : {};
  const channel = pc.createDataChannel(label, dcOpts);
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
      const raw = new TextDecoder().decode(merged);
      // ESP32 quirk-rewrite: libpeer's binary blob always emits
      // a=setup:passive even though we forced DTLS_SRTP_ROLE_CLIENT
      // in dtls_srtp_init. Chrome needs the SDP setup attr to match
      // what's actually on the wire, so flip it here before
      // setRemoteDescription. Used to live in chip-side
      // rewrite_answer_mid; moved to dashboard to keep all chip-quirk
      // knowledge in one place (here) instead of split across firmware.
      answerResolve(robotType === "esp32" ? answerSetupActive(raw) : raw);
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
    await pc.setLocalDescription(offer);

    // Non-trickle ICE: wait for gathering to complete so the SDP carries
    // every candidate inline. Bounded — if mDNS / private candidates
    // hang, we ship what we have after 3 s rather than stalling forever.
    await waitForIceGathering(pc, 3000);

    // ESP32 needs the ICE-server list pushed in (browser-as-brain: resolve
    // hostnames + flatten before sending — chip skips DNS + HTTPS entirely,
    // saved ~6 s of "Fail to resolve server address" stalls on
    // iCloud-Private-Relay-style networks). Pi fetches its own ICE servers
    // in pi_robot_rtc.py and accepts only opcodes 0x01-0x03 on this char.
    if (robotType === "esp32") {
      // Cert+key first: chip's dtls_srtp_init refuses to open WebRTC
      // without a supplied cert (chip-gen fallback removed to claim the
      // mbedTLS x509write code-size savings). Push before the offer so
      // the cache is filled when esp_peer_open warms DTLS up.
      onStatus("Sending session cert…");
      const { certPem, keyPem } = await generateSessionCert();
      await sendCertKey(signalChar, certPem, keyPem);
      onStatus("Sending ICE servers…");
      const chipIce = await iceServersForChip(iceServers);
      const iceBytes = new TextEncoder().encode(JSON.stringify({ ice: chipIce }));
      await sendChunkedOp(signalChar, iceBytes, 0x04, 0x05, 0x06);
    }

    onStatus("Writing offer over BLE…");
    // ESP32 quirk-rewrite: strip TCP candidates (chip is UDP-only) and
    // pin MID to "0" so libpeer's hardcoded "0" in the answer matches
    // without a chip-side rewrite. Both used to live in chip-side
    // filter_sdp_for_chip + capture_offer_mid + rewrite_answer_mid;
    // now centralized here.
    const chipSdp = robotType === "esp32"
      ? offerStripTcpAndPinMid(pc.localDescription.sdp)
      : pc.localDescription.sdp;
    const sdpBytes = new TextEncoder().encode(chipSdp);
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

// Strip a=candidate lines with transport=tcp (chip's UDP-only ICE
// stack would reject TCP cands anyway, no point burning chunks shipping
// them), and force MID="0" on both the BUNDLE group and m-line so
// libpeer's hardcoded answer MID matches without a chip-side rewrite.
// Returns the rewritten SDP. Chip-only; the Pi path takes raw SDP.
function offerStripTcpAndPinMid(sdp) {
  const lines = sdp.split(/\r?\n/);
  const out = [];
  let dropped = 0;
  for (const line of lines) {
    if (line.startsWith("a=candidate:")) {
      // candidate-attribute fields: candidate:foundation component
      // transport priority address port type ... — transport is field 3.
      const parts = line.slice(12).split(" ");
      if (parts[2] && parts[2].toLowerCase() === "tcp") { dropped++; continue; }
    }
    if (line.startsWith("a=group:BUNDLE ")) { out.push("a=group:BUNDLE 0"); continue; }
    if (line.startsWith("a=mid:"))           { out.push("a=mid:0"); continue; }
    out.push(line);
  }
  return out.join("\r\n");
}

// libpeer's binary blob emits setup:passive regardless of the chip's
// actual on-wire role. The chip is DTLS_SRTP_ROLE_CLIENT (forced in
// dtls_srtp_init), so the answer must say setup:active or Chrome's
// DTLS state machine rejects with role mismatch.
function answerSetupActive(sdp) {
  return sdp.replace(/a=setup:passive/g, "a=setup:active");
}

async function sendChunked(char, bytes) {
  return sendChunkedOp(char, bytes, 0x01, 0x02, 0x03);
}

// Cert+key has a custom begin (5 bytes: opcode + two u16 BE lengths)
// instead of the shared 3-byte begin used by SDP/ICE. Chunk/commit
// opcodes are still in the 0x08/0x09 pair so sendChunkedOp's inner loop
// applies after we hand-roll the begin frame.
async function sendCertKey(char, certPem, keyPem) {
  const certLen = certPem.length;
  const keyLen  = keyPem.length;
  if (certLen === 0 || keyLen === 0 || certLen > 0xFFFF || keyLen > 0xFFFF) {
    throw new Error(`cert/key sizes out of range: ${certLen}/${keyLen}`);
  }
  const begin = new Uint8Array(5);
  begin[0] = 0x07;
  begin[1] = (certLen >> 8) & 0xff; begin[2] = certLen & 0xff;
  begin[3] = (keyLen  >> 8) & 0xff; begin[4] = keyLen  & 0xff;
  await char.writeValueWithResponse(begin);
  // Chip expects cert_pem bytes immediately followed by key_pem bytes,
  // totaling cert_len + key_len. Concatenate then chunk.
  const merged = new Uint8Array(certLen + keyLen);
  merged.set(certPem, 0);
  merged.set(keyPem, certLen);
  for (let off = 0; off < merged.length; off += BLE_SIG_CHUNK) {
    const take = Math.min(BLE_SIG_CHUNK, merged.length - off);
    const buf = new Uint8Array(1 + take);
    buf[0] = 0x08;
    buf.set(merged.subarray(off, off + take), 1);
    await char.writeValueWithResponse(buf);
  }
  await char.writeValueWithResponse(new Uint8Array([0x09]));
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

export function closePeer(robotId) {
  const entry = _peers.get(robotId);
  if (!entry) return;
  for (const ch of entry.channels.values()) try { ch.close(); } catch {}
  try { entry.pc?.close(); } catch {}
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
