#!/usr/bin/env python3
"""
pi-robot-rtc — local aiortc daemon for one Pi.

Listens on /run/pi-robot-rtc.sock for offers forwarded by pi_robot.py.
The dashboard writes a chunked SDP offer to the BLE SIGNAL char;
pi_robot.py (root, owns the GATT server) reassembles and RPCs us
non-trickle over the Unix socket:

  request:  {"type": "offer", "sdp": "..."}\\n
  response: {"type": "answer", "sdp": "..."}\\n   (all candidates inline)

pi_robot.py then notifies the answer back over BLE; the dashboard's
WebRTC ICE then runs P2P over LAN — no internet rendezvous, no
Mixed-Content / PNA exposure. BLE pair is the auth substrate.

This daemon runs as the non-root `robot` user; pi_robot.py runs as
root and handles filesystem + systemctl. Keeping the aiortc peer at
user privs is the privilege boundary, not the signaling transport.
"""

import asyncio
import errno
import fcntl
import json
import logging
import os
import pty
import signal
import struct
import sys
import termios

try:
    import aiohttp
    from aiortc import (
        RTCPeerConnection, RTCSessionDescription,
        RTCConfiguration, RTCIceServer,
    )
except ImportError as e:
    sys.stderr.write(f"[rtc] missing dependency: {e}. Run `pip install aiortc aiohttp`.\n")
    sys.exit(2)

LOCAL_SOCK_PATH = "/run/pi-robot-rtc.sock"
TURN_ENDPOINT = "https://proxy.neevs.io/cloudflare/turn"
STUN_FALLBACK = [
    RTCIceServer(urls="stun:stun.l.google.com:19302"),
    RTCIceServer(urls="stun:stun.cloudflare.com:3478"),
]
LOG = logging.getLogger("rtc")


async def fetch_ice_servers() -> list:
    """Mirrors pairing.js — Cloudflare TURN creds via proxy.neevs.io,
    STUN fallback if the proxy is down. Cross-network shells / OTA need
    relay candidates when host + srflx can't reach the dashboard."""
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(TURN_ENDPOINT, timeout=aiohttp.ClientTimeout(total=5)) as r:
                if r.status != 200:
                    raise RuntimeError(f"turn: {r.status}")
                payload = await r.json()
        servers = list(STUN_FALLBACK)
        for entry in payload.get("iceServers", []):
            urls = entry.get("urls")
            if not urls:
                continue
            servers.append(RTCIceServer(
                urls=urls,
                username=entry.get("username"),
                credential=entry.get("credential"),
            ))
        return servers
    except Exception as e:
        LOG.info("turn fetch failed, STUN-only: %s", e)
        return list(STUN_FALLBACK)


# ── PTY bridge ────────────────────────────────────────────────────────────

class ShellBridge:
    """Forks bash under a PTY: stdout → DataChannel, DataChannel → stdin.
    Disposes on channel close or shell exit."""

    def __init__(self, channel, loop):
        self.channel = channel
        self.loop = loop
        self.master_fd = None
        self.pid = None
        self.task = None

    def start(self):
        pid, fd = pty.fork()
        if pid == 0:
            os.execvp("bash", ["bash", "-i"])
            os._exit(127)
        self.pid = pid
        self.master_fd = fd
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ,
                        struct.pack("HHHH", 24, 80, 0, 0))
        except OSError:
            pass
        self.task = asyncio.ensure_future(self._pump())
        LOG.info("shell pid=%d started", pid)

    async def _pump(self):
        loop = self.loop
        try:
            while True:
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
                    break
                if self.channel.readyState != "open":
                    break
                self.channel.send(data)
        except Exception:
            LOG.exception("shell pump error")
        finally:
            self.dispose()

    def write(self, data: bytes):
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


# Per-channel wiring (transport-agnostic). Both wss + Unix-socket paths
# share these. `bridges` is the per-PC dict owning ShellBridges + log-tail
# tasks; dispatcher drops entries on channel close.

def wire_channel(channel, bridges):
    LOG.info("datachannel opened: %s", channel.label)
    if channel.label == "shell":
        _wire_shell(channel, bridges)
    elif channel.label == "ota":
        _wire_ota(channel, bridges)
    elif channel.label == "logs":
        _wire_logs(channel, bridges)
    else:
        LOG.warning("ignoring unknown channel label: %s", channel.label)


def _wire_shell(channel, bridges):
    bridge = ShellBridge(channel, asyncio.get_event_loop())
    bridges[channel.label] = bridge
    bridge.start()

    @channel.on("message")
    def on_msg(message):
        # Binary = raw PTY stdin. Text = JSON control (resize, future:
        # signals, env). WebRTC's native discriminator avoids inline
        # escape-sequence games.
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
        bridges.pop(channel.label, None)


def _wire_ota(channel, bridges):
    # OTA staging: dashboard streams bundle JSON bytes here, we write to a
    # fixed /tmp file. Dashboard then triggers the privileged apply via
    # apply-staged-ota in pi_robot.py. RTC daemon stays at user privs;
    # pi_robot.py (root) does file-system + systemctl.
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
        LOG.info("ota on_msg: type=%s len=%d", type(message).__name__,
                 len(message) if hasattr(message, "__len__") else -1)
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
        bridges.pop(channel.label, None)


