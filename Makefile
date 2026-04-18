.DEFAULT_GOAL := help

FQBN        ?= esp32:esp32:esp32cam:PartitionScheme=min_spiffs
PORT        ?= $(shell ls /dev/cu.usbserial-* /dev/cu.usbmodem* 2>/dev/null | head -1)
SKETCH      ?= esp32_robot
BUILD_DIR   := /tmp/esp32-$(SKETCH)-build
PUBLISH_DIR := public/firmware/bins
BOOT_APP0   := $(shell find ~/Library/Arduino15 ~/.arduino15 -name boot_app0.bin 2>/dev/null | sort -V | tail -1)
MONITOR      = arduino-cli monitor --port "$(PORT)" --config baudrate=115200,dtr=off,rts=off

.PHONY: help setup compile flash monitor flash-monitor preview publish publish-firmware publish-pi-firmware

help:
	@echo ""
	@echo "\033[2mSetup\033[0m"
	@echo "  \033[36msetup\033[0m          Install host dependencies (once per machine)"
	@echo ""
	@echo "\033[2mFirmware (ESP32 local dev loop)\033[0m"
	@echo "  \033[36mcompile\033[0m        Compile $(SKETCH)"
	@echo "  \033[36mflash\033[0m          Compile + upload over USB — fast dev iteration"
	@echo "  \033[36mmonitor\033[0m        Open serial monitor at 115200"
	@echo "  \033[36mflash-monitor\033[0m  Flash then open monitor"
	@echo ""
	@echo "\033[2mDashboard & publishing (what the browser serves + OTA fetches)\033[0m"
	@echo "  \033[36mpreview\033[0m             Serve dashboard at http://localhost:8080 (local)"
	@echo "  \033[36mpublish-firmware\033[0m    Stage ESP32 bins in public/firmware/bins/ for web flashing + ESP32 OTA"
	@echo "  \033[36mpublish-pi-firmware\033[0m Stage Pi firmware + wheels in public/firmware/pi_robot/ for SD-prep + Pi OTA"
	@echo "  \033[36mpublish\033[0m             Both publish targets — run before pushing to deploy"
	@echo ""
	@echo "\033[2mpublish-* also run automatically in CI on firmware/** changes. Only needed locally\033[0m"
	@echo "\033[2mif you want to test the published artifacts before pushing.\033[0m"
	@echo ""

setup:
	@command -v brew >/dev/null || (echo "Install Homebrew first: https://brew.sh" && exit 1)
	@command -v arduino-cli >/dev/null || brew install arduino-cli
	arduino-cli core update-index --additional-urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
	# Pin 3.3.8+ — 3.3.6/3.3.7 silently bypass signed-OTA verification
	# when installSignature() is called before begin() (arduino-esp32 PR #12425).
	arduino-cli core install esp32:esp32@3.3.8 --additional-urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
	@echo ""
	@echo "If no /dev/cu.* port appears when the board is plugged in:"
	@echo "  • ESP32-S3 (recommended) — native USB, no driver needed. Appears as /dev/cu.usbmodem*."
	@echo "  • CP210x (Silicon Labs) bridge — install https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers"
	@echo "    and allow in System Settings > Privacy & Security."
	@echo "  • FT232R (FTDI) bridge — Apple's built-in driver works, nothing to install."

compile:
	arduino-cli compile --fqbn "$(FQBN)" --build-path "$(BUILD_DIR)" firmware/$(SKETCH)

flash: compile
	@test -n "$(PORT)" || (echo "No ESP32 detected on /dev/cu.usbserial-* or /dev/cu.usbmodem*. Is it plugged in?" && exit 1)
	arduino-cli upload --fqbn "$(FQBN)" --port "$(PORT)" --input-dir "$(BUILD_DIR)" firmware/$(SKETCH)

monitor:
	@test -n "$(PORT)" || (echo "No ESP32 detected on /dev/cu.usbserial-* or /dev/cu.usbmodem*" && exit 1)
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

publish-pi-firmware:
	@mkdir -p public/firmware/pi_robot/wheels
	# Copy every regular file from firmware/pi_robot/ — avoids the trap of
	# adding a new helper (usb-gadget-setup.sh, ota-manifest.json, …) and
	# forgetting to update this list.
	find firmware/pi_robot/ -maxdepth 1 -type f \
		-not -name 'README.md' \
		-exec cp {} public/firmware/pi_robot/ \;
	rm -f public/firmware/pi_robot/wheels/*.whl
	pip download --no-deps --platform manylinux2014_aarch64 --python-version 311 --implementation cp --only-binary=:all: -d public/firmware/pi_robot/wheels/ bless bleak dbus-fast dbus-next typing-extensions
	pip download --no-deps --platform manylinux2014_aarch64 --python-version 313 --implementation cp --only-binary=:all: -d public/firmware/pi_robot/wheels/ bless bleak dbus-fast dbus-next typing-extensions
	@python3 -c "import json, pathlib; d = pathlib.Path('public/firmware/pi_robot/wheels'); (d/'manifest.json').write_text(json.dumps({'wheels': sorted(p.name for p in d.glob('*.whl'))}, indent=2) + '\n')"
	@echo ""
	@echo "Pi firmware + wheels published. Commit and push to deploy. SD-card prep runs in the dashboard's Customize-card dialog."

publish: publish-firmware publish-pi-firmware
