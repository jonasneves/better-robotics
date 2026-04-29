#pragma once

#include <stddef.h>
#include <stdint.h>

// Log streaming over BLE — every ESP_LOG line goes through a vprintf hook
// into a ring buffer; a worker task drains the ring and chunked-notifies
// LOGS_CHAR_UUID to whichever central is listening. Dashboard subscribes
// on connect and renders into the per-robot log panel.
//
// Wire format (matches snapshot/signal):
//   0x01 [u16 BE total]   begin
//   0x02 [bytes]          chunk
//   0x03                  commit
//
// Backpressure: ring overflow drops oldest bytes (silent — adding error
// reporting would just inflate the log volume that's already overflowing).
// The vprintf hook never blocks; logging from any task is safe.
//
// Init order: call BEFORE any ESP_LOG output you want captured. app_main
// calls it first thing so boot/early-init lines are caught. Captures
// into the ring buffer immediately; the BLE-side drain task starts
// later via logs_start() — keeps DRAM available for the websocket
// task that webrtc_peer_init creates after camera/BLE/WiFi.
void logs_init(void);

// Spin up the drain task that consumes the ring and emits BLE notifies.
// Safe to call after all other modules have grabbed their DRAM stacks.
void logs_start(void);

// Called by ble_host's BLE_GAP_EVENT_SUBSCRIBE handler. When a central
// enables notifications on the LOGS char, replay the full ring contents
// so the operator gets context for whatever's already happened. The
// firmware can't know the boot history; keeping the ring big enough for
// "last few minutes" is the budget.
void logs_replay_to(uint16_t conn_handle);

// Called by gatt_svr at GATT init.
uint16_t logs_char_handle(void);
void logs_set_char_handle(uint16_t handle);
