#!/usr/bin/env python3
# Heartbeat BLE — recovery plane. Runs as its own systemd unit so the
# dashboard can still find the robot when pi-robot.service is dead. Code
# has zero dependency on pi_robot.py — a crash in the main firmware can't
# take this down. Same bless/dbus-fast deps as pi-robot because isolating
# deps isn't the goal; isolating _process_ is.
import asyncio
import json
import socket
import subprocess
import time

from bless import (
    BlessServer,
    GATTCharacteristicProperties,
    GATTAttributePermissions,
)

# Distinct UUID family from pi-robot's main service — dashboard scans for
# either, so the robot appears whether or not the main firmware is alive.
# Must match public/ble.js HEARTBEAT_*_UUID exactly.
HEARTBEAT_SVC_UUID  = "b6e8d5f3-2c9d-4bba-ae5e-6f9b8c7d5eb0"
HEARTBEAT_CHAR_UUID = "b6e8d5f3-2c9d-4bba-ae5e-6f9b8c7d5eb1"

REFRESH_S = 10
_started_at = time.monotonic()


def _device_name() -> str:
    # Duplicates pi_robot.device_name() by design — no import across the
    # recovery-plane / firmware-plane boundary.
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


def _ip() -> str | None:
    try:
        out = subprocess.check_output(["hostname", "-I"], text=True, timeout=2).split()
        return out[0] if out else None
    except Exception:
        return None


def _pi_robot_state() -> str:
    try:
        rc = subprocess.run(
            ["systemctl", "is-active", "pi-robot.service"],
            capture_output=True, text=True, timeout=2,
        )
        return (rc.stdout.strip() or "unknown")
    except Exception:
        return "unknown"


def _payload() -> bytearray:
    return bytearray(json.dumps({
        "ip": _ip(),
        "host": socket.gethostname(),
        "uptime_s": int(time.monotonic() - _started_at),
        "pi_robot": _pi_robot_state(),
    }, separators=(",", ":")).encode("utf-8"))


async def main() -> None:
    server = BlessServer(name=_device_name())
    await server.add_new_service(HEARTBEAT_SVC_UUID)
    await server.add_new_characteristic(
        HEARTBEAT_SVC_UUID, HEARTBEAT_CHAR_UUID,
        GATTCharacteristicProperties.read | GATTCharacteristicProperties.notify,
        _payload(),
        GATTAttributePermissions.readable,
    )
    await server.start()
    while True:
        await asyncio.sleep(REFRESH_S)
        try:
            char = server.get_characteristic(HEARTBEAT_CHAR_UUID)
            if char is not None:
                char.value = _payload()
        except Exception:
            pass


if __name__ == "__main__":
    asyncio.run(main())
