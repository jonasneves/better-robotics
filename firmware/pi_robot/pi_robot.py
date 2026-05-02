#!/usr/bin/env python3
"""Better Robotics — robot firmware for Raspberry Pi.

Mirrors firmware/esp32_robot_idf: advertises a single BLE
service; each capability (LED, WiFi, motors, sensors, ...) is a
characteristic within that service. The dashboard connects to Pi and
ESP32 robots identically.

Run:
    pip install -r requirements.txt
    python3 pi_robot.py
"""

import ast
import asyncio
import base64
import hashlib
import json
import logging
import os
import shlex
import socket
import subprocess
import sys
import time

# version.py is stamped by Makefile / CI (publish-pi-firmware) with the short
# SHA of the commit that built this firmware. Missing on hand-edited dev
# builds; surfaced as fw-info.version so the dashboard can show "running
# abc1234" alongside the manifest's "flashing def5678".
try:
    from version import SHA as _VERSION_SHA  # type: ignore
except Exception:
    _VERSION_SHA = None

from bless import (
    BlessServer,
    BlessGATTCharacteristic,
    GATTCharacteristicProperties,
    GATTAttributePermissions,
)
from gpiozero import LED, Motor

# UUIDs generated from protocol/uuids.json (tools/gen-uuids.py). Edit the
# JSON + `make gen-uuids` to add a characteristic; ESP32 firmware AND the
# dashboard pull from the same source so a typo can't silently desync the
# protocol. Channel role-comments live next to their handlers below.
from uuids import (  # noqa: F401 — re-exported for clarity / import sites elsewhere
    SERVICE_UUID,
    LED_CHAR_UUID,
    WIFI_SCAN_CHAR_UUID,
    WIFI_JOIN_CHAR_UUID,
    WIFI_STATUS_CHAR_UUID,
    OTA_DATA_CHAR_UUID,
    OTA_STATUS_CHAR_UUID,
    FW_INFO_CHAR_UUID,
    MOTOR_CHAR_UUID,
    CAMERA_SIGNAL_CHAR_UUID,
    CAMERA_STATUS_CHAR_UUID,
    OPS_CHAR_UUID,
    ROBOT_STATUS_CHAR_UUID,
    OPS_RESPONSE_CHAR_UUID,
    TELEMETRY_CHAR_UUID,
    SIGNAL_CHAR_UUID,
)

# Capability schema, built at startup from config. Types name a UI/data
# shape (toggle, signed-pair, wifi-scan, bundle-ota, webrtc-installable,
# command). `pin` / `pins` declare GPIO header positions for the dashboard's
# pinout view.
def _build_caps() -> list:
    # Stay LEAN — BLE reads cap at ATT MTU (~180 B on macOS/Chrome), so
    # carrying full UUIDs per capability blows past it and the dashboard
    # gets truncated JSON. Dashboard maps cap name → char UUIDs via its own
    # constants (public/ble.js).
    caps: list[dict] = []
    if LED_ENABLED:
        caps.append({"name": "led", "type": "toggle",
                     "pin": LED_PIN, "pin_mode": "out"})
    if MOTORS_ENABLED:
        caps.append({"name": "motors", "type": "signed-pair",
                     "range": [-100, 100], "pins": MOTORS_PINS, "pin_mode": "pwm"})
    caps.append({"name": "wifi", "type": "wifi-scan"})
    caps.append({"name": "ota", "type": "bundle-ota"})
    if CAMERA_ENABLED is not False:
        caps.append({"name": "camera", "type": "webrtc-installable"})
    caps.append({"name": "ops", "type": "command"})
    return caps


# fw-info computed per-read via _fw_info_snapshot() — not a module constant
# because `authorized` mutates when enroll-key adds a dashboard pubkey.

# Every write resets the timer; silence reverts to (0, 0). Safe default on
# disconnect; no redundant channel required.
MOTOR_WATCHDOG_MS = 500

# Control-loop invariants — see .claude/CLAUDE.md. LLM-issued motion comes
# as a 4-byte payload [l, r, dur_hi, dur_lo] with a duration_ms that the
# firmware honors by auto-stopping at the end of the pulse. Magnitude and
# duration are clamped to these caps regardless of what the dashboard
# sends; firmware is the safety floor, not Pip / Claude.
LLM_MAX_SPEED = 40
LLM_MAX_DURATION_MS = 2000

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

# Capability config keys (written by the Customize-card flow to the boot partition):
#   led_enabled     bool — advertise the LED char
#   led_pin         int  — BCM pin for the LED
#   motors_enabled  bool — advertise the motor char
#   motors_pins     {left:{in1,in2}, right:{in1,in2}} — H-bridge direction pins
#   camera_enabled  "auto" | true | false
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
# H-bridge-agnostic: works with L298N, DRV8833, TB6612, etc. Defaults
# intentionally avoid GPIO 17 (LED default) — a shared pin makes the
# gpiozero Motor() init raise GPIOPinInUse and BOTH motor drivers end up
# None in the try/except, which silently breaks control while leaving
# the L298N's floating inputs to run a wheel.
MOTORS_PINS    = _config.get("motors_pins", {
    "left":  {"in1": 5,  "in2": 6},
    "right": {"in1": 13, "in2": 26},
})
CAMERA_ENABLED = _config.get("camera_enabled", "auto")  # "auto" | True | False

# Dashboards the robot trusts. Each .pub is one line:
#     ssh-ed25519 <base64> [comment]
# Written by firstrun from /boot/firmware/dashboard.pub, and appended by the
# enroll-key ops verb. Fingerprint format matches auth.js (SHA256:<b64>).
AUTH_DIR = "/boot/firmware/pi-robot-auth"

def _ssh_fingerprint(pub_line: str) -> str:
    parts = pub_line.strip().split()
    if len(parts) < 2 or parts[0] != "ssh-ed25519":
        raise ValueError("bad pubkey line")
    wire = base64.b64decode(parts[1])
    h = hashlib.sha256(wire).digest()
    return "SHA256:" + base64.b64encode(h).rstrip(b"=").decode("ascii")

