#!/usr/bin/env python3
"""Better Robotics — robot firmware for Raspberry Pi.

Mirrors firmware/esp32_robot/esp32_robot.ino: advertises a single BLE
service; each capability (LED, WiFi, motors, sensors, ...) is a
characteristic within that service. The dashboard connects to Pi and
ESP32 robots identically.

Run:
    pip install -r requirements.txt
    python3 pi_robot.py
"""

import ast
import asyncio
import json
import logging
import os
import socket
import subprocess

from bless import (
    BlessServer,
    BlessGATTCharacteristic,
    GATTCharacteristicProperties,
    GATTAttributePermissions,
)
from gpiozero import LED

# UUIDs — must match firmware/esp32_robot/esp32_robot.ino exactly.
SERVICE_UUID          = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d91"
LED_CHAR_UUID         = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d92"
WIFI_SCAN_CHAR_UUID   = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d93"
WIFI_JOIN_CHAR_UUID   = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d94"
WIFI_STATUS_CHAR_UUID = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d95"
OTA_DATA_CHAR_UUID    = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d96"
OTA_STATUS_CHAR_UUID  = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d97"
FW_INFO_CHAR_UUID     = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d98"
MOTOR_CHAR_UUID       = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d99"
# Camera signaling (optional — only registered if picamera2 + aiortc are
# importable). Two chars, same chunked protocol as OTA:
#   camera-signal (write)   — SDP offer / ICE candidate / stop from the browser
#   camera-status (notify)  — status + outbound SDP answer / ICE back to browser
CAMERA_SIGNAL_CHAR_UUID = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d9a"
CAMERA_STATUS_CHAR_UUID = "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d9b"

FW_INFO = {"type": "pi", "url": "firmware/pi_robot/pi_robot.py"}

# Motor watchdog: every write resets the timer; silence reverts to (0, 0).
# Safe default on disconnect — no redundant channel required.
MOTOR_WATCHDOG_MS = 500

# BLE OTA protocol:
#   ota-data  (write) — binary frames with 1-byte opcode:
#       0x01 [size:u32 big-endian]     begin — reset buffer, expect `size` bytes
#       0x02 [payload bytes]           chunk — append to buffer
#       0x03                           commit — validate + install + restart
#   ota-status (read+notify) — UTF-8 JSON:
#       {"st":"idle|receiving|committing|done|failed","n":received,"total":size,"err":msg}
# On commit: the new file's Python syntax is ast-parsed before atomic rename.
# After install, pi_robot.py restarts its own service via systemctl; the BLE
# link drops and the dashboard reconnects to the new version.

# Shared BLE WiFi spec (also implemented on ESP32):
#   wifi-scan   — read + notify. UTF-8 JSON: [{"s":ssid,"r":0..100,"p":0|1}].
#                 Reading triggers a rescan; notify fires when done. Strongest first.
#   wifi-join   — write. UTF-8 JSON: {"s":ssid,"p":password}. Empty p for open nets.
#   wifi-status — read + notify. UTF-8 JSON: {"st":state,"ssid":name,"err":msg}.
#                 States: idle, joining, joined, failed. (Scan activity is
#                 tracked client-side via wifi-scan notifications; it doesn't
#                 change connection state.)

SCAN_MAX = 10      # Bounded so the full JSON fits in one ATT read.
OTA_TARGET = "/home/pi/better-robotics/firmware/pi_robot/pi_robot.py"

# Capability config. Written by the browser's Customize-card flow onto the
# boot partition. Declares which capabilities this physical robot actually has —
# don't advertise LED if no LED is wired, don't advertise motors if no H-bridge.
# Missing or unreadable file → default to all capabilities on, so existing Pis
# OTA'd from pre-config versions keep working.
CONFIG_PATH = "/boot/firmware/pi-robot.conf"
def _load_config() -> dict:
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
_config = _load_config()
LED_ENABLED    = bool(_config.get("led_enabled", True))
LED_PIN        = int(_config.get("led_pin", 17))
MOTORS_ENABLED = bool(_config.get("motors_enabled", True))
CAMERA_ENABLED = _config.get("camera_enabled", "auto")  # "auto" | True | False
OTA_OP_ABORT = 0x00
OTA_OP_BEGIN = 0x01
OTA_OP_CHUNK = 0x02
OTA_OP_COMMIT = 0x03

# Camera opcodes share the OTA pattern: begin-stream, chunk, commit, stop.
CAM_OP_BEGIN  = 0x01
CAM_OP_CHUNK  = 0x02
CAM_OP_COMMIT = 0x03
CAM_OP_STOP   = 0x04

