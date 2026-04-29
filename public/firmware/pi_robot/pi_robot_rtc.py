#!/usr/bin/env python3
"""
pi-robot-rtc — WebRTC peer for one Pi.

Architecture: long-lived WebSocket to wss://signal.neevs.io/<roomId>/ws
(the same rendezvous phone-pair already uses), waits for an offer from the
dashboard, generates an answer via aiortc, completes ICE, then bridges any
opened DataChannel to a local handler. Phase 1.A handles one channel
("shell"): forks bash with a PTY and bridges stdin/stdout to the channel.

Why signal.neevs.io and not a local HTTP endpoint:
  Browser Mixed Content blocks https://neevs.io/... → http://<pi>:82/...
  before PNA preflight even runs. Routing SDP through wss:// (HTTPS) is
  the only option that doesn't require a per-Pi cert. The data channel
  is still P2P after handshake.

Protocol parity:
  Wire format matches pairing.js (the phone-pair flow). The Pi plays the
  "desktop" role (host, answerer); the dashboard plays the "phone" role
  (offerer). roomId is deterministic — `pi-rtc-<robotId>` — so the
  dashboard knows where to find each robot without separate signaling.
"""

import asyncio
import errno
import fcntl
import json
import logging
import os
import pty
import re
import signal
import struct
import sys
import termios

try:
    import aiohttp
    from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceCandidate
    from aiortc.contrib.signaling import object_from_string, object_to_string
except ImportError as e:
    sys.stderr.write(f"[rtc] missing dependency: {e}. Run `pip install aiortc aiohttp`.\n")
    sys.exit(2)

SIGNAL_WS_URL = "wss://signal.neevs.io"
LOG = logging.getLogger("rtc")


def device_name() -> str:
    """Match pi_robot_health._device_name() — BR-XXXX from /proc/cpuinfo serial."""
    suffix = None
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("Serial"):
                    suffix = line.split(":")[1].strip()[-4:].upper()
                    break
    except OSError:
        pass
    if not suffix:
        import socket
        suffix = socket.gethostname()[-4:].upper().ljust(4, "0")
    return f"BR-{suffix}"


def make_peer_id(role: str) -> str:
    """Mirrors pairing.js's makePeerId — `<role>-<6 hex>`."""
    return f"{role}-{os.urandom(3).hex()}"


# ── PTY bridge ────────────────────────────────────────────────────────────

class ShellBridge:
    """Forks bash under a PTY, pipes its stdout to a DataChannel, sends
    DataChannel messages to its stdin. Cleanly disposes on channel close
    or shell exit."""

    def __init__(self, channel, loop):
        self.channel = channel
        self.loop = loop
        self.master_fd = None
        self.pid = None
        self.task = None

    def start(self):
        pid, fd = pty.fork()
        if pid == 0:
            # Child: exec bash -i; inherits PTY slave as stdin/stdout/stderr
            os.execvp("bash", ["bash", "-i"])
            os._exit(127)
        self.pid = pid
        self.master_fd = fd
        # Set the master non-blocking so reads don't stall the loop
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        # Reasonable initial size; xterm.js will renegotiate via SIGWINCH
        # if we wire it later. For Phase 1.A leave at 80x24.
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ,
                        struct.pack("HHHH", 24, 80, 0, 0))
        except OSError:
            pass
        self.task = asyncio.ensure_future(self._pump())
        LOG.info("shell pid=%d started", pid)

    async def _pump(self):
        """Read PTY master, forward bytes to the DataChannel."""
        loop = self.loop
        try:
            while True:
                # Wait for the master fd to be readable; aiortc's channel
                # send is synchronous-ish (queues internally).
                future = loop.create_future()

                def on_readable():
                    if not future.done():
                        future.set_result(None)
                loop.add_reader(self.master_fd, on_readable)
                try:
                    await future
                finally:
                    loop.remove_reader(self.master_fd)
                try:
                    data = os.read(self.master_fd, 4096)
                except OSError as e:
                    if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                        continue
                    break
                if not data:
                    break  # PTY closed (shell exited)
                if self.channel.readyState != "open":
                    break
                self.channel.send(data)
        except Exception:
            LOG.exception("shell pump error")
        finally:
            self.dispose()

    def write(self, data: bytes):
        """Browser keystroke → write to PTY master (shell stdin)."""
        if self.master_fd is None:
            return
        try:
            os.write(self.master_fd, data)
        except OSError:
            pass

    def dispose(self):
        if self.master_fd is not None:
            try: os.close(self.master_fd)
            except OSError: pass
            self.master_fd = None
        if self.pid is not None:
            try: os.kill(self.pid, signal.SIGHUP)
            except OSError: pass
            try: os.waitpid(self.pid, os.WNOHANG)
            except OSError: pass
            self.pid = None


# ── Signaling ─────────────────────────────────────────────────────────────