def _load_authorized_pubs() -> list[dict]:
    out = []
    try:
        names = sorted(os.listdir(AUTH_DIR))
    except FileNotFoundError:
        return out
    for name in names:
        if not name.endswith(".pub"):
            continue
        path = os.path.join(AUTH_DIR, name)
        try:
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    out.append({"line": line, "fingerprint": _ssh_fingerprint(line), "path": path})
        except Exception as e:
            log.warning("auth: skipping %s: %s", path, e)
    return out

# Populated in main() after the logger is configured.
_authorized_pubs: list[dict] = []

def _fw_info_snapshot() -> dict:
    info: dict = {
        "type": "pi",
        "bundle_url": "firmware/pi_robot/ota-manifest.json",
        "caps": _build_caps(),
        "authorized": [p["fingerprint"] for p in _authorized_pubs],
    }
    if _VERSION_SHA:
        info["version"] = _VERSION_SHA
    return info

OTA_OP_ABORT = 0x00
OTA_OP_BEGIN = 0x01
OTA_OP_CHUNK = 0x02
OTA_OP_COMMIT = 0x03

# Camera opcodes share the OTA pattern: begin-stream, chunk, commit, stop.
CAM_OP_BEGIN   = 0x01
CAM_OP_CHUNK   = 0x02
CAM_OP_COMMIT  = 0x03
CAM_OP_STOP    = 0x04

# Catch broadly: a broken av/aiortc install can raise OSError, AttributeError,
# or partial-module-loaded errors that aren't ImportError. Silently degrading
# to "no camera" is preferable to crashing BLE — the dashboard stays reachable
# so the user can SSH / re-install / pick a different image.
_camera_available = False
_camera_import_err = None
if CAMERA_ENABLED is not False:
    try:
        from picamera2 import Picamera2  # type: ignore
        from aiortc import (  # type: ignore
            RTCPeerConnection, RTCSessionDescription, RTCIceCandidate,
            RTCConfiguration, RTCIceServer, MediaStreamTrack,
        )
        from aiortc.rtcrtpsender import RTCRtpSender  # type: ignore
        import aiohttp  # type: ignore
        import av  # type: ignore
        import fractions
        _camera_available = True
    except Exception as _e:  # noqa: BLE001 — see comment above
        _camera_import_err = f"{type(_e).__name__}: {_e}"

logging.basicConfig(format="%(asctime)s %(message)s", level=logging.INFO)
log = logging.getLogger("pi_robot")

def _pin_conflicts() -> list[tuple[int, list[str]]]:
    """Reports GPIOs claimed by more than one capability. Catches the
    classic pi-robot.conf trap — e.g. LED and motors.left.in1 both on
    GPIO 17 causes gpiozero to raise GPIOPinInUse, the Motor try/except
    silently drops both drivers, and the L298N's floating inputs spin
    a wheel."""
    claimed: dict[int, list[str]] = {}
    if LED_ENABLED:
        claimed.setdefault(LED_PIN, []).append("led")
    if MOTORS_ENABLED:
        for side, pins in MOTORS_PINS.items():
            for role, pin in pins.items():
                claimed.setdefault(int(pin), []).append(f"motors.{side}.{role}")
    return [(pin, tags) for pin, tags in claimed.items() if len(tags) > 1]

_conflicts = _pin_conflicts()
for _pin, _tags in _conflicts:
    log.error("GPIO %d claimed by multiple caps: %s — edit pi-robot.conf or the Pinout dialog to resolve",
              _pin, " + ".join(_tags))
if _conflicts:
    # Refuse to initialize motors rather than leave them in undefined state.
    # LED still goes through (it's usually the one the user meant to keep).
    log.error("motors disabled due to pin conflict(s)")
    MOTORS_ENABLED = False

led = LED(LED_PIN) if LED_ENABLED else None

# gpiozero's Motor.stop() drives both pins LOW (coast) — matches watchdog's
# safe default.
_motor_left_drv: Motor | None = None
_motor_right_drv: Motor | None = None
if MOTORS_ENABLED:
    try:
        # Optional ENA/ENB pins let the user PWM the driver's enable line
        # instead of the direction pins. When set, gpiozero PWMs the enable;
        # IN1/IN2 stay digital. Default: PWM on direction pins, ENA/ENB
        # jumpers on (always-enabled).
        _left_pins = MOTORS_PINS["left"]
        _right_pins = MOTORS_PINS["right"]
        _left_kwargs  = {"forward": _left_pins["in1"],  "backward": _left_pins["in2"]}
        _right_kwargs = {"forward": _right_pins["in1"], "backward": _right_pins["in2"]}
        if "ena" in _left_pins:  _left_kwargs["enable"]  = _left_pins["ena"]
        if "enb" in _right_pins: _right_kwargs["enable"] = _right_pins["enb"]
        _motor_left_drv  = Motor(**_left_kwargs)
        _motor_right_drv = Motor(**_right_kwargs)
    except Exception as e:
        log.warning("motor init failed: %s", e)
        _motor_left_drv = _motor_right_drv = None
_led_state = 0
_server: BlessServer | None = None
_loop: asyncio.AbstractEventLoop | None = None
_wifi_status: dict = {"st": "idle"}
_wifi_scan: list[dict] = []
_ota_status: dict = {"st": "idle", "n": 0}
_ota_buffer: bytearray = bytearray()
_ota_size: int = 0
_ota_last_reported_n: int = 0
_ota_last_reported_at: float = 0.0
_motor_left: int = 0
_motor_right: int = 0
_motor_last_write_at: float = 0.0
# Incremented on every motor write (joystick OR pulse). A scheduled pulse-
# stop task only fires if the pulse_id it captured is still current — so a
# human joystick write between pulse-start and pulse-end invalidates the
# scheduled stop and the joystick's command wins.
_motor_pulse_id: int = 0

_robot_status: dict = {"st": "ready"}