# Optional camera stack. Gated on config: if CAMERA_ENABLED is False we skip
# the imports entirely. "auto" attempts import and tolerates failure — a Pi
# without aiortc or without picamera2 installed simply doesn't advertise the
# camera chars.
_camera_available = False
if CAMERA_ENABLED is not False:
    try:
        from picamera2 import Picamera2  # type: ignore
        from aiortc import (  # type: ignore
            RTCPeerConnection, RTCSessionDescription, RTCIceCandidate,
            MediaStreamTrack,
        )
        from aiortc.rtcrtpsender import RTCRtpSender  # type: ignore
        import av  # type: ignore
        import fractions
        _camera_available = True
    except ImportError as _e:
        _camera_import_err = str(_e)

logging.basicConfig(format="%(asctime)s %(message)s", level=logging.INFO)
log = logging.getLogger("pi_robot")

led = LED(LED_PIN) if LED_ENABLED else None
_led_state = 0
_server: BlessServer | None = None
_loop: asyncio.AbstractEventLoop | None = None
_wifi_status: dict = {"st": "idle"}
_wifi_scan: list[dict] = []
_ota_status: dict = {"st": "idle", "n": 0}
_ota_buffer: bytearray = bytearray()
_ota_size: int = 0
_motor_left: int = 0
_motor_right: int = 0
_motor_last_write_at: float = 0.0

# Camera state. _cam_pc is the current RTCPeerConnection; _cam_buf accumulates
# inbound signaling chunks; _cam_expected is the size announced by CAM_OP_BEGIN.
_cam_pc = None
_cam_track = None
_cam_buf: bytearray = bytearray()
_cam_expected: int = 0
_cam_status: dict = {"st": "idle"}


def device_name() -> str:
    """BetterRobot-XXXX with a stable per-chip suffix, matching ESP32 naming."""
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
        suffix = socket.gethostname()[-4:].upper().ljust(4, "0")
    return f"BetterRobot-{suffix}"


def _json_bytes(obj) -> bytearray:
    return bytearray(json.dumps(obj, separators=(",", ":")).encode("utf-8"))


def _publish(char_uuid: str, value: bytearray) -> None:
    """Set a characteristic's current value and notify subscribers."""
    if _server is None:
        return
    ch = _server.get_characteristic(char_uuid)
    if ch is not None:
        ch.value = value
    _server.update_value(SERVICE_UUID, char_uuid)


def _set_status(st: str, ssid: str | None = None, err: str | None = None) -> None:
    global _wifi_status
    _wifi_status = {"st": st}
    if ssid:
        _wifi_status["ssid"] = ssid
    if err:
        _wifi_status["err"] = err
    _publish(WIFI_STATUS_CHAR_UUID, _json_bytes(_wifi_status))
    log.info("wifi-status → %s", _wifi_status)


