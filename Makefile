.DEFAULT_GOAL := help

FQBN        ?= esp32:esp32:esp32cam:PartitionScheme=min_spiffs
PORT        ?= $(shell ls /dev/cu.usbserial-* 2>/dev/null | head -1)
SKETCH      ?= esp32_robot
BUILD_DIR   := /tmp/esp32-$(SKETCH)-build
PUBLISH_DIR := public/firmware/bins
BOOT_APP0   := $(shell find ~/Library/Arduino15/packages/esp32 -name boot_app0.bin 2>/dev/null | sort -V | tail -1)
MONITOR      = arduino-cli monitor --port "$(PORT)" --config baudrate=115200,dtr=off,rts=off

.PHONY: help setup compile flash monitor flash-monitor preview publish-firmware

help:
	@echo ""
	@echo "\033[2mSetup\033[0m"
	@echo "  \033[36msetup\033[0m          Install host dependencies (once per machine)"
	@echo ""
	@echo "\033[2mFirmware\033[0m"
	@echo "  \033[36mcompile\033[0m        Compile $(SKETCH)"
	@echo "  \033[36mflash\033[0m          Compile + upload over USB"
	@echo "  \033[36mmonitor\033[0m        Open serial monitor at 115200"
	@echo "  \033[36mflash-monitor\033[0m  Flash then open monitor"
	@echo ""
	@echo "\033[2mDashboard\033[0m"
	@echo "  \033[36mpreview\033[0m             Serve dashboard at http://localhost:8080"
	@echo "  \033[36mpublish-firmware\033[0m    Package firmware bins into public/firmware/bins/ for web flashing"
	@echo ""

setup:
	@command -v brew >/dev/null || (echo "Install Homebrew first: https://brew.sh" && exit 1)
	@command -v arduino-cli >/dev/null || brew install arduino-cli
	arduino-cli core update-index --additional-urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
	arduino-cli core install esp32:esp32 --additional-urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
	@echo ""
	@echo "If no /dev/cu.usbserial-* port appears when the ESP32-CAM-MB is plugged in,"
	@echo "your board uses a CP210x (Silicon Labs) chip and needs its driver:"
	@echo "  https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers"
	@echo "Allow it in System Settings > Privacy & Security before flashing."
	@echo "Boards with FTDI (FT232R) chips use Apple's built-in driver — no install needed."

compile:
	arduino-cli compile --fqbn "$(FQBN)" --build-path "$(BUILD_DIR)" firmware/$(SKETCH)

flash: compile
	@test -n "$(PORT)" || (echo "No ESP32 detected on /dev/cu.usbserial-*. Is it plugged in?" && exit 1)
	arduino-cli upload --fqbn "$(FQBN)" --port "$(PORT)" --input-dir "$(BUILD_DIR)" firmware/$(SKETCH)

monitor:
	@test -n "$(PORT)" || (echo "No ESP32 detected on /dev/cu.usbserial-*" && exit 1)
	$(MONITOR)

flash-monitor: flash monitor

preview:
	@echo "Serving dashboard at http://localhost:8080"
	@cd public && python3 -m http.server 8080

publish-firmware: compile
	@test -n "$(BOOT_APP0)" || (echo "Could not find boot_app0.bin — run 'make setup' first" && exit 1)
	@mkdir -p $(PUBLISH_DIR)
	cp "$(BUILD_DIR)/$(SKETCH).ino.bin"            "$(PUBLISH_DIR)/$(SKETCH).bin"
	cp "$(BUILD_DIR)/$(SKETCH).ino.bootloader.bin" "$(PUBLISH_DIR)/bootloader.bin"
	cp "$(BUILD_DIR)/$(SKETCH).ino.partitions.bin" "$(PUBLISH_DIR)/partitions.bin"
	cp "$(BOOT_APP0)"                              "$(PUBLISH_DIR)/boot_app0.bin"
	@echo ""
	@echo "Firmware bins copied to $(PUBLISH_DIR). Commit and push to deploy."