_cam_pc = None
_cam_track = None
_cam_buf: bytearray = bytearray()
_cam_expected: int = 0

CAM_TURN_ENDPOINT = "https://proxy.neevs.io/cloudflare/turn"


async def _cam_fetch_ice_servers() -> list:
    """Mirrors pairing.js — Cloudflare TURN creds via proxy.neevs.io,
    STUN fallback if the proxy is down. Lets cross-network dashboards
    pull camera frames when host candidates can't reach the Pi."""
    if not _camera_available:
        return []
    fallback = [
        RTCIceServer(urls="stun:stun.l.google.com:19302"),
        RTCIceServer(urls="stun:stun.cloudflare.com:3478"),
    ]
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(CAM_TURN_ENDPOINT, timeout=aiohttp.ClientTimeout(total=5)) as r:
                if r.status != 200:
                    raise RuntimeError(f"turn: {r.status}")
                payload = await r.json()
        servers = list(fallback)
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
        log.info("camera turn fetch failed, STUN-only: %s", e)
        return fallback
# Camera status states:
#   "uninstalled" → stack absent, dashboard offers install.
#   "installing"  → in-progress (step + log fields).
#   "idle"        → stack loaded, ready for an offer.
_cam_status: dict = {"st": "idle" if _camera_available else "uninstalled"}
_cam_installing: bool = False


def device_name() -> str:
    """BR-XXXX with a stable per-chip suffix, matching ESP32 naming."""
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
    return f"BR-{suffix}"


def _json_bytes(obj) -> bytearray:
    return bytearray(json.dumps(obj, separators=(",", ":")).encode("utf-8"))


def _publish(char_uuid: str, value: bytearray) -> None:
    if _server is None:
        return
    ch = _server.get_characteristic(char_uuid)
    if ch is not None:
        ch.value = value
    _server.update_value(SERVICE_UUID, char_uuid)


# ── BLE-signaled WebRTC (Phase 2.F.1) ─────────────────────────────────────
#
# Dashboard writes a chunked SDP offer to SIGNAL_CHAR_UUID. We reassemble,
# forward to pi-robot-rtc.service over /run/pi-robot-rtc.sock, get a
# non-trickle answer back, notify it to the dashboard chunked. The actual
# WebRTC peer lives in pi_robot_rtc.py (low-priv `robot` user); this
# process (root) just shuttles SDP between BLE and the local socket.
#
# Wire format on the SIGNAL char (both directions, mirrors OTA/snapshot):
#   0x01 [u16 BE total]   begin
#   0x02 [bytes]          chunk
#   0x03                  commit
#   0xFF [utf8 msg]       error (notify-only)

_LOCAL_RTC_SOCK = "/run/pi-robot-rtc.sock"
_SIG_BLE_CHUNK = 100
_SIG_MAX_OFFER = 8192

_signal_offer_buf: bytearray | None = None
_signal_offer_total: int = 0


def _signal_handle_write(data: bytes) -> None:
    """Chunked reassembler. Same opcode protocol as OTA."""
    global _signal_offer_buf, _signal_offer_total
    if not data:
        return
    op = data[0]
    if op == 0x01:
        if len(data) < 3:
            _signal_publish_error("bad begin")
            return
        total = (data[1] << 8) | data[2]
        if total == 0 or total > _SIG_MAX_OFFER:
            _signal_publish_error("offer size out of range")
            return
        _signal_offer_buf = bytearray()
        _signal_offer_total = total
    elif op == 0x02:
        if _signal_offer_buf is None:
            return
        if len(_signal_offer_buf) + (len(data) - 1) > _signal_offer_total:
            _signal_offer_buf = None
            _signal_publish_error("chunk overflow")
            return
        _signal_offer_buf.extend(data[1:])
    elif op == 0x03:
        if _signal_offer_buf is None or len(_signal_offer_buf) != _signal_offer_total:
            _signal_offer_buf = None
            _signal_publish_error("offer incomplete")
            return
        try:
            offer_sdp = _signal_offer_buf.decode("utf-8")
        except UnicodeDecodeError:
            _signal_offer_buf = None
            _signal_publish_error("offer not utf-8")
            return
        _signal_offer_buf = None
        _schedule(_signal_send_to_rtc(offer_sdp))


async def _signal_send_to_rtc(offer_sdp: str) -> None:
    """One-shot RPC to pi-robot-rtc.service over Unix socket: send offer JSON,
    read answer JSON, notify back over BLE."""
    try:
        reader, writer = await asyncio.open_unix_connection(_LOCAL_RTC_SOCK)
    except (OSError, FileNotFoundError) as e:
        log.warning("signal: rtc unreachable (%s) — is pi-robot-rtc.service up?", e)
        _signal_publish_error("rtc unreachable")
        return
    try:
        writer.write((json.dumps({"type": "offer", "sdp": offer_sdp}) + "\n").encode())
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout=10)
        if not line:
            _signal_publish_error("rtc closed without reply")
            return
        msg = json.loads(line)
        if msg.get("type") == "answer" and "sdp" in msg:
            _signal_publish_answer(msg["sdp"])
        else:
            _signal_publish_error(msg.get("error", "no answer")[:120])
    except asyncio.TimeoutError:
        _signal_publish_error("rtc rpc timeout")
    except (OSError, json.JSONDecodeError) as e:
        log.exception("signal rtc rpc failed")
        _signal_publish_error(str(e)[:120])
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


def _signal_publish_answer(sdp: str) -> None:
    """Chunked notify (begin → chunks → commit). Same envelope as OTA."""
    sdp_bytes = sdp.encode("utf-8")
    total = len(sdp_bytes)
    if total == 0 or total > 0xFFFF:
        _signal_publish_error("answer size out of range")
        return
    _publish(SIGNAL_CHAR_UUID, bytearray([0x01, (total >> 8) & 0xff, total & 0xff]))
    for off in range(0, total, _SIG_BLE_CHUNK):
        chunk = bytearray([0x02]) + sdp_bytes[off:off + _SIG_BLE_CHUNK]
        _publish(SIGNAL_CHAR_UUID, chunk)
    _publish(SIGNAL_CHAR_UUID, bytearray([0x03]))