class Session:
    """One peer connection's lifetime: WebSocket signaling + RTCPeerConnection
    + per-channel bridges. Recreated whenever the dashboard initiates a fresh
    offer (single-peer-at-a-time model)."""

    def __init__(self, ws, my_peer_id, room_id):
        self.ws = ws
        self.my_peer_id = my_peer_id
        self.room_id = room_id
        self.pc = None
        self.bridges = {}  # channel label → ShellBridge

    async def handle_signal(self, peer_id: str, data: dict):
        """Inbound signal frame from the other side."""
        # Don't echo our own signals back to ourselves.
        if peer_id == self.my_peer_id:
            return
        # Match phone-pair role filter — only accept from the other role.
        if not peer_id.startswith("dashboard-") and not peer_id.startswith("phone-"):
            return

        if data.get("offer"):
            await self._on_offer(data["offer"])
        if data.get("ice"):
            await self._on_ice(data["ice"])

    async def _on_offer(self, offer_data):
        # Tear down any previous PC — single-peer model.
        if self.pc:
            await self.pc.close()
            for b in self.bridges.values():
                b.dispose()
            self.bridges.clear()
        self.pc = RTCPeerConnection()

        @self.pc.on("datachannel")
        def on_dc(channel):
            LOG.info("datachannel opened: %s", channel.label)
            if channel.label == "shell":
                self._wire_shell(channel)
            elif channel.label == "ota":
                self._wire_ota(channel)
            else:
                LOG.warning("ignoring unknown channel label: %s", channel.label)

        @self.pc.on("connectionstatechange")
        async def on_state():
            LOG.info("pc state: %s", self.pc.connectionState)
            if self.pc.connectionState in ("failed", "closed", "disconnected"):
                for b in self.bridges.values():
                    b.dispose()

        # ICE candidates — trickle to the dashboard via the same WS.
        @self.pc.on("icecandidate")
        async def on_candidate(candidate):
            if candidate is None:
                return
            ice_dict = {
                "candidate": candidate.to_sdp() if hasattr(candidate, "to_sdp") else "",
                "sdpMid": candidate.sdpMid,
                "sdpMLineIndex": candidate.sdpMLineIndex,
            }
            await self._send({"ice": ice_dict})

        await self.pc.setRemoteDescription(
            RTCSessionDescription(sdp=offer_data["sdp"], type=offer_data["type"])
        )
        answer = await self.pc.createAnswer()
        await self.pc.setLocalDescription(answer)
        await self._send({"answer": {
            "sdp": self.pc.localDescription.sdp,
            "type": self.pc.localDescription.type,
        }})

    def _wire_shell(self, channel):
        bridge = ShellBridge(channel, asyncio.get_event_loop())
        self.bridges[channel.label] = bridge
        bridge.start()

        @channel.on("message")
        def on_msg(message):
            # Binary = raw PTY bytes (stdin). Text = JSON control messages
            # (resize, future: signals, env). WebRTC's native text/binary
            # discriminator avoids inline escape-sequence games.
            if isinstance(message, str):
                try:
                    ctrl = json.loads(message)
                except json.JSONDecodeError:
                    return
                if ctrl.get("type") == "resize" and bridge.master_fd is not None:
                    cols = int(ctrl.get("cols") or 80)
                    rows = int(ctrl.get("rows") or 24)
                    try:
                        fcntl.ioctl(
                            bridge.master_fd, termios.TIOCSWINSZ,
                            struct.pack("HHHH", rows, cols, 0, 0),
                        )
                    except OSError:
                        pass
            else:
                bridge.write(message)

        @channel.on("close")
        def on_close():
            LOG.info("datachannel closed: %s", channel.label)
            bridge.dispose()
            self.bridges.pop(channel.label, None)

    def _wire_ota(self, channel):
        # OTA staging path: dashboard streams a bundle JSON's bytes here, we
        # write to a fixed file in /tmp; the dashboard then triggers the
        # privileged apply via the existing BLE ops verb (apply-staged-ota
        # in pi_robot.py). Keeps RTC daemon at user privs while pi_robot.py
        # (root) does the file-system + systemctl work.
        LOG.info("ota: wiring channel readyState=%s", channel.readyState)
        state = {"writer": None, "size": 0, "received": 0,
                 "path": "/tmp/pi-robot-staged-ota.json"}

        def reset(reason=None):
            if state["writer"]:
                try: state["writer"].close()
                except Exception: pass
            state["writer"] = None
            state["size"] = 0
            state["received"] = 0
            try: os.unlink(state["path"])
            except OSError: pass
            if reason:
                try:
                    channel.send(json.dumps({"type": "error", "error": reason}))
                except Exception:
                    pass

        @channel.on("message")
        def on_msg(message):
            LOG.info("ota on_msg: type=%s len=%d", type(message).__name__, len(message) if hasattr(message, "__len__") else -1)
            if isinstance(message, str):
                try:
                    ctrl = json.loads(message)
                except json.JSONDecodeError:
                    LOG.warning("ota: bad json: %r", message[:200])
                    return
                t = ctrl.get("type")
                if t == "begin":
                    reset()
                    state["size"] = int(ctrl.get("size") or 0)
                    try:
                        state["writer"] = open(state["path"], "wb")
                    except OSError as e:
                        reset(f"open failed: {e}")
                        return
                    LOG.info("ota begin: size=%d → %s", state["size"], state["path"])
                elif t == "commit":
                    if state["writer"]:
                        state["writer"].close()
                        state["writer"] = None
                    LOG.info("ota commit: %d / %d bytes", state["received"], state["size"])
                    if state["size"] and state["received"] != state["size"]:
                        reset(f"size mismatch: {state['received']} != {state['size']}")
                        return
                    try:
                        channel.send(json.dumps({
                            "type": "staged",
                            "path": state["path"],
                            "size": state["received"],
                        }))
                    except Exception:
                        pass
                elif t == "abort":
                    LOG.info("ota abort")
                    reset()
            else:
                # Binary chunk — append to file. Bytes are the bundle JSON's
                # raw UTF-8; pi_robot.py will JSON-decode on apply.
                if not state["writer"]:
                    return
                try:
                    state["writer"].write(message)
                    state["received"] += len(message)
                except OSError as e:
                    reset(f"write failed: {e}")

        @channel.on("close")
        def on_close():
            LOG.info("datachannel closed: %s", channel.label)
            if state["writer"]:
                try: state["writer"].close()
                except Exception: pass
                state["writer"] = None
            self.bridges.pop(channel.label, None)

    async def _on_ice(self, ice):
        if not self.pc:
            return
        try:
            cand = parse_candidate(ice.get("candidate", ""))
            if cand is None:
                return
            cand.sdpMid = ice.get("sdpMid")
            cand.sdpMLineIndex = ice.get("sdpMLineIndex")
            await self.pc.addIceCandidate(cand)
        except Exception:
            LOG.exception("addIceCandidate")

    async def _send(self, data):
        await self.ws.send_str(json.dumps({
            "type": "signal",
            "peer": self.my_peer_id,
            "data": data,
        }))


