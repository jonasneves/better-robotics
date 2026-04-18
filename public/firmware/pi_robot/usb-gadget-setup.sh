#!/bin/bash
# Configure a USB composite gadget (ECM ethernet + ACM serial) via ConfigFS.
# Independent of pi-robot.service — runs at boot from usb-gadget.service, so a
# crashed firmware still leaves you both `ssh pi@10.55.0.1` (ECM) and a raw
# serial console at /dev/ttyGS0 (ACM). One USB-C cable is the last-resort
# escape hatch.
set -euo pipefail

GADGET=/sys/kernel/config/usb_gadget/g1
if [ -d "$GADGET" ]; then
  exit 0  # already configured (reboot-safe idempotency)
fi

mkdir -p "$GADGET"
cd "$GADGET"

echo 0x1d6b > idVendor    # Linux Foundation
echo 0x0104 > idProduct   # Multifunction Composite Gadget
echo 0x0100 > bcdDevice
echo 0x0200 > bcdUSB

mkdir -p strings/0x409
SN=$(awk '/Serial/ { print $NF; exit }' /proc/cpuinfo 2>/dev/null || echo "0000000000")
echo "$SN" > strings/0x409/serialnumber
echo "Better Robotics" > strings/0x409/manufacturer
echo "BetterPi" > strings/0x409/product

mkdir -p configs/c.1/strings/0x409
echo "ECM + ACM" > configs/c.1/strings/0x409/configuration
echo 250 > configs/c.1/MaxPower

# ECM ethernet — same recovery-SSH path as before (host gets 10.55.0.2-ish).
mkdir -p functions/ecm.usb0

# ACM serial — /dev/ttyGS0 on the Pi, /dev/cu.usbmodem* on the host. A
# serial-getty login prompt (see systemd enablement below) works even if the
# Pi's BLE + WiFi are completely hosed.
mkdir -p functions/acm.usb0

ln -s functions/ecm.usb0 configs/c.1/
ln -s functions/acm.usb0 configs/c.1/

# Bind to the first available USB Device Controller.
UDC=$(ls /sys/class/udc | head -n 1)
echo "$UDC" > UDC