def _signal_publish_error(msg: str) -> None:
    payload = bytearray([0xFF]) + msg.encode("utf-8", errors="replace")[:64]
    _publish(SIGNAL_CHAR_UUID, payload)
    log.warning("signal: %s", msg)


def _set_robot_status(st: str, msg: str | None = None) -> None:
    """Top-level robot state. Published on notify so the dashboard renders
    'rebooting in 2s' instead of a mystery disconnect."""
    global _robot_status
    _robot_status = {"st": st}
    if msg:
        _robot_status["msg"] = msg
    _publish(ROBOT_STATUS_CHAR_UUID, _json_bytes(_robot_status))
    log.info("robot-status → %s", _robot_status)


def _wlan_ip() -> str | None:
    """Current IPv4 on wlan0, no CIDR. None on failure."""
    try:
        proc = subprocess.run(
            ["nmcli", "-g", "IP4.ADDRESS", "dev", "show", "wlan0"],
            capture_output=True, timeout=3,
        )
        for line in proc.stdout.decode(errors="replace").splitlines():
            line = line.strip()
            if line:
                return line.split("/")[0]
    except Exception:
        pass
    return None


def _set_status(st: str, ssid: str | None = None, err: str | None = None) -> None:
    global _wifi_status
    _wifi_status = {"st": st}
    if ssid:
        _wifi_status["ssid"] = ssid
    if err:
        _wifi_status["err"] = err
    if st == "joined":
        ip = _wlan_ip()
        if ip:
            _wifi_status["ip"] = ip
    _publish(WIFI_STATUS_CHAR_UUID, _json_bytes(_wifi_status))
    log.info("wifi-status → %s", _wifi_status)


async def _wifi_scan_task() -> None:
    # Scan is orthogonal to connection state; doesn't touch wifi-status.
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


# Bundle-OTA destination allowlist. Anything outside is rejected so a
# malicious manifest can't overwrite /etc/passwd. Computed from $HOME so
# OTAs work for any service-user name (pi, robot, ...).
def _derive_install_home() -> str:
    """pi-robot.service runs as root (bless needs it) so ~ → /root. Wrong.
    Derive from __file__: <HOME>/better-robotics/firmware/pi_robot/pi_robot.py."""
    parts = os.path.abspath(__file__).split(os.sep)
    try:
        idx = parts.index("better-robotics")
        return os.sep.join(parts[:idx]) or "/"
    except ValueError:
        return os.path.expanduser("~")

_OTA_HOME = _derive_install_home()
_OTA_USER = os.path.basename(_OTA_HOME) or "root"
_OTA_ALLOWED_DEST_PREFIXES = (
    f"{_OTA_HOME}/better-robotics/firmware/",
    "/etc/systemd/system/",
    "/usr/local/bin/",
    "/boot/firmware/",
    # avahi-daemon's drop-in dir, for mDNS publishing of /health.
    "/etc/avahi/services/",
)

# Manifest authors write `$HOME`/`__HOME__` and `__USER__` in paths or file
# contents; all expand at apply time to the service user's values. Keeps the
# manifest + shipped files (pi-robot.service, serial-getty drop-in, …) free
# of a hardcoded username.
def _ota_expand(s: str) -> str:
    return s.replace("$HOME", _OTA_HOME).replace("__HOME__", _OTA_HOME).replace("__USER__", _OTA_USER)


def _ota_dest_allowed(dest: str) -> bool:
    norm = os.path.realpath(_ota_expand(dest))
    return any(norm.startswith(p) for p in _OTA_ALLOWED_DEST_PREFIXES)


async def _apply_bundle(bundle: dict) -> None:
    """Multi-file OTA. bundle shape:
        {"manifest": {"files": [...], "post_install": [...], "restart": "..."},
         "files":    {"<src>": "<base64>", ...}}
    Atomicity across files is best-effort: small window between renames,
    good enough for our update cadence."""
    global _ota_buffer
    _set_robot_status("installing", "applying bundle")
    manifest = bundle.get("manifest") or {}
    blobs    = bundle.get("files") or {}
    files    = manifest.get("files") or []
    if not files:
        _set_ota_status("failed", err="bundle has no files")
        return

    staged: list[tuple[str, str, int]] = []  # (dest, tmp, mode)
    for spec in files:
        src  = spec.get("src")
        dest = _ota_expand(spec.get("dest") or "")
        mode = int(spec.get("mode", "644"), 8)
        if not src or not dest:
            _set_ota_status("failed", err=f"bad file spec: {spec}")
            return
        if not _ota_dest_allowed(dest):
            _set_ota_status("failed", err=f"dest not allowed: {dest}"[:120])
            return
        b64 = blobs.get(src)
        if not b64:
            _set_ota_status("failed", err=f"bundle missing file: {src}")
            return
        try:
            content = base64.b64decode(b64)
        except Exception as e:
            _set_ota_status("failed", err=f"bad b64 for {src}: {e}"[:120])
            return
        # __HOME__ / __USER__ in text files (pi-robot.service, getty drop-in,
        # …). Same substitution firstrun does, so shipped units work for any
        # service-user name without a repo-side template step.
        content = content.replace(b"__HOME__", _OTA_HOME.encode())
        content = content.replace(b"__USER__", _OTA_USER.encode())
        # Defensive check: never deploy a text file with leftover placeholders.
        # If we got here with `__HOME__` still in the content, _OTA_HOME is
        # empty (would have replaced with nothing) or the placeholder format
        # changed. Fail loudly instead of writing a broken systemd unit.
        if not src.endswith((".whl", ".bin", ".img")):
            for placeholder in (b"__HOME__", b"__USER__"):
                if placeholder in content:
                    _set_ota_status(
                        "failed",
                        err=f"unsubst {placeholder.decode()} in {src} "
                            f"(_OTA_HOME={_OTA_HOME!r} _OTA_USER={_OTA_USER!r})"[:120],
                    )
                    return
        if dest.endswith(".py"):
            try:
                ast.parse(content)
            except SyntaxError as e:
                _set_ota_status("failed", err=f"SyntaxError in {src}: {e}"[:120])
                return
        os.makedirs(os.path.dirname(dest) or "/", exist_ok=True)
        tmp = dest + ".new"
        with open(tmp, "wb") as f:
            f.write(content)
        os.chmod(tmp, mode)
        staged.append((dest, tmp, mode))

    for dest, tmp, _ in staged:
        os.replace(tmp, dest)

    for cmd in manifest.get("post_install") or []:
        # Same $HOME/__HOME__/__USER__ substitution as file dests/contents.
        # shell=True for redirection, ||, &&, globs. Same trust boundary as
        # the bundle: if you can inject here you can replace pi_robot.py
        # wholesale.
        rc = subprocess.run(_ota_expand(cmd), shell=True, check=False, capture_output=True).returncode
        if rc != 0:
            _set_ota_status("failed", err=f"post_install: {cmd} rc={rc}"[:120])
            return

    _set_ota_status("done", n=len(_ota_buffer), total=_ota_size)
    _ota_buffer = bytearray()
    await asyncio.sleep(0.5)  # let the notify flush
    if manifest.get("reboot"):
        # Kernel module changes (cmdline.txt swaps) need a reboot; service
        # restart won't pick them up.
        _set_robot_status("rebooting", "post-install")
        subprocess.Popen(["systemctl", "reboot"])
    elif manifest.get("restart"):
        _set_robot_status("restarting", f"post-install → {manifest['restart']}")
        subprocess.Popen(["systemctl", "restart", f"{manifest['restart']}.service"])


