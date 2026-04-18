#!/bin/bash
# Better Robotics — offline first-boot provisioning for the Pi.
# Generated from firstrun.template.sh by prepare-sd.py. Do not edit the
# copy on the SD card directly — regenerate with `make sd-prep`.
#
# Everything the Pi needs is staged on the boot partition:
#   /boot/firmware/betterpi/   pi_robot.py + requirements.txt + service unit
#   /boot/firmware/wheels/     aarch64 Python wheels (bless + bleak + etc.)
# So firstrun needs no network — no WiFi, no pip index, no GH Pages
# roundtrip. After it finishes, pi_robot advertises BLE and the
# dashboard onboards WiFi from there.

set +e  # Never abort — Pi must stay rebootable and SSH-reachable on any failure.

LOG=/var/log/betterpi-firstrun.log
exec > >(tee -a "$LOG") 2>&1
echo "=== firstrun.sh start $(date -Iseconds) ==="

BOOTFS=/boot/firmware
STATUS_FILE=$BOOTFS/firstrun.status
STAGED=$BOOTFS/betterpi
WHEELS=$BOOTFS/wheels

HOSTNAME=__REPLACE_HOSTNAME__
USER_NAME=__REPLACE_USER_NAME__
USER_PASS=__REPLACE_USER_PASS__
SSH_KEY=__REPLACE_SSH_KEY__

# note STEP [MSG] — append a breadcrumb to firstrun.status on the boot
# partition. Readable by popping the card back into another machine.
note() {
    local step="$1"; shift
    local msg="${*:-}"
    echo "note: $step $msg"
    printf '%s %s %s\n' "$(date -Iseconds)" "$step" "$msg" >> "$STATUS_FILE"
}

: > "$STATUS_FILE"
note start

# --- Hostname ---
CURRENT_HOSTNAME=$(tr -d " \t\n\r" < /etc/hostname)
echo "$HOSTNAME" > /etc/hostname
sed -i "s/127.0.1.1.*$CURRENT_HOSTNAME/127.0.1.1\t$HOSTNAME/g" /etc/hosts
note hostname_set "$HOSTNAME"

# --- User + password ---
if ! id -u "$USER_NAME" >/dev/null 2>&1; then
    adduser --disabled-password --gecos "" "$USER_NAME"
fi
echo "${USER_NAME}:${USER_PASS}" | chpasswd
for g in sudo adm dialout cdrom audio video plugdev games users input render netdev spi i2c gpio bluetooth lpadmin; do
    getent group "$g" >/dev/null 2>&1 && usermod -aG "$g" "$USER_NAME"
done
note user_created "$USER_NAME"

# --- SSH ---
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "/home/$USER_NAME/.ssh"
printf '%s\n' "$SSH_KEY" > "/home/$USER_NAME/.ssh/authorized_keys"
chmod 600 "/home/$USER_NAME/.ssh/authorized_keys"
chown "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.ssh/authorized_keys"
systemctl enable ssh
systemctl start ssh
note ssh_enabled

# --- Firmware install (from staged files, no network) ---
INSTALL_OK=0
DEST="/home/$USER_NAME/better-robotics/firmware/pi_robot"
install -d -o "$USER_NAME" -g "$USER_NAME" "$DEST"
for f in pi_robot.py requirements.txt pi-robot.service; do
    if [ -f "$STAGED/$f" ]; then
        install -m 644 -o "$USER_NAME" -g "$USER_NAME" "$STAGED/$f" "$DEST/$f"
    else
        note firmware_missing "$f not staged on boot partition"
    fi
done
note firmware_staged

note venv_create_start
sudo -u "$USER_NAME" python3 -m venv --system-site-packages "$DEST/.venv"
note venv_created

note pip_install_start "installing from /boot/firmware/wheels"
PIP_LOG=$BOOTFS/pip.log
sudo -u "$USER_NAME" "$DEST/.venv/bin/pip" install -v --no-index --find-links="$WHEELS" bless > "$PIP_LOG" 2>&1
PIP_RC=$?
if [ $PIP_RC -eq 0 ]; then
    note pip_installed

    # bless needs BlueZ's experimental LE advertising API. Pi OS's default
    # bluetoothd doesn't enable it, so we enable it both ways (systemd flag
    # and main.conf) because different BlueZ versions honor different paths.
    mkdir -p /etc/systemd/system/bluetooth.service.d
    cat > /etc/systemd/system/bluetooth.service.d/override.conf <<'BTEOF'
[Service]
ExecStart=
ExecStart=/usr/libexec/bluetooth/bluetoothd --experimental
BTEOF
    if ! grep -q "^Experimental=true" /etc/bluetooth/main.conf; then
        sed -i '/^\[General\]/a Experimental=true' /etc/bluetooth/main.conf
    fi
    systemctl daemon-reload
    # Pi OS Trixie ships with bluetooth soft-blocked in rfkill; unblock before
    # restarting bluetoothd or `bluetoothctl power on` will silently fail with
    # "Failed to set mode: Failed (0x03)".
    rfkill unblock bluetooth || true
    rfkill unblock all || true
    systemctl restart bluetooth
    sleep 3
    hciconfig hci0 up >/dev/null 2>&1 || true
    bluetoothctl power on >/dev/null 2>&1 || true
    sleep 1
    # Diagnostic dump so we can see adapter state without SSH.
    {
        echo "=== hciconfig -a ==="; hciconfig -a 2>&1
        echo "=== rfkill list ==="; rfkill list 2>&1
        echo "=== bluetoothctl show ==="; bluetoothctl show 2>&1
        echo "=== bluetoothd --version ==="; bluetoothd --version 2>&1
        echo "=== main.conf [General] ==="; sed -n '/^\[General\]/,/^\[/p' /etc/bluetooth/main.conf 2>&1
        echo "=== bluetooth service status ==="
        systemctl status bluetooth.service --no-pager -l 2>&1
    } > "$BOOTFS/bluetooth-diag.log" 2>&1
    note bluetooth_experimental_enabled

    install -m 644 "$DEST/pi-robot.service" /etc/systemd/system/pi-robot.service
    systemctl daemon-reload
    systemctl enable pi-robot.service
    note service_enabled

    # Probe the service here so we can see issues without SSH access: start it,
    # wait, capture status + journal to the boot partition for offline reading.
    note service_probe_start
    systemctl start pi-robot.service
    sleep 15
    systemctl status pi-robot.service --no-pager -l > "$BOOTFS/pi-robot-status.log" 2>&1
    journalctl -u pi-robot.service --no-pager -n 100 > "$BOOTFS/pi-robot-journal.log" 2>&1
    if systemctl is-active --quiet pi-robot.service; then
        note service_probe_ok "pi-robot.service is active"
    else
        note service_probe_failed "see /boot/firmware/pi-robot-journal.log"
    fi

    INSTALL_OK=1
else
    note pip_install_failed "full log in /boot/firmware/pip.log (exit $PIP_RC)"
fi

# --- Cleanup: always clear the systemd.run trigger so we never re-run. ---
sed -i 's| systemd\.run=[^ ]*||g; s| systemd\.run_success_action=[^ ]*||g; s| systemd\.unit=[^ ]*||g' "$BOOTFS/cmdline.txt"
if [ "$INSTALL_OK" = "1" ]; then
    rm -f "$BOOTFS/firstrun.sh"
    note done "rebooting into pi_robot"
else
    note install_failed "SSH in and re-run manually — firstrun.sh left in place for inspection"
fi

exit 0