_CAND_RE = re.compile(
    r"candidate:(?P<foundation>\S+) (?P<component>\d+) (?P<protocol>\S+) "
    r"(?P<priority>\d+) (?P<ip>\S+) (?P<port>\d+) typ (?P<type>\S+)"
)


def parse_candidate(line: str):
    """Convert browser-style 'candidate:...' string into RTCIceCandidate."""
    if not line:
        return None
    if line.startswith("candidate:"):
        s = line
    else:
        s = "candidate:" + line.split("candidate:", 1)[-1]
    m = _CAND_RE.match(s)
    if not m:
        return None
    g = m.groupdict()
    return RTCIceCandidate(
        component=int(g["component"]),
        foundation=g["foundation"],
        ip=g["ip"],
        port=int(g["port"]),
        priority=int(g["priority"]),
        protocol=g["protocol"],
        type=g["type"],
    )


# ── Main loop ─────────────────────────────────────────────────────────────

async def run():
    robot_id = device_name()
    room_id = f"pi-rtc-{robot_id}"
    my_peer_id = make_peer_id("desktop")
    url = f"{SIGNAL_WS_URL}/{room_id}/ws"
    LOG.info("connecting to %s as %s (room %s)", SIGNAL_WS_URL, my_peer_id, room_id)

    backoff = 1
    async with aiohttp.ClientSession() as http:
        while True:
            try:
                async with http.ws_connect(url, heartbeat=20) as ws:
                    LOG.info("ws connected")
                    backoff = 1
                    session = Session(ws, my_peer_id, room_id)
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            try:
                                payload = json.loads(msg.data)
                            except json.JSONDecodeError:
                                continue
                            if payload.get("type") == "signal":
                                await session.handle_signal(
                                    payload.get("peer", ""),
                                    payload.get("data", {}),
                                )
                            elif payload.get("type") == "state":
                                # signal.neevs.io broadcasts cached signaling
                                # to peers that join after another peer sent
                                # an offer (e.g. the dashboard clicked Connect
                                # while the Pi was momentarily disconnected).
                                # Extract offer/answer entries for the other
                                # role and replay them.
                                peers = payload.get("peers", {}) or {}
                                for peer_id, data in peers.items():
                                    if peer_id == my_peer_id:
                                        continue
                                    if not data:
                                        continue
                                    if data.get("offer") or data.get("answer"):
                                        await session.handle_signal(peer_id, data)
                        elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                            break
                    LOG.info("ws closed")
            except Exception:
                LOG.exception("ws session failed")
            # Exponential backoff up to 30s — restart matches systemd's
            # Restart=always but adds jitter so a flapping signal server
            # doesn't get hammered.
            await asyncio.sleep(min(backoff, 30))
            backoff = min(backoff * 2, 30)


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(message)s",
    )
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