async def _ota_commit() -> None:
    global _ota_buffer, _ota_size
    try:
        if len(_ota_buffer) != _ota_size:
            _set_ota_status("failed", err=f"size mismatch {len(_ota_buffer)} != {_ota_size}")
            _ota_buffer = bytearray()
            return
        try:
            bundle = json.loads(_ota_buffer.decode("utf-8"))
        except Exception as e:
            _set_ota_status("failed", err=f"bundle json: {e}"[:120])
            _ota_buffer = bytearray()
            return
        await _apply_bundle(bundle)
    except Exception as e:
        _set_ota_status("failed", err=str(e)[:120])


def _ota_handle_write(data: bytearray) -> None:
    global _ota_buffer, _ota_size, _ota_last_reported_n, _ota_last_reported_at
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
        # Reset rate-limit window so first chunk notifies immediately.
        _ota_last_reported_n = 0
        _ota_last_reported_at = 0.0
        _set_ota_status("receiving", n=0, total=_ota_size)
    elif op == OTA_OP_CHUNK:
        _ota_buffer.extend(data[1:])
        # Rate-limit progress notifies: ~9000 chunks/bundle would saturate BLE.
        # Publish only every 32 KB or 250 ms, whichever comes first.
        now = time.monotonic()
        n = len(_ota_buffer)
        if (n - _ota_last_reported_n >= 32768
                or now - _ota_last_reported_at >= 0.25):
            _ota_last_reported_n = n
            _ota_last_reported_at = now
            _set_ota_status("receiving", n=n, total=_ota_size)
    elif op == OTA_OP_COMMIT:
        _set_ota_status("committing", n=len(_ota_buffer), total=_ota_size)
        _schedule(_ota_commit())
    else:
        _set_ota_status("failed", err=f"unknown op 0x{op:02x}")


def _drive(motor: Motor | None, value: int) -> None:
    """Signed [-100, 100] → gpiozero Motor. Sign = direction, magnitude = PWM duty."""
    if motor is None:
        return
    speed = max(-100, min(100, value)) / 100.0
    if speed > 0:
        motor.forward(speed)
    elif speed < 0:
        motor.backward(-speed)
    else:
        motor.stop()


def _apply_motors(left: int, right: int) -> None:
    global _motor_left, _motor_right
    # Dashboard re-publishes a held joystick at ~60 Hz; skip BLE notify +
    # PWM re-issue when nothing changed. Watchdog still resets on every
    # char-write upstream.
    if left == _motor_left and right == _motor_right:
        return
    _motor_left, _motor_right = left, right
    _drive(_motor_left_drv, left)
    _drive(_motor_right_drv, right)
    _publish(MOTOR_CHAR_UUID, bytearray([left & 0xff, right & 0xff]))
    log.info("motors → (%+d, %+d)", left, right)


def _motor_handle_write(data: bytearray) -> None:
    """Motor char accepts two payload shapes:
      2 bytes [l, r]                   — persistent (user joystick). Watchdog
                                          stops after MOTOR_WATCHDOG_MS silence.
                                          No LLM caps (user controls directly).
      4 bytes [l, r, dur_hi, dur_lo]  — time-bounded pulse (LLM). Clamped to
                                          LLM_MAX_SPEED / LLM_MAX_DURATION_MS,
                                          firmware auto-stops at duration end.
    Any write bumps _motor_pulse_id so a later write invalidates an earlier
    pulse's scheduled stop — the newer command always wins.
    """
    global _motor_last_write_at, _motor_pulse_id
    def signed(b: int) -> int:
        return b - 256 if b >= 128 else b
    if len(data) == 2:
        _motor_last_write_at = asyncio.get_event_loop().time()
        _motor_pulse_id += 1
        _apply_motors(signed(data[0]), signed(data[1]))
    elif len(data) == 4:
        l = max(-LLM_MAX_SPEED, min(LLM_MAX_SPEED, signed(data[0])))
        r = max(-LLM_MAX_SPEED, min(LLM_MAX_SPEED, signed(data[1])))
        duration_ms = max(50, min(LLM_MAX_DURATION_MS, (data[2] << 8) | data[3]))
        _motor_last_write_at = asyncio.get_event_loop().time()
        _motor_pulse_id += 1
        pid = _motor_pulse_id
        _apply_motors(l, r)
        _schedule(_pulse_stop(duration_ms / 1000.0, pid))
    else:
        log.warning("motor: unexpected payload length %d", len(data))


