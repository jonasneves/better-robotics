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

FW_INFO = {"type": "pi", "url": "firmware/pi_robot/pi_robot.py"}

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

LED_PIN = 17       # BCM pin — change to match your wiring.
SCAN_MAX = 10      # Bounded so the full JSON fits in one ATT read.
OTA_TARGET = "/home/pi/better-robotics/firmware/pi_robot/pi_robot.py"
OTA_OP_BEGIN = 0x01
OTA_OP_CHUNK = 0x02
OTA_OP_COMMIT = 0x03

logging.basicConfig(format="%(asctime)s %(message)s", level=logging.INFO)
log = logging.getLogger("pi_robot")

led = LED(LED_PIN)
_led_state = 0
_server: BlessServer | None = None
_loop: asyncio.AbstractEventLoop | None = None
_wifi_status: dict = {"st": "idle"}
_wifi_scan: list[dict] = []
_ota_status: dict = {"st": "idle", "n": 0}
_ota_buffer: bytearray = bytearray()
_ota_size: int = 0


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


WIFI_DEBUG_LOG = "/boot/firmware/wifi-scan.log"


def _debug_log(section: str, content: str) -> None:
    """Append a diagnostic dump to the boot partition so we can read scan
    failures from macOS without SSH access to the Pi."""
    try:
        with open(WIFI_DEBUG_LOG, "a") as f:
            f.write(f"=== {section} ===\n{content}\n")
    except OSError:
        pass


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
        _debug_log(
            f"scan @ rc={proc.returncode}",
            f"STDOUT:\n{out_str}\nSTDERR:\n{err_str}",
        )
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
        _debug_log("scan exception", repr(e))


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
    return characteristic.value


def on_write(characteristic: BlessGATTCharacteristic, value: bytearray, **_) -> None:
    global _led_state
    uuid = characteristic.uuid.lower()
    if uuid == LED_CHAR_UUID:
        if len(value) == 0:
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

    await _server.start()
    log.info("Advertising on service %s", SERVICE_UUID)
    log.info("Ctrl+C to stop.")
    asyncio.create_task(_check_current_wifi())
    try:
        await asyncio.Event().wait()
    finally:
        await _server.stop()


if __name__ == "__main__":
    asyncio.run(main())
