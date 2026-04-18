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
SIGNAL_ROOM=__REPLACE_SIGNAL_ROOM__
SIGNAL_URL="https://signal.neevs.io/${SIGNAL_ROOM}"

# emit STEP [MSG] — best-effort progress. Signal needs internet and will
# be silent on a truly offline first boot; the status file always lands.
emit() {
    local step="$1"; shift
    local msg="${*:-}"
    local t; t=$(date +%s)
    echo "emit: $step $msg"
    printf '%s %s %s\n' "$(date -Iseconds)" "$step" "$msg" >> "$STATUS_FILE"
    curl -fsS -m 5 -X PUT "$SIGNAL_URL" \
        -H "Content-Type: application/json" \
        -d "{\"peer\":\"pi\",\"ttl\":7200000,\"data\":{\"step\":\"$step\",\"t\":$t,\"msg\":\"$msg\"}}" \
        >/dev/null 2>&1 &
}

: > "$STATUS_FILE"
emit start

# --- Hostname ---
CURRENT_HOSTNAME=$(tr -d " \t\n\r" < /etc/hostname)
echo "$HOSTNAME" > /etc/hostname
sed -i "s/127.0.1.1.*$CURRENT_HOSTNAME/127.0.1.1\t$HOSTNAME/g" /etc/hosts
emit hostname_set "$HOSTNAME"

# --- User + password ---
if ! id -u "$USER_NAME" >/dev/null 2>&1; then
    adduser --disabled-password --gecos "" "$USER_NAME"
fi
echo "${USER_NAME}:${USER_PASS}" | chpasswd
for g in sudo adm dialout cdrom audio video plugdev games users input render netdev spi i2c gpio bluetooth lpadmin; do
    getent group "$g" >/dev/null 2>&1 && usermod -aG "$g" "$USER_NAME"
done
emit user_created "$USER_NAME"

# --- SSH ---
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "/home/$USER_NAME/.ssh"
printf '%s\n' "$SSH_KEY" > "/home/$USER_NAME/.ssh/authorized_keys"
chmod 600 "/home/$USER_NAME/.ssh/authorized_keys"
chown "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.ssh/authorized_keys"
systemctl enable ssh
systemctl start ssh
emit ssh_enabled

# --- Firmware install (from staged files, no network) ---
INSTALL_OK=0
DEST="/home/$USER_NAME/better-robotics/firmware/pi_robot"
install -d -o "$USER_NAME" -g "$USER_NAME" "$DEST"
for f in pi_robot.py requirements.txt pi-robot.service; do
    if [ -f "$STAGED/$f" ]; then
        install -m 644 -o "$USER_NAME" -g "$USER_NAME" "$STAGED/$f" "$DEST/$f"
    else
        emit firmware_missing "$f not staged on boot partition"
    fi
done
emit firmware_staged

emit venv_create_start
sudo -u "$USER_NAME" python3 -m venv --system-site-packages "$DEST/.venv"
emit venv_created

emit pip_install_start "installing from /boot/firmware/wheels"
PIP_ERR=$(sudo -u "$USER_NAME" "$DEST/.venv/bin/pip" install --no-index --find-links="$WHEELS" bless gpiozero 2>&1)
PIP_RC=$?
if [ $PIP_RC -eq 0 ]; then
    emit pip_installed
    install -m 644 "$DEST/pi-robot.service" /etc/systemd/system/pi-robot.service
    systemctl daemon-reload
    systemctl enable pi-robot.service
    emit service_enabled
    INSTALL_OK=1
else
    CLEAN=$(printf '%s' "$PIP_ERR" | tr '\n' ' ' | tr -d '"' | head -c 200)
    emit pip_install_failed "$CLEAN"
fi

# --- Cleanup: always clear the systemd.run trigger so we never re-run. ---
sed -i 's| systemd\.run=[^ ]*||g; s| systemd\.run_success_action=[^ ]*||g; s| systemd\.unit=[^ ]*||g' "$BOOTFS/cmdline.txt"
if [ "$INSTALL_OK" = "1" ]; then
    rm -f "$BOOTFS/firstrun.sh"
    emit done "rebooting into pi_robot"
else
    emit install_failed "SSH in and re-run manually — firstrun.sh left in place for inspection"
fi

sleep 3  # give background curls a moment to flush
exit 0
