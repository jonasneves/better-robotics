#!/usr/bin/env python3
"""Generate firstrun.sh + patch cmdline.txt on a mounted Pi SD card.

Reads values from env vars, substitutes them into firstrun.template.sh,
writes to $BOOTFS/firstrun.sh, and ensures cmdline.txt triggers it.
Prints a URL the user can open to watch setup progress live.

Env vars (required):
    WIFI_SSID   — WiFi network for one-time install
    WIFI_PASS   — WiFi password
    USER_PASS   — sudo password for the Pi user

Env vars (optional):
    HOSTNAME        (default: betterpi)
    USER_NAME       (default: pi)
    SSH_KEY_PATH    (default: ~/.ssh/id_ed25519.pub)
    FIRMWARE_URL    (default: https://neevs.io/better-robotics/firmware/pi_robot)
    DASHBOARD_URL   (default: https://neevs.io/better-robotics/)
    BOOTFS          (default: /Volumes/bootfs)
"""

import os
import secrets
import sys
from pathlib import Path


SYSTEMD_RUN = (
    " systemd.run=/boot/firmware/firstrun.sh"
    " systemd.run_success_action=reboot"
    " systemd.unit=kernel-command-line.target"
)


def sh_single_quote(value: str) -> str:
    """Wrap a value for safe inclusion in single-quoted bash."""
    return "'" + value.replace("'", "'\\''") + "'"


def main() -> int:
    required = ["WIFI_SSID", "WIFI_PASS", "USER_PASS"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"Missing required env: {', '.join(missing)}", file=sys.stderr)
        return 1

    bootfs = Path(os.environ.get("BOOTFS", "/Volumes/bootfs"))
    if not bootfs.is_dir():
        print(f"{bootfs} is not mounted — insert the SD card", file=sys.stderr)
        return 1

    here = Path(__file__).parent
    template = (here / "firstrun.template.sh").read_text()
    ssh_key_path = Path(os.environ.get("SSH_KEY_PATH", "~/.ssh/id_ed25519.pub")).expanduser()
    ssh_key = ssh_key_path.read_text().strip()

    room = "betterpi-" + secrets.token_hex(4)
    replacements = {
        "HOSTNAME":     os.environ.get("HOSTNAME", "betterpi"),
        "USER_NAME":    os.environ.get("USER_NAME", "pi"),
        "USER_PASS":    os.environ["USER_PASS"],
        "WIFI_SSID":    os.environ["WIFI_SSID"],
        "WIFI_PASS":    os.environ["WIFI_PASS"],
        "SSH_KEY":      ssh_key,
        "FIRMWARE_URL": os.environ.get("FIRMWARE_URL", "https://neevs.io/better-robotics/firmware/pi_robot"),
        "SIGNAL_ROOM":  room,
    }
    content = template
    for k, v in replacements.items():
        content = content.replace(f"__REPLACE_{k}__", sh_single_quote(v))

    (bootfs / "firstrun.sh").write_text(content)
    (bootfs / "firstrun.sh").chmod(0o755)

    cmdline_path = bootfs / "cmdline.txt"
    line = cmdline_path.read_text().rstrip("\n").rstrip()
    # Strip any previous systemd.run= we added so re-running is idempotent.
    for token in (" systemd.run=", " systemd.run_success_action=", " systemd.unit="):
        while token in line:
            idx = line.index(token)
            end = line.find(" ", idx + 1)
            if end == -1:
                line = line[:idx]
            else:
                line = line[:idx] + line[end:]
    line = line + SYSTEMD_RUN + "\n"
    cmdline_path.write_text(line)

    dashboard = os.environ.get("DASHBOARD_URL", "https://neevs.io/better-robotics/")
    setup_url = f"{dashboard}?setup={room}"
    print(f"Wrote {bootfs / 'firstrun.sh'}")
    print(f"Patched {cmdline_path}")
    print()
    print(f"Signal room: {room}")
    print(f"Open this to watch setup live: {setup_url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