async def _pulse_stop(duration_s: float, pulse_id: int) -> None:
    await asyncio.sleep(duration_s)
    # Joystick or a newer pulse may have taken over — only stop if we're
    # still the active pulse. Watchdog still covers the crash path.
    if _motor_pulse_id == pulse_id:
        _apply_motors(0, 0)


def _cam_send(obj: dict) -> None:
    """Chunked notify on camera-status. 180 B/chunk fits typical ATT MTU."""
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
    """640x480 @ 15fps — CPU-reasonable on a Pi 4, bandwidth-safe for WebRTC over WiFi."""
    kind = "video"

    def __init__(self) -> None:
        super().__init__()
        # Probe libcamera first — Picamera2() raises "list index out of range"
        # deep inside if no camera is detected, which is unhelpful to the user.
        # Surface a clear "no camera detected" instead so the actual cause
        # (loose ribbon, wrong CAM port, libcamera not seeing hardware) gets
        # reported rather than a cryptic internal error.
        cams = Picamera2.global_camera_info()
        if not cams:
            raise RuntimeError(
                "no camera detected by libcamera — check ribbon cable seating, "
                "CAM port (Pi 5 has CAM0/CAM1), and `libcamera-hello --list-cameras`"
            )
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
        # Picamera2's "RGB888" config actually delivers bytes in BGR memory
        # order (libcamera convention — name follows little-endian byte
        # arrangement, not pixel order). Tell PyAV the truth so red and blue
        # don't swap downstream — symptom is purple skin / blue oranges.
        frame = av.VideoFrame.from_ndarray(arr, format="bgr24")
        self._pts += 1
        frame.pts = self._pts
        frame.time_base = self._time_base
        return frame

    def stop(self) -> None:
        # close() after stop() releases the CSI allocation; without it, a
        # re-Start fails with "Camera __init__ sequence did not complete."
        # until reboot.
        try: self.camera.stop()
        except Exception: pass
        try: self.camera.close()
        except Exception: pass
        super().stop()


async def _run_install_cmd(label: str, argv: list[str]) -> tuple[int, list[str]]:
    _set_cam_status(st="installing", step=label)
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    tail: list[str] = []  # last N lines, echoed to dashboard on failure
    while True:
        line = await proc.stdout.readline()
        if not line:
            break
        text = line.decode(errors="replace").strip()
        if text:
            _set_cam_status(st="installing", step=label, log=text[:160])
            tail.append(text)
            if len(tail) > 12:
                tail.pop(0)
    rc = await proc.wait()
    return rc, tail


async def _cam_install() -> None:
    """On success, restart the service so the new imports load."""
    global _cam_installing
    if _camera_available:
        _set_cam_status(st="idle")
        return
    if _cam_installing:
        return
    _cam_installing = True
    try:
        def fail(step: str, rc: int, tail: list[str]) -> None:
            # Show the last informative line — pip surfaces its real error at
            # the tail (ERROR: Could not find a version… / Failed to build X).
            err_line = next(
                (t for t in reversed(tail) if "error" in t.lower() or "failed" in t.lower()),
                tail[-1] if tail else "",
            )
            _set_cam_status(st="install_failed", err=f"{step} rc={rc}: {err_line[:160]}")

        rc, tail = await _run_install_cmd("apt update", ["apt-get", "update"])
        if rc != 0:
            fail("apt update", rc, tail); return
        rc, tail = await _run_install_cmd(
            "apt install",
            # Runtime-only: aiortc / av / cryptography / cffi / pylibsrtp
            # ship aarch64 manylinux wheels on PyPI, so pip doesn't need
            # source build tools. libssl-dev was previously in this list
            # but hit Trixie's t64 transition (unsatisfiable libssl3t64 pin)
            # and killed the install. python3-pip covers "no pip" images.
            ["apt-get", "install", "-y", "--no-install-recommends",
             "python3-picamera2", "ffmpeg", "python3-pip"],
        )
        if rc != 0:
            fail("apt install", rc, tail); return
        # sys.executable targets the venv's python. Pi OS's system python is
        # externally-managed (PEP 668) — pip refuses to touch it. The venv
        # is unmanaged, so packages install cleanly.
        rc, tail = await _run_install_cmd(
            "pip install",
            [sys.executable, "-m", "pip", "install", "aiortc", "av"],
        )
        if rc != 0:
            fail("pip install", rc, tail); return
        _set_cam_status(st="installed", step="restarting service")
        await asyncio.sleep(2)  # let the notify flush before we die
        subprocess.Popen(["systemctl", "restart", "pi-robot"])
    except Exception as e:
        _set_cam_status(st="install_failed", err=str(e)[:160])
    finally:
        _cam_installing = False


def _ops_respond(payload: dict) -> None:
    """Chunked notify on ops-response — same opcode protocol as OTA (0x01 begin
    + u32 length, 0x02 chunk, 0x03 commit). Used for request/response ops like
    get-log where a plain write-ack isn't enough."""
    if _server is None:
        return
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    begin = bytearray(5)
    begin[0] = 0x01
    begin[1:5] = len(data).to_bytes(4, "big")
    _publish(OPS_RESPONSE_CHAR_UUID, begin)
    for i in range(0, len(data), 180):
        _publish(OPS_RESPONSE_CHAR_UUID, bytearray([0x02]) + data[i:i + 180])
    _publish(OPS_RESPONSE_CHAR_UUID, bytearray([0x03]))


async def _get_config_task() -> None:
    """Returns /boot/firmware/pi-robot.conf bytes so the dashboard can render
    the current pin setup and write back an edited version."""
    try:
        with open(CONFIG_PATH) as f:
            text = f.read()
        _ops_respond({"op": "get-config", "text": text})
    except FileNotFoundError:
        _ops_respond({"op": "get-config", "text": "{}"})
    except Exception as e:
        _ops_respond({"op": "get-config", "err": str(e)[:120]})