async def _wifi_scan_task() -> None:
    # nmcli SIGNAL is 0..100 already; we pass it through as our unified "strength".
    # Doesn't touch wifi-status — scan activity is orthogonal to connection state.
    global _wifi_scan
    try:
        _init_wifi_radio()  # belt-and-suspenders in case state changed
        proc = await asyncio.create_subprocess_exec(
            "nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY",
            "dev", "wifi", "list", "--rescan", "yes",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate()
        out_str = out.decode(errors="replace")
        err_str = err.decode(errors="replace")
        if proc.returncode != 0:
            log.warning("wifi scan failed: %s", err_str.strip())
            return
        seen: set[str] = set()
        results: list[dict] = []
        for line in out_str.splitlines():
            # -t uses ':' as delimiter; embedded ':' in fields is escaped as '\:'.
            parts = line.replace("\\:", "\x00").split(":")
            if len(parts) < 3:
                continue
            ssid = parts[0].replace("\x00", ":").strip()
            if not ssid or ssid in seen:
                continue
            seen.add(ssid)
            try:
                strength = int(parts[1])
            except ValueError:
                strength = 0
            secured = 1 if parts[2].strip() else 0
            results.append({"s": ssid[:32], "r": strength, "p": secured})
        results.sort(key=lambda x: x["r"], reverse=True)
        _wifi_scan = results[:SCAN_MAX]
        _publish(WIFI_SCAN_CHAR_UUID, _json_bytes(_wifi_scan))
    except Exception as e:
        log.warning("wifi scan error: %s", e)


def _set_ota_status(st: str, n: int = 0, total: int = 0, err: str | None = None) -> None:
    global _ota_status
    s: dict = {"st": st, "n": n}
    if total:
        s["total"] = total
    if err:
        s["err"] = err
    _ota_status = s
    _publish(OTA_STATUS_CHAR_UUID, _json_bytes(_ota_status))
    log.info("ota-status → %s", _ota_status)


async def _ota_commit() -> None:
    global _ota_buffer, _ota_size
    try:
        if len(_ota_buffer) != _ota_size:
            _set_ota_status("failed", err=f"size mismatch {len(_ota_buffer)} != {_ota_size}")
            _ota_buffer = bytearray()
            return
        try:
            ast.parse(bytes(_ota_buffer))
        except SyntaxError as e:
            _set_ota_status("failed", err=f"SyntaxError: {e}"[:120])
            _ota_buffer = bytearray()
            return
        tmp = OTA_TARGET + ".new"
        with open(tmp, "wb") as f:
            f.write(_ota_buffer)
        os.replace(tmp, OTA_TARGET)
        _set_ota_status("done", n=len(_ota_buffer), total=_ota_size)
        _ota_buffer = bytearray()
        # Let the notify flush over BLE before systemd kills us.
        await asyncio.sleep(0.5)
        subprocess.Popen(["systemctl", "restart", "pi-robot.service"])
    except Exception as e:
        _set_ota_status("failed", err=str(e)[:120])


def _ota_handle_write(data: bytearray) -> None:
    global _ota_buffer, _ota_size
    if not data:
        return
    op = data[0]
    if op == OTA_OP_ABORT:
        _ota_buffer = bytearray()
        _ota_size = 0
        _set_ota_status("idle")
        return
    if op == OTA_OP_BEGIN:
        if len(data) < 5:
            _set_ota_status("failed", err="bad begin frame")
            return
        _ota_size = int.from_bytes(bytes(data[1:5]), "big")
        _ota_buffer = bytearray()
        _set_ota_status("receiving", n=0, total=_ota_size)
    elif op == OTA_OP_CHUNK:
        _ota_buffer.extend(data[1:])
        _set_ota_status("receiving", n=len(_ota_buffer), total=_ota_size)
    elif op == OTA_OP_COMMIT:
        _set_ota_status("committing", n=len(_ota_buffer), total=_ota_size)
        _schedule(_ota_commit())
    else:
        _set_ota_status("failed", err=f"unknown op 0x{op:02x}")


def _apply_motors(left: int, right: int) -> None:
    """Stub motor driver. Wire to your H-bridge/PWM here (gpiozero.Motor,
    RPi.GPIO.PWM, etc). Current behavior: update state + notify dashboard."""
    global _motor_left, _motor_right
    _motor_left, _motor_right = left, right
    _publish(MOTOR_CHAR_UUID, bytearray([left & 0xff, right & 0xff]))
    log.info("motors → (%+d, %+d)", left, right)


def _motor_handle_write(data: bytearray) -> None:
    global _motor_last_write_at
    if len(data) < 2:
        return
    def signed(b: int) -> int:
        return b - 256 if b >= 128 else b
    _motor_last_write_at = asyncio.get_event_loop().time()
    _apply_motors(signed(data[0]), signed(data[1]))


def _cam_send(obj: dict) -> None:
    """Outbound signaling / status to the dashboard via notify on camera-status.
    Chunks with the same opcode shape as inbound so the browser assembler is
    symmetric. 180 B per chunk sits under typical ATT MTU."""
    if _server is None:
        return
    data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    begin = bytearray(5)
    begin[0] = CAM_OP_BEGIN
    begin[1:5] = len(data).to_bytes(4, "big")
    _publish(CAMERA_STATUS_CHAR_UUID, begin)
    chunk = 180
    for i in range(0, len(data), chunk):
        frame = bytearray([CAM_OP_CHUNK]) + data[i:i + chunk]
        _publish(CAMERA_STATUS_CHAR_UUID, frame)
    _publish(CAMERA_STATUS_CHAR_UUID, bytearray([CAM_OP_COMMIT]))


def _set_cam_status(**fields) -> None:
    global _cam_status
    _cam_status = {**_cam_status, **fields}
    _cam_send({"t": "status", "d": _cam_status})


class _PiCameraTrack(MediaStreamTrack if _camera_available else object):  # type: ignore
    """aiortc video track pulling RGB frames from Picamera2. 640x480 @ 15fps
    keeps CPU reasonable on a Pi 4 and bandwidth under BLE-signaled WebRTC's
    default WiFi path limits."""
    kind = "video"

    def __init__(self) -> None:
        super().__init__()
        self.camera = Picamera2()
        cfg = self.camera.create_video_configuration(
            main={"size": (640, 480), "format": "RGB888"},
        )
        self.camera.configure(cfg)
        self.camera.start()
        self._pts = 0
        self._time_base = fractions.Fraction(1, 15)

    async def recv(self):
        arr = self.camera.capture_array("main")
        frame = av.VideoFrame.from_ndarray(arr, format="rgb24")
        self._pts += 1
        frame.pts = self._pts
        frame.time_base = self._time_base
        return frame

    def stop(self) -> None:
        try:
            self.camera.stop()
        except Exception:
            pass
        super().stop()


async def _cam_handle_message(msg: dict) -> None:
    """Signaling messages from the browser. t=offer creates a new pc; answer
    is sent back via camera-status notify. t=ice adds a candidate. t=stop
    tears down. All branches tolerant of malformed input."""
    global _cam_pc, _cam_track
    t = msg.get("t")
    d = msg.get("d") or {}
    try:
        if t == "offer":
            if _cam_pc is not None:
                await _cam_pc.close()
            _cam_pc = RTCPeerConnection()
            _cam_track = _PiCameraTrack()
            _cam_pc.addTrack(_cam_track)

            @_cam_pc.on("iceconnectionstatechange")
            async def _on_ice_state() -> None:
                _set_cam_status(st=f"ice-{_cam_pc.iceConnectionState}")
                if _cam_pc.iceConnectionState in ("failed", "closed"):
                    await _cam_teardown()

            await _cam_pc.setRemoteDescription(
                RTCSessionDescription(sdp=d["sdp"], type=d["type"])
            )
            answer = await _cam_pc.createAnswer()
            await _cam_pc.setLocalDescription(answer)
            _cam_send({"t": "answer", "d": {
                "sdp": _cam_pc.localDescription.sdp,
                "type": _cam_pc.localDescription.type,
            }})
            _set_cam_status(st="answered")
        elif t == "ice" and _cam_pc is not None:
            # aiortc's addIceCandidate accepts a dict-derived candidate.
            cand = RTCIceCandidate(
                sdpMid=d.get("sdpMid"),
                sdpMLineIndex=d.get("sdpMLineIndex"),
                candidate=d.get("candidate", ""),
            )
            await _cam_pc.addIceCandidate(cand)
        elif t == "stop":
            await _cam_teardown()
    except Exception as e:
        log.warning("camera signal error: %s", e)
        _set_cam_status(st="error", err=str(e)[:120])


async def _cam_teardown() -> None:
    global _cam_pc, _cam_track
    if _cam_track is not None:
        try: _cam_track.stop()
        except Exception: pass
        _cam_track = None
    if _cam_pc is not None:
        try: await _cam_pc.close()
        except Exception: pass
        _cam_pc = None
    _set_cam_status(st="idle")


def _cam_handle_write(data: bytearray) -> None:
    """Inbound signaling chunks from the browser. Same protocol as OTA."""
    global _cam_buf, _cam_expected
    if not data:
        return
    op = data[0]
    if op == CAM_OP_BEGIN:
        if len(data) < 5:
            return
        _cam_expected = int.from_bytes(bytes(data[1:5]), "big")
        _cam_buf = bytearray()
    elif op == CAM_OP_CHUNK:
        _cam_buf.extend(data[1:])
    elif op == CAM_OP_COMMIT:
        try:
            msg = json.loads(bytes(_cam_buf).decode("utf-8"))
        except Exception as e:
            log.warning("camera signal: parse error %s", e)
            _cam_buf = bytearray()
            _cam_expected = 0
            return
        _cam_buf = bytearray()
        _cam_expected = 0
        _schedule(_cam_handle_message(msg))
    elif op == CAM_OP_STOP:
        _schedule(_cam_handle_message({"t": "stop"}))


async def _motor_watchdog_task() -> None:
    interval_s = 0.1
    window_s = MOTOR_WATCHDOG_MS / 1000.0
    while True:
        await asyncio.sleep(interval_s)
        if _motor_left == 0 and _motor_right == 0:
            continue
        if _motor_last_write_at == 0.0:
            continue
        if asyncio.get_event_loop().time() - _motor_last_write_at > window_s:
            _apply_motors(0, 0)
            log.info("motor watchdog: stopped")


async def _check_current_wifi() -> None:
    """On startup, reflect the actual current connection state."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "nmcli", "-t", "-f", "NAME,TYPE", "conn", "show", "--active",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await proc.communicate()
        for line in out.decode(errors="replace").splitlines():
            parts = line.replace("\\:", "\x00").split(":")
            if len(parts) >= 2 and parts[1] == "802-11-wireless":
                _set_status("joined", ssid=parts[0].replace("\x00", ":"))
                return
        _set_status("idle")
    except Exception as e:
        log.warning("initial wifi check failed: %s", e)


async def _wifi_join_task(ssid: str, password: str) -> None:
    _set_status("joining", ssid=ssid)
    # A prior failed attempt can leave a half-configured NM profile; the next
    # join reuses it and trips on "802-11-wireless-security.key-mgmt: property
    # is missing." Delete any stale profile for this SSID before connecting.
    # rc is ignored — "no connection with name" is the expected success path.
    del_proc = await asyncio.create_subprocess_exec(
        "nmcli", "connection", "delete", ssid,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    await del_proc.wait()
    cmd = ["nmcli", "dev", "wifi", "connect", ssid]
    if password:
        cmd += ["password", password]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate()
        if proc.returncode == 0:
            _set_status("joined", ssid=ssid)
        else:
            msg = (err.decode(errors="replace") or out.decode(errors="replace")).strip()
            _set_status("failed", ssid=ssid, err=msg[:120] or "join failed")
    except Exception as e:
        _set_status("failed", ssid=ssid, err=str(e)[:120])


def _schedule(coro) -> None:
    """Schedule a coroutine from the BLE callback thread onto the main loop."""
    if _loop is not None:
        asyncio.run_coroutine_threadsafe(coro, _loop)


def on_read(characteristic: BlessGATTCharacteristic, **_) -> bytearray:
    uuid = characteristic.uuid.lower()
    if uuid == LED_CHAR_UUID:
        return bytearray([_led_state])
    if uuid == WIFI_SCAN_CHAR_UUID:
        _schedule(_wifi_scan_task())  # refresh in background; client sees it via notify.
        return _json_bytes(_wifi_scan)
    if uuid == WIFI_STATUS_CHAR_UUID:
        return _json_bytes(_wifi_status)
    if uuid == OTA_STATUS_CHAR_UUID:
        return _json_bytes(_ota_status)
    if uuid == FW_INFO_CHAR_UUID:
        return _json_bytes(FW_INFO)
    if uuid == MOTOR_CHAR_UUID:
        return bytearray([_motor_left & 0xff, _motor_right & 0xff])
    if uuid == CAMERA_STATUS_CHAR_UUID:
        # Initial read: return empty (the chunked protocol means no single
        # value makes sense here). Status lands via notify on state changes.
        return bytearray()
    return characteristic.value


def on_write(characteristic: BlessGATTCharacteristic, value: bytearray, **_) -> None:
    global _led_state
    uuid = characteristic.uuid.lower()
    if uuid == LED_CHAR_UUID:
        if len(value) == 0 or led is None:
            return
        _led_state = 1 if value[0] else 0
        led.on() if _led_state else led.off()
        _publish(LED_CHAR_UUID, bytearray([_led_state]))
        log.info("LED → %s", "on" if _led_state else "off")
        return
    if uuid == WIFI_JOIN_CHAR_UUID:
        try:
            payload = json.loads(bytes(value).decode("utf-8"))
            ssid = str(payload.get("s", "")).strip()
            password = str(payload.get("p", ""))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            _set_status("failed", err=f"bad payload: {e}"[:120])
            return
        if not ssid:
            _set_status("failed", err="missing ssid")
            return
        _schedule(_wifi_join_task(ssid, password))
        return
    if uuid == OTA_DATA_CHAR_UUID:
        _ota_handle_write(value)
        return
    if uuid == MOTOR_CHAR_UUID:
        _motor_handle_write(value)
        return
    if uuid == CAMERA_SIGNAL_CHAR_UUID:
        _cam_handle_write(value)
        return


def _init_wifi_radio() -> None:
    """Get wlan0 to a state where nmcli scans return networks.

    Idempotent sequence: unblock rfkill → make sure NetworkManager is running →
    turn on the WiFi radio. Any step failing is logged but not fatal — we want
    pi_robot to come up for BLE even if WiFi is unavailable."""
    steps = [
        ["rfkill", "unblock", "wifi"],
        ["rfkill", "unblock", "all"],
        ["systemctl", "start", "NetworkManager"],
        ["nmcli", "radio", "wifi", "on"],
    ]
    for cmd in steps:
        try:
            subprocess.run(cmd, check=False, timeout=5, capture_output=True)
        except Exception as e:
            log.warning("wifi init: %s failed: %s", cmd, e)


async def main() -> None:
    global _server, _loop
    _loop = asyncio.get_running_loop()
    _init_wifi_radio()
    name = device_name()
    log.info("Starting %s", name)

    _server = BlessServer(name=name)
    _server.read_request_func = on_read
    _server.write_request_func = on_write

    await _server.add_new_service(SERVICE_UUID)
    if LED_ENABLED:
        await _server.add_new_characteristic(
            SERVICE_UUID, LED_CHAR_UUID,
            GATTCharacteristicProperties.read
            | GATTCharacteristicProperties.write
            | GATTCharacteristicProperties.notify,
            bytearray([_led_state]),
            GATTAttributePermissions.readable | GATTAttributePermissions.writeable,
        )
    await _server.add_new_characteristic(
        SERVICE_UUID, WIFI_SCAN_CHAR_UUID,
        GATTCharacteristicProperties.read | GATTCharacteristicProperties.notify,
        _json_bytes(_wifi_scan),
        GATTAttributePermissions.readable,
    )
    await _server.add_new_characteristic(
        SERVICE_UUID, WIFI_JOIN_CHAR_UUID,
        GATTCharacteristicProperties.write,
        bytearray(b"{}"),
        GATTAttributePermissions.writeable,
    )
    await _server.add_new_characteristic(
        SERVICE_UUID, WIFI_STATUS_CHAR_UUID,
        GATTCharacteristicProperties.read | GATTCharacteristicProperties.notify,
        _json_bytes(_wifi_status),
        GATTAttributePermissions.readable,
    )
    await _server.add_new_characteristic(
        SERVICE_UUID, OTA_DATA_CHAR_UUID,
        GATTCharacteristicProperties.write,
        bytearray(),
        GATTAttributePermissions.writeable,
    )
    await _server.add_new_characteristic(
        SERVICE_UUID, OTA_STATUS_CHAR_UUID,
        GATTCharacteristicProperties.read | GATTCharacteristicProperties.notify,
        _json_bytes(_ota_status),
        GATTAttributePermissions.readable,
    )
    await _server.add_new_characteristic(
        SERVICE_UUID, FW_INFO_CHAR_UUID,
        GATTCharacteristicProperties.read,
        _json_bytes(FW_INFO),
        GATTAttributePermissions.readable,
    )
    if MOTORS_ENABLED:
        await _server.add_new_characteristic(
            SERVICE_UUID, MOTOR_CHAR_UUID,
            GATTCharacteristicProperties.read
            | GATTCharacteristicProperties.write
            | GATTCharacteristicProperties.notify,
            bytearray([0, 0]),
            GATTAttributePermissions.readable | GATTAttributePermissions.writeable,
        )

    if _camera_available:
        # Camera chars are strictly additive. If picamera2 / aiortc aren't
        # installed, they're absent from the service — the dashboard probes
        # with getCharacteristic and falls through quietly.
        await _server.add_new_characteristic(
            SERVICE_UUID, CAMERA_SIGNAL_CHAR_UUID,
            GATTCharacteristicProperties.write,
            bytearray(),
            GATTAttributePermissions.writeable,
        )
        await _server.add_new_characteristic(
            SERVICE_UUID, CAMERA_STATUS_CHAR_UUID,
            GATTCharacteristicProperties.read | GATTCharacteristicProperties.notify,
            bytearray(),
            GATTAttributePermissions.readable,
        )
        log.info("camera: available (picamera2 + aiortc loaded)")
    else:
        log.info("camera: unavailable — install picamera2, aiortc, and av to enable")

    await _server.start()
    log.info("Advertising on service %s", SERVICE_UUID)
    log.info("Ctrl+C to stop.")
    asyncio.create_task(_check_current_wifi())
    if MOTORS_ENABLED:
        asyncio.create_task(_motor_watchdog_task())
    log.info("capabilities: led=%s motors=%s camera=%s", LED_ENABLED, MOTORS_ENABLED, _camera_available)
    try:
        await asyncio.Event().wait()
    finally:
        await _server.stop()


if __name__ == "__main__":
    asyncio.run(main())
