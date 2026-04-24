#!/usr/bin/env python3
# Wi-Fi discovery — publishes the robot's presence to signal.neevs.io's
# /discover lobby so dashboards on the same wifi (same /64 IPv6 prefix
# or NATted IPv4) see the robot as "online" without scanning BLE.
#
# Complements heartbeat.py (BLE recovery plane), doesn't replace it.
# BLE remains the control channel — wifi discovery only answers "is my
# robot online without me being in BLE range?". A future iteration could
# expose a wifi control channel using the published `ip`, but presence
# is the value we ship first.
#
# stdlib-only on purpose. The signal /discover endpoint accepts REST PUT
# with a TTL — we re-PUT every 25s and the server expires us automatically
# at 60s if we crash. Avoids pulling in `websockets` and complicating the
# offline-wheels install path. The trade vs WS: ~1s slower disappearance
# when the robot drops, no auto-cleanup on socket close. Acceptable.
#
# Recovery-plane convention: zero dependency on pi_robot.py (a crash in
# the main firmware can't take this down). Helpers are duplicated from
# heartbeat.py on purpose.

import json
import socket
import subprocess
import time
import urllib.error
import urllib.request

DISCOVER_URL = "https://signal.neevs.io/discover"
TTL_MS = 60_000          # signal lobby caps at 5 min; 60s gives fast disappear
REPUBLISH_S = 25         # well below TTL so a missed PUT doesn't drop us off
RECONNECT_MAX_S = 60

_started_at = time.monotonic()


def _device_name() -> str:
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


def _ad_payload() -> bytes:
    name = _device_name()
    return json.dumps({
        "id": f"better-robotics-robot:{name}",
        "data": {
            "app": "better-robotics-robot",
            "robotId": name,
            "label": name,
            "ip": _ip(),
            "host": socket.gethostname(),
            "uptime_s": int(time.monotonic() - _started_at),
            "pi_robot": _pi_robot_state(),
        },
        "ttl": TTL_MS,
    }).encode("utf-8")


def _publish_once() -> None:
    req = urllib.request.Request(
        DISCOVER_URL,
        data=_ad_payload(),
        method="PUT",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        r.read()


def main() -> None:
    backoff = 1
    while True:
        try:
            _publish_once()
            backoff = 1
            time.sleep(REPUBLISH_S)
        except (urllib.error.URLError, OSError):
            time.sleep(backoff)
            backoff = min(backoff * 2, RECONNECT_MAX_S)


if __name__ == "__main__":
    main()
