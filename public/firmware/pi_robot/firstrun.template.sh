#!/bin/bash
# Better Robotics — offline first-boot provisioning for the Pi.
# Rendered from firstrun.template.sh by the Customize-card dialog in
# the dashboard. Don't edit the copy on the SD card directly — regenerate
# it from the dialog.
#
# Boot-partition layout this script expects:
#   /boot/firmware/betterpi/   pi_robot.py + requirements.txt + service unit
#   /boot/firmware/wheels/     aarch64 Python wheels (bless + bleak + etc.)

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
# partition, readable by popping the card back into another machine.
note() {
    local step="$1"; shift
    local msg="${*:-}"
    echo "note: $step $msg"
    printf '%s %s %s\n' "$(date -Iseconds)" "$step" "$msg" >> "$STATUS_FILE"
}

: > "$STATUS_FILE"
note start

CURRENT_HOSTNAME=$(tr -d " \t\n\r" < /etc/hostname)
echo "$HOSTNAME" > /etc/hostname
sed -i "s/127.0.1.1.*$CURRENT_HOSTNAME/127.0.1.1\t$HOSTNAME/g" /etc/hosts
note hostname_set "$HOSTNAME"

if ! id -u "$USER_NAME" >/dev/null 2>&1; then
    adduser --disabled-password --gecos "" "$USER_NAME"
fi
# Empty password → stays disabled (SSH-key-only login, no sudo without a
# password set later via `passwd`). chpasswd on an empty string would leave
# the account with a blank password, which is worse than no password at all.
if [ -n "$USER_PASS" ]; then
    echo "${USER_NAME}:${USER_PASS}" | chpasswd
fi
# Pi OS imager's pre-built firstboot can leave the user with /usr/sbin/nologin
# as shell — login then prints the banner and "This account is currently not
# available." Force /bin/bash explicitly so the recovery console is usable.
usermod -s /bin/bash "$USER_NAME"
for g in sudo adm dialout cdrom audio video plugdev games users input render netdev spi i2c gpio bluetooth lpadmin; do
    getent group "$g" >/dev/null 2>&1 && usermod -aG "$g" "$USER_NAME"
done
note user_created "$USER_NAME"

# SSH_KEY is the textarea content, which the dashboard pre-fills with the
# dashboard's own pubkey. Empty = no SSH authorization = BLE-only recovery.
if [ -n "$SSH_KEY" ]; then
  install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "/home/$USER_NAME/.ssh"
  printf '%s\n' "$SSH_KEY" > "/home/$USER_NAME/.ssh/authorized_keys"
  chmod 600 "/home/$USER_NAME/.ssh/authorized_keys"
  chown "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.ssh/authorized_keys"
  systemctl enable ssh
  systemctl start ssh
  note ssh_enabled
else
  note ssh_skipped
fi

# Dashboard.pub is independent of authorized_keys — staged for the Phase 3
# BLE-auth consumer (pi-robot reads this dir to accept signed challenges).
if [ -f "$BOOTFS/dashboard.pub" ]; then
  install -d -m 755 "$BOOTFS/pi-robot-auth"
  install -m 644 "$BOOTFS/dashboard.pub" "$BOOTFS/pi-robot-auth/dashboard.pub"
  note dashboard_key_staged
fi

# USB composite gadget (ECM ethernet + ACM serial). Independent of
# pi-robot: a crashed firmware still exposes `ssh pi@10.55.0.1` over usb0
# AND a raw serial login at /dev/ttyGS0 reachable via the dashboard's
# Recovery console using Web Serial.
if [ -f "$STAGED/usb-gadget-setup.sh" ]; then
  install -m 755 "$STAGED/usb-gadget-setup.sh" /usr/local/bin/usb-gadget-setup.sh
fi
if [ -f "$STAGED/usb-gadget.service" ]; then
  install -m 644 "$STAGED/usb-gadget.service" /etc/systemd/system/usb-gadget.service
  systemctl enable usb-gadget.service
fi
systemctl enable serial-getty@ttyGS0.service

install -d -m 700 /etc/NetworkManager/system-connections
cat > /etc/NetworkManager/system-connections/usb-gadget.nmconnection <<'NMEOF'
[connection]
id=usb-gadget
type=ethernet
interface-name=usb0
autoconnect=true

[ethernet]

[ipv4]
method=shared
address1=10.55.0.1/24

[ipv6]
method=ignore
NMEOF
chmod 600 /etc/NetworkManager/system-connections/usb-gadget.nmconnection
nmcli connection reload 2>/dev/null || true
note usb_gadget_configured

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

    # bless needs BlueZ's experimental LE advertising API (--experimental).
    # Enable it both ways (systemd flag AND main.conf) — different BlueZ
    # versions honor different paths.
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
    # Pi OS Trixie ships with bluetooth + WiFi soft-blocked in rfkill; unblock
    # before restarting bluetoothd or `bluetoothctl power on` will silently
    # fail with "Failed to set mode: Failed (0x03)".
    rfkill unblock bluetooth || true
    rfkill unblock all || true
    # systemd-rfkill.service persists block state across reboots and would
    # re-apply a block on next boot. Mask it + wipe its saved state so WiFi
    # stays unblocked after reboot (otherwise Pi comes back with no internet
    # and DNS fails for curl / apt / pip).
    systemctl mask systemd-rfkill.socket systemd-rfkill.service || true
    rm -rf /var/lib/systemd/rfkill || true
    systemctl restart bluetooth
    sleep 3
    hciconfig hci0 up >/dev/null 2>&1 || true
    bluetoothctl power on >/dev/null 2>&1 || true
    sleep 1
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

    sed "s|__HOME__|/home/$USER_NAME|g" "$DEST/pi-robot.service" > /etc/systemd/system/pi-robot.service
    chmod 644 /etc/systemd/system/pi-robot.service
    systemctl daemon-reload
    systemctl enable pi-robot.service
    note service_enabled

    # Probe the service + dump journal to the boot partition so issues are
    # diagnosable without SSH.
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

# Always clear the systemd.run trigger from cmdline.txt so we never re-run.
sed -i 's| systemd\.run=[^ ]*||g; s| systemd\.run_success_action=[^ ]*||g; s| systemd\.unit=[^ ]*||g' "$BOOTFS/cmdline.txt"
if [ "$INSTALL_OK" = "1" ]; then
    rm -f "$BOOTFS/firstrun.sh"
    note done "rebooting into pi_robot"
else
    note install_failed "SSH in and re-run manually — firstrun.sh left in place for inspection"
fi

exit 0
