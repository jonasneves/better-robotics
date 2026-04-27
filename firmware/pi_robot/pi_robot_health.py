#!/usr/bin/env python3
# Presence /health endpoint — minimal HTTP server bound to 0.0.0.0:81 so
# the dashboard's mDNS + cached-IP probe (public/app.js) can confirm the
# Pi is reachable on WiFi without a server-side rendezvous.
#
# Recovery-plane convention: zero dependency on pi_robot.py — runs as its
# own systemd unit, so a pi-robot.service crash leaves /health responding
# with pi_robot_service != "active" and the dashboard shows the right
# state (online but degraded). stdlib-only for the same reason.
#
# Replaces wifi_discover.py: same JSON shape the old ad carried, but pulled
# by the dashboard probe instead of pushed to signal.neevs.io. mbedTLS-
# expensive on ESP32 → unified both tiers on this transport. See CLAUDE.md
# transport-discipline.

import json
import socket
import subprocess
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

LISTEN_PORT = 81
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
    return f"BR-{suffix}"


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


def _payload() -> bytes:
    return json.dumps({
        "ok": True,
        "type": "pi",
        "robotId": _device_name(),
        "ip": _ip(),
        "uptime_s": int(time.monotonic() - _started_at),
        "pi_robot_service": _pi_robot_state(),
    }).encode("utf-8")


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            return
        body = _payload()
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        # PNA preflight from the dashboard's HTTPS origin → HTTP private IP.
        # Same envelope ESP32 sends; Max-Age caches it for a day.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    def log_message(self, fmt, *args):
        # Suppress per-request log spam — probe runs every 30 s per dashboard.
        return


def main():
    HTTPServer(("0.0.0.0", LISTEN_PORT), HealthHandler).serve_forever()


if __name__ == "__main__":
    main()