async def _get_log(lines: int, unit: str) -> None:
    lines = max(1, min(lines, 500))
    try:
        proc = await asyncio.create_subprocess_exec(
            "journalctl", "-u", f"{unit}.service", "-n", str(lines), "--no-pager",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await proc.communicate()
        # Cap text at 16 KB so a runaway log doesn't saturate BLE notifies.
        text = out.decode(errors="replace")[-16000:]
    except Exception as e:
        text = f"journalctl failed: {e}"
    _ops_respond({"op": "get-log", "unit": unit, "text": text})


def _read_uptime_s() -> int:
    try:
        with open("/proc/uptime") as f:
            return int(float(f.read().split()[0]))
    except Exception:
        return 0


def _read_mem_free_mb() -> int:
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024  # kB → MB
    except Exception:
        pass
    return 0


def _read_soc_temp_c() -> float | None:
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return int(f.read()) / 1000.0
    except (FileNotFoundError, ValueError, OSError):
        return None


async def _telemetry_task() -> None:
    """Periodic vitals notify. 6s cadence catches spikes without saturating
    BLE. Payload < ~60 B fits one ATT."""
    while True:
        try:
            t: dict = {
                "uptime_s": _read_uptime_s(),
                "mem_free_mb": _read_mem_free_mb(),
            }
            temp = _read_soc_temp_c()
            if temp is not None:
                t["temp_c"] = round(temp, 1)
            _publish(TELEMETRY_CHAR_UUID, _json_bytes(t))
        except Exception as e:
            log.warning("telemetry: %s", e)
        await asyncio.sleep(6)


async def _delayed_system_action(kind: str) -> None:
    """Announce the upcoming disconnect on robot-status before firing, so
    the dashboard shows 'was rebooting' instead of a blank drop. 2s lets
    the BLE notify flush."""
    if kind == "reboot":
        _set_robot_status("rebooting", "in 2s")
        await asyncio.sleep(2)
        subprocess.Popen(["systemctl", "reboot"])
    elif kind == "restart-service":
        _set_robot_status("restarting", "service restart in 2s")
        await asyncio.sleep(2)
        subprocess.Popen(["systemctl", "restart", "pi-robot.service"])


def _enroll_key(pubkey_line: str) -> tuple[bool, str]:
    """Add a dashboard pubkey to trusted. Idempotent. Filename encodes the
    fingerprint so it's findable by hand."""
    global _authorized_pubs
    try:
        fp = _ssh_fingerprint(pubkey_line)
    except ValueError as e:
        return False, str(e)
    if any(p["fingerprint"] == fp for p in _authorized_pubs):
        return True, f"already enrolled ({fp})"
    # Fingerprint → filename: b64 has '+' '/' '='; translate to filesystem-safe.
    slug = fp.replace("SHA256:", "").replace("/", "_").replace("+", "-").rstrip("=")
    os.makedirs(AUTH_DIR, exist_ok=True)
    path = os.path.join(AUTH_DIR, f"{slug}.pub")
    with open(path, "w") as f:
        f.write(pubkey_line.strip() + "\n")
    os.chmod(path, 0o644)
    _authorized_pubs.append({"line": pubkey_line.strip(), "fingerprint": fp, "path": path})
    # Re-publish fw-info char value so a subsequent dashboard re-read reflects
    # the new authorized list without needing a reconnect.
    _publish(FW_INFO_CHAR_UUID, _json_bytes(_fw_info_snapshot()))
    return True, fp


def _ops_handle_write(data: bytearray) -> None:
    """Single-write JSON command channel. Message: {"op": "...", "args":{}}.
    Ops:
      restart-service — systemctl restart pi-robot.service (BLE drops).
      reboot          — systemctl reboot (BLE drops for ~30-60 s).
      install-pkg     — args.name: "camera" → run _cam_install; progress
                        streams via camera-status.
      enroll-key      — args.pubkey: "ssh-ed25519 BASE64 [comment]" → added
                        to the trusted list, written to /boot/firmware/pi-
                        robot-auth/<fp-slug>.pub."""
    try:
        msg = json.loads(bytes(data).decode("utf-8"))
    except Exception as e:
        log.warning("ops: bad JSON — %s", e)
        return
    op = msg.get("op")
    args = msg.get("args") or {}
    if op == "restart-service":
        log.info("ops: restart-service")
        _schedule(_delayed_system_action("restart-service"))
    elif op == "reboot":
        # Needed when a kernel-owned resource is stuck (camera CSI, wedged
        # USB gadget) and a service restart can't clear it.
        log.info("ops: reboot")
        _schedule(_delayed_system_action("reboot"))
    elif op == "install-pkg":
        name = args.get("name")
        if name == "camera":
            _schedule(_cam_install())
        else:
            log.warning("ops: unknown package %r", name)
    elif op == "enroll-key":
        pubkey = args.get("pubkey") or ""
        ok, detail = _enroll_key(pubkey)
        if ok:
            log.info("ops: enrolled %s", detail)
            _set_robot_status("ready", f"enrolled {detail}")
        else:
            log.warning("ops: enroll-key failed: %s", detail)
            _set_robot_status("ready", f"enroll failed: {detail}")
    elif op == "get-log":
        lines = int(args.get("lines", 50))
        unit = str(args.get("unit") or "pi-robot")
        _schedule(_get_log(lines, unit))
    elif op == "get-config":
        # Schedule on asyncio loop, not the BLE callback thread.
        # _ops_respond fires multiple chunked notifies via _publish; running
        # that alongside concurrent telemetry from the callback thread
        # glitched BlueZ enough to drop the link.
        _schedule(_get_config_task())
    elif op == "apply-staged-ota":
        # Dashboard streamed a bundle JSON to pi_robot_rtc.py over WebRTC
        # (~MB/s), which staged it to a file. We read + apply via the
        # existing _apply_bundle path. Allowlist the path so a rogue ops
        # write can't read arbitrary files.
        path = str(args.get("path") or "/tmp/pi-robot-staged-ota.json")
        if path != "/tmp/pi-robot-staged-ota.json":
            log.warning("ops: apply-staged-ota path not allowed: %r", path)
            _set_ota_status("failed", err="staged path not allowed")
            return
        _schedule(_apply_staged_ota(path))
    else:
        log.warning("ops: unknown op %r", op)


async def _apply_staged_ota(path: str) -> None:
    global _ota_buffer, _ota_size
    try:
        with open(path, "rb") as f:
            blob = f.read()
        _ota_size = len(blob)
        _ota_buffer = bytearray(blob)
        _set_ota_status("committing", n=_ota_size, total=_ota_size)
        try:
            bundle = json.loads(blob.decode("utf-8"))
        except Exception as e:
            _set_ota_status("failed", err=f"staged json: {e}"[:120])
            _ota_buffer = bytearray()
            return
        await _apply_bundle(bundle)
    except Exception as e:
        _set_ota_status("failed", err=str(e)[:120])
    finally:
        try: os.unlink(path)
        except OSError: pass


async def _cam_handle_message(msg: dict) -> None:
    """Signaling messages from the browser. t=offer | ice | stop."""
    if not _camera_available:
        if msg.get("t") != "stop":
            _set_cam_status(st="uninstalled", err="camera stack not installed")
        return
    global _cam_pc, _cam_track
    t = msg.get("t")
    d = msg.get("d") or {}
    try:
        if t == "offer":
            if _cam_pc is not None:
                await _cam_pc.close()
            ice_servers = await _cam_fetch_ice_servers()
            _cam_pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers))
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
        return _json_bytes(_fw_info_snapshot())
    if uuid == ROBOT_STATUS_CHAR_UUID:
        return _json_bytes(_robot_status)
    if uuid == TELEMETRY_CHAR_UUID:
        t: dict = {"uptime_s": _read_uptime_s(), "mem_free_mb": _read_mem_free_mb()}
        temp = _read_soc_temp_c()
        if temp is not None:
            t["temp_c"] = round(temp, 1)
        return _json_bytes(t)
    if uuid == MOTOR_CHAR_UUID:
        return bytearray([_motor_left & 0xff, _motor_right & 0xff])
    if uuid == CAMERA_STATUS_CHAR_UUID:
        # Chunked protocol — direct reads have no single value. Status
        # lands via notify on state changes.
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
    if uuid == OPS_CHAR_UUID:
        _ops_handle_write(value)
        return
    if uuid == SIGNAL_CHAR_UUID:
        _signal_handle_write(bytes(value))
        return


