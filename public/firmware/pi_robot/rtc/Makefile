# pi-robot-rtc — WebRTC peer for the Pi side, built on libpeer.
#
# Vendors libpeer at a pinned commit; libpeer's CMake handles its own deps
# (mbedtls, libsrtp2, libusrsctp, cjson) via ExternalProject. We just link
# against the static archives it produces under build/dist/lib.
#
# Pi system reqs (apt-installable, baked into firstrun.template.sh):
#   build-essential cmake pkg-config

LIBPEER_REPO := https://github.com/sepfy/libpeer
LIBPEER_SHA  := 9319aa434cb9     # pinned 2026-04 — bump deliberately
VENDOR       := vendor
LIBPEER_DIR  := $(VENDOR)/libpeer
LIBPEER_BUILD := $(LIBPEER_DIR)/build
# libpeer's CMake auto-installs its deps (mbedtls, libsrtp, libusrsctp,
# cjson) into build/dist/ via ExternalProject. libpeer.a itself lives at
# build/src/libpeer.a — running `cmake --install` would also try to
# write /usr/local/include (libpeer hardcodes that path), which needs
# root and we don't want. Use the in-tree path instead.
LIBPEER_DIST := $(LIBPEER_BUILD)/dist
LIBPEER_LIB  := $(LIBPEER_BUILD)/src/libpeer.a

CC      ?= cc
CFLAGS  ?= -O2 -Wall -Wextra -Wno-unused-parameter
INCLUDES := -I$(LIBPEER_DIR)/include -I$(LIBPEER_DIST)/include -I$(LIBPEER_DIST)/include/cjson
# Order matters: libpeer first, then its deps. -lpthread + -lutil for forkpty.
LIBS := \
  $(LIBPEER_LIB) \
  $(LIBPEER_DIST)/lib/libsrtp2.a \
  $(LIBPEER_DIST)/lib/libusrsctp.a \
  $(LIBPEER_DIST)/lib/libmbedtls.a \
  $(LIBPEER_DIST)/lib/libmbedx509.a \
  $(LIBPEER_DIST)/lib/libmbedcrypto.a \
  $(LIBPEER_DIST)/lib/libcjson.a \
  -lpthread -lutil

.PHONY: all clean distclean
all: pi-robot-rtc

pi-robot-rtc: main.c $(LIBPEER_LIB)
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ main.c $(LIBS)

# libpeer's CMake builds it static + builds + installs its own deps under
# build/dist. -DBUILD_SHARED_LIBS=OFF gives us a single .a per dep so the
# final binary is self-contained.
$(LIBPEER_LIB): $(LIBPEER_DIR)/CMakeLists.txt
	cd $(LIBPEER_DIR) && cmake -B build -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release && cmake --build build -j

$(LIBPEER_DIR)/CMakeLists.txt:
	mkdir -p $(VENDOR)
	# --recursive pulls third_party/{coreHTTP,coreMQTT,cJSON} which
	# libpeer's CMakeLists requires — without these the configure step
	# errors with "could not find httpFilePaths.cmake".
	git clone --recursive $(LIBPEER_REPO) $(LIBPEER_DIR)
	cd $(LIBPEER_DIR) && git checkout $(LIBPEER_SHA) && git submodule update --init --recursive

clean:
	rm -f pi-robot-rtc

distclean: clean
	rm -rf $(VENDOR)
