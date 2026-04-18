#!/bin/bash
# Better Robotics — one-time first-boot provisioning for the Pi.
# Generated from firstrun.template.sh by prepare-sd.py. Do not edit the
# copy on the SD card directly — regenerate with `make sd-prep`.
#
# Runs via systemd.run= from cmdline.txt on first boot. Sets up user,
# SSH, joins WiFi once to fetch + install the pi_robot firmware, emits
# progress to signal.neevs.io, then cleans up and reboots.

set +e  # Never abort — Pi must stay rebootable and SSH-reachable on any failure.

LOG=/var/log/betterpi-firstrun.log
exec > >(tee -a "$LOG") 2>&1
echo "=== firstrun.sh start $(date -Iseconds) ==="

BOOTFS=/boot/firmware
STATUS_FILE=$BOOTFS/firstrun.status

HOSTNAME=__REPLACE_HOSTNAME__
USER_NAME=__REPLACE_USER_NAME__
USER_PASS=__REPLACE_USER_PASS__
WIFI_SSID=__REPLACE_WIFI_SSID__
WIFI_PASS=__REPLACE_WIFI_PASS__
SSH_KEY=__REPLACE_SSH_KEY__
FIRMWARE_URL=__REPLACE_FIRMWARE_URL__
SIGNAL_ROOM=__REPLACE_SIGNAL_ROOM__
SIGNAL_URL="https://signal.neevs.io/${SIGNAL_ROOM}"

# emit STEP [MSG] — best-effort progress notification over two channels:
#   signal.neevs.io    for live dashboard streaming (needs internet)
#   firstrun.status    as an offline breadcrumb on the FAT32 boot partition
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

retry() {
    local tries=$1; shift
    local i
    for i in $(seq 1 "$tries"); do
        "$@" && return 0
        sleep $((i * 2))
    done
    return 1
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

# --- WiFi (one-time, for pip install) ---
raspi-config nonint do_wifi_country US || true
rfkill unblock wifi || true
nmcli radio wifi on || true
emit wifi_joining "$WIFI_SSID"
for i in $(seq 1 30); do
    nmcli device status 2>/dev/null | grep -q '^wlan0' && break
    sleep 1
done
if retry 3 nmcli dev wifi connect "$WIFI_SSID" password "$WIFI_PASS"; then
    emit wifi_joined "$WIFI_SSID"
else
    emit wifi_failed "$WIFI_SSID"
fi

# --- Wait for routable internet ---
ONLINE=0
for i in $(seq 1 60); do
    if curl -fsS -m 3 -o /dev/null https://neevs.io/better-robotics/index.html; then
        ONLINE=1; break
    fi
    sleep 1
done
emit online "$ONLINE"

INSTALL_OK=0
if [ "$ONLINE" = "1" ]; then
    DEST="/home/$USER_NAME/better-robotics/firmware/pi_robot"
    install -d -o "$USER_NAME" -g "$USER_NAME" "$DEST"

    emit firmware_fetch_start
    FETCH_OK=1
    for f in pi_robot.py requirements.txt pi-robot.service; do
        if retry 3 curl -fsSL -m 10 "$FIRMWARE_URL/$f" -o "$DEST/$f"; then
            chown "$USER_NAME:$USER_NAME" "$DEST/$f"
        else
            FETCH_OK=0
            emit firmware_fetch_failed "$f"
            break
        fi
    done

    if [ "$FETCH_OK" = "1" ]; then
        emit firmware_fetched

        emit apt_install_start
        retry 3 apt-get update
        apt-get install -y python3-venv python3-pip
        emit apt_install_done

        emit venv_create_start
        sudo -u "$USER_NAME" python3 -m venv "$DEST/.venv"
        emit venv_created

        emit pip_install_start "this is the slow step (~2 min)"
        sudo -u "$USER_NAME" "$DEST/.venv/bin/pip" install --upgrade pip >/dev/null
        if sudo -u "$USER_NAME" "$DEST/.venv/bin/pip" install -r "$DEST/requirements.txt"; then
            emit pip_installed

            install -m 644 "$DEST/pi-robot.service" /etc/systemd/system/pi-robot.service
            systemctl daemon-reload
            systemctl enable pi-robot.service
            emit service_enabled
            INSTALL_OK=1
        else
            emit pip_install_failed
        fi
    fi
else
    emit offline "could not reach neevs.io — firmware install skipped"
fi

# --- Cleanup: always clear the systemd.run trigger so we never re-run this script. ---
sed -i 's| systemd\.run=[^ ]*||g; s| systemd\.run_success_action=[^ ]*||g; s| systemd\.unit=[^ ]*||g' "$BOOTFS/cmdline.txt"
if [ "$INSTALL_OK" = "1" ]; then
    rm -f "$BOOTFS/firstrun.sh"
    emit done "rebooting into pi_robot"
else
    emit install_failed "SSH in and re-run manually — firstrun.sh left in place for inspection"
fi

# Give the last emit's background curl time to land before we return and systemd reboots.
sleep 3
exit 0