def _init_wifi_radio() -> None:
    """Idempotent. Step failures are logged but not fatal — BLE must come
    up even when WiFi is unavailable."""
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
    global _server, _loop, _authorized_pubs
    _loop = asyncio.get_running_loop()
    _init_wifi_radio()
    _authorized_pubs = _load_authorized_pubs()
    log.info("auth: %d authorized dashboard(s): %s",
             len(_authorized_pubs), [p["fingerprint"] for p in _authorized_pubs])
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
        # WithoutResponse lets the dashboard stream chunks without per-frame
        # ATT acks; spec rejects WithoutResponse if not advertised, and
        # Chrome's fallback is inconsistent. Advertise both so the dashboard
        # can pick.
        GATTCharacteristicProperties.write | GATTCharacteristicProperties.write_without_response,
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
        _json_bytes(_fw_info_snapshot()),
        GATTAttributePermissions.readable,
    )
    # Chunked SDP for WebRTC signaling. Bridges to pi-robot-rtc.service
    # over /run/pi-robot-rtc.sock; that service runs aiortc and produces
    # the answer. See _signal_handle_write.
    await _server.add_new_characteristic(
        SERVICE_UUID, SIGNAL_CHAR_UUID,
        GATTCharacteristicProperties.write | GATTCharacteristicProperties.notify,
        bytearray(),
        GATTAttributePermissions.writeable,
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

    if CAMERA_ENABLED is not False:
        # Register even without the stack installed so the dashboard can
        # trigger install-on-demand. After install + service restart,
        # imports succeed and signaling becomes functional.
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
        log.info("camera: %s (stack %s)",
                 "ready" if _camera_available else "install-on-demand",
                 "loaded" if _camera_available else "not installed")
    else:
        log.info("camera: disabled in pi-robot.conf")

    await _server.add_new_characteristic(
        SERVICE_UUID, OPS_CHAR_UUID,
        GATTCharacteristicProperties.write,
        bytearray(),
        GATTAttributePermissions.writeable,
    )
    await _server.add_new_characteristic(
        SERVICE_UUID, ROBOT_STATUS_CHAR_UUID,
        GATTCharacteristicProperties.read | GATTCharacteristicProperties.notify,
        _json_bytes(_robot_status),
        GATTAttributePermissions.readable,
    )
    await _server.add_new_characteristic(
        SERVICE_UUID, OPS_RESPONSE_CHAR_UUID,
        GATTCharacteristicProperties.notify,
        bytearray(),
        GATTAttributePermissions.readable,
    )
    await _server.add_new_characteristic(
        SERVICE_UUID, TELEMETRY_CHAR_UUID,
        GATTCharacteristicProperties.read | GATTCharacteristicProperties.notify,
        _json_bytes({"uptime_s": 0, "mem_free_mb": 0}),
        GATTAttributePermissions.readable,
    )

    await _server.start()
    log.info("Advertising on service %s", SERVICE_UUID)
    log.info("Ctrl+C to stop.")
    asyncio.create_task(_check_current_wifi())
    asyncio.create_task(_telemetry_task())
    if MOTORS_ENABLED:
        asyncio.create_task(_motor_watchdog_task())
    log.info("capabilities: led=%s motors=%s camera=%s", LED_ENABLED, MOTORS_ENABLED, _camera_available)
    try:
        await asyncio.Event().wait()
    finally:
        await _server.stop()


if __name__ == "__main__":
    asyncio.run(main())