def _wire_logs(channel, bridges):
    # journalctl -fu <unit> piped as text lines. Dashboard starts with
    # {type:"follow", unit:"<service>"}; channel close (or new follow)
    # kills the subprocess. Unit allowlist prevents arbitrary shell-out.
    ALLOWED_UNITS = (
        "pi-robot", "pi-robot.service",
        "pi-robot-heartbeat", "pi-robot-heartbeat.service",
        "pi-robot-health", "pi-robot-health.service",
        "pi-robot-rtc", "pi-robot-rtc.service",
    )
    state = {"task": None}
    loop = asyncio.get_event_loop()

    async def follow(unit):
        try:
            proc = await asyncio.create_subprocess_exec(
                "journalctl", "-fu", unit, "-n", "100", "--output", "short-iso",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except Exception as e:
            try:
                channel.send(json.dumps({"type": "error", "error": str(e)[:200]}))
            except Exception:
                pass
            return
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                if channel.readyState != "open":
                    break
                try:
                    channel.send(line.decode("utf-8", errors="replace"))
                except Exception:
                    break
        finally:
            try: proc.terminate()
            except Exception: pass
            try: await proc.wait()
            except Exception: pass

    def stop_current():
        t = state["task"]
        if t and not t.done():
            t.cancel()
        state["task"] = None

    @channel.on("message")
    def on_msg(message):
        if not isinstance(message, str):
            return
        try:
            ctrl = json.loads(message)
        except json.JSONDecodeError:
            return
        t = ctrl.get("type")
        if t == "follow":
            unit = str(ctrl.get("unit") or "pi-robot.service")
            if unit not in ALLOWED_UNITS:
                try:
                    channel.send(json.dumps({"type": "error", "error": f"unit not allowed: {unit}"}))
                except Exception:
                    pass
                return
            stop_current()
            state["task"] = loop.create_task(follow(unit))
        elif t == "stop":
            stop_current()

    @channel.on("close")
    def on_close():
        LOG.info("datachannel closed: %s", channel.label)
        stop_current()
        bridges.pop(channel.label, None)


# Unix socket signaling. pi_robot.py (root, owns BLE GATT) forwards
# BLE-signaled offers here as JSON-over-Unix-socket RPC. We answer
# non-trickle (all candidates inline; aiortc's setLocalDescription waits
# for ICE gathering); pi_robot.py notifies the answer back via BLE chunks.
#
# Live peers stay in _local_peers so they aren't GC'd between RPC reply
# and ICE/data-channel traffic. Each unregisters on terminal state.

_local_peers = set()


async def handle_local_offer(reader, writer):
    try:
        line = await reader.readline()
        if not line:
            return
        msg = json.loads(line)
    except (asyncio.IncompleteReadError, json.JSONDecodeError, OSError) as e:
        LOG.warning("local offer: bad request: %s", e)
        writer.close()
        return

    if msg.get("type") != "offer" or "sdp" not in msg:
        try:
            writer.write((json.dumps({"type": "error", "error": "bad offer"}) + "\n").encode())
            await writer.drain()
        except Exception:
            pass
        writer.close()
        return

    ice_servers = await fetch_ice_servers()
    pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers))
    bridges = {}

    @pc.on("datachannel")
    def on_dc(channel):
        wire_channel(channel, bridges)

    peer_record = {"pc": pc, "bridges": bridges}
    _local_peers.add(id(peer_record))
    refs = {"r": peer_record}  # keep strong reference

    @pc.on("connectionstatechange")
    async def on_state():
        LOG.info("local pc state: %s", pc.connectionState)
        if pc.connectionState in ("failed", "closed", "disconnected"):
            for b in bridges.values():
                b.dispose()
            bridges.clear()
            _local_peers.discard(id(peer_record))
            refs.pop("r", None)

    try:
        await pc.setRemoteDescription(RTCSessionDescription(sdp=msg["sdp"], type="offer"))
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        # aiortc's setLocalDescription waits for ICE gathering, so the
        # localDescription.sdp here carries every candidate inline —
        # exactly what BLE non-trickle signaling needs.
        response = json.dumps({"type": "answer", "sdp": pc.localDescription.sdp})
        writer.write((response + "\n").encode())
        await writer.drain()
        LOG.info("local offer answered (sdp=%d B)", len(pc.localDescription.sdp))
    except Exception as e:
        LOG.exception("local offer handling failed")
        try:
            writer.write((json.dumps({"type": "error", "error": str(e)}) + "\n").encode())
            await writer.drain()
        except Exception:
            pass
        try: await pc.close()
        except Exception: pass
        _local_peers.discard(id(peer_record))
        refs.pop("r", None)
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def run_unix_server():
    """Listen on /run/pi-robot-rtc.sock for offers from pi_robot.py. 0o666
    perms so pi_robot.py (root) can connect to a `robot`-owned socket."""
    try:
        os.unlink(LOCAL_SOCK_PATH)
    except FileNotFoundError:
        pass
    except OSError as e:
        LOG.warning("unix socket cleanup: %s", e)
    try:
        os.makedirs(os.path.dirname(LOCAL_SOCK_PATH), exist_ok=True)
    except OSError:
        pass
    server = await asyncio.start_unix_server(handle_local_offer, LOCAL_SOCK_PATH)
    try:
        os.chmod(LOCAL_SOCK_PATH, 0o666)
    except OSError as e:
        LOG.warning("unix socket chmod: %s", e)
    LOG.info("local signaling: listening on %s", LOCAL_SOCK_PATH)
    async with server:
        await server.serve_forever()


# ── entry point ──────────────────────────────────────────────────────────

def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(message)s",
    )
    try:
        asyncio.run(run_unix_server())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
