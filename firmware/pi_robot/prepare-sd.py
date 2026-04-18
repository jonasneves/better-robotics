#!/usr/bin/env python3
"""Generate firstrun.sh + stage firmware + wheels on a mounted Pi SD card.

Reads values from env vars, substitutes them into firstrun.template.sh,
writes to $BOOTFS/firstrun.sh, downloads aarch64 Python wheels into
$BOOTFS/wheels/, copies pi_robot firmware into $BOOTFS/betterpi/, and
patches cmdline.txt so systemd runs firstrun on first boot.

The staged artifacts let the Pi install offline — no WiFi, no captive
portal, no GH-Pages roundtrip. After firstrun completes, pi_robot runs
as a systemd service advertising BLE; the dashboard onboards WiFi from
there via the BLE wifi-scan/wifi-join characteristics.

Env vars (required):
    USER_PASS   — sudo password for the Pi user

Env vars (optional):
    HOSTNAME        (default: betterpi)
    USER_NAME       (default: pi)
    SSH_KEY_PATH    (default: ~/.ssh/id_ed25519.pub)
    DASHBOARD_URL   (default: https://neevs.io/better-robotics/)
    BOOTFS          (default: /Volumes/bootfs)
"""

import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path


SYSTEMD_RUN = (
    " systemd.run=/boot/firmware/firstrun.sh"
    " systemd.run_success_action=reboot"
    " systemd.unit=kernel-command-line.target"
)

# Explicit transitive deps: pip's resolver picks macOS-era bleak variants when
# run from a Mac even with --platform flags, so we enumerate the Linux chain.
# Keep in sync if bless or bleak add new runtime deps.
WHEEL_PACKAGES = ["bless", "bleak", "dbus-fast", "async-timeout", "gpiozero"]
WHEEL_PLATFORM = "manylinux2014_aarch64"
WHEEL_PY = "311"  # Pi OS Bookworm ships Python 3.11

# python3-lgpio is preinstalled on Pi OS Bookworm; the venv is created with
# --system-site-packages so gpiozero finds it without a pip install.


def sh_single_quote(value: str) -> str:
    """Wrap a value for safe inclusion in single-quoted bash."""
    return "'" + value.replace("'", "'\\''") + "'"


def stage_wheels(dest: Path) -> None:
    """Download aarch64 Python wheels for the pi_robot deps into dest/."""
    dest.mkdir(parents=True, exist_ok=True)
    for old in dest.glob("*.whl"):
        old.unlink()
    cmd = [
        sys.executable, "-m", "pip", "download", "--no-deps",
        "--platform", WHEEL_PLATFORM,
        "--python-version", WHEEL_PY,
        "--implementation", "cp",
        "--only-binary=:all:",
        "-d", str(dest),
        *WHEEL_PACKAGES,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)


def stage_firmware(dest: Path) -> None:
    """Copy pi_robot source + service file onto the boot partition."""
    dest.mkdir(parents=True, exist_ok=True)
    here = Path(__file__).parent
    for name in ("pi_robot.py", "requirements.txt", "pi-robot.service"):
        shutil.copy2(here / name, dest / name)


def main() -> int:
    if not os.environ.get("USER_PASS"):
        print("Missing required env: USER_PASS", file=sys.stderr)
        return 1

    bootfs = Path(os.environ.get("BOOTFS", "/Volumes/bootfs"))
    if not bootfs.is_dir():
        print(f"{bootfs} is not mounted — insert the SD card", file=sys.stderr)
        return 1

    here = Path(__file__).parent
    template = (here / "firstrun.template.sh").read_text()
    ssh_key_path = Path(os.environ.get("SSH_KEY_PATH", "~/.ssh/id_ed25519.pub")).expanduser()
    ssh_key = ssh_key_path.read_text().strip()

    print("Staging firmware…")
    stage_firmware(bootfs / "betterpi")
    print("Downloading wheels…")
    stage_wheels(bootfs / "wheels")

    room = "betterpi-" + secrets.token_hex(4)
    replacements = {
        "HOSTNAME":    os.environ.get("HOSTNAME", "betterpi"),
        "USER_NAME":   os.environ.get("USER_NAME", "pi"),
        "USER_PASS":   os.environ["USER_PASS"],
        "SSH_KEY":     ssh_key,
        "SIGNAL_ROOM": room,
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
