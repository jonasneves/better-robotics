#pragma once

#include <stdbool.h>

// Spawns a background task that waits for WiFi GOT_IP, fetches Cloudflare
// TURN credentials from proxy.neevs.io/cloudflare/turn, and caches them.
// Re-fetches if the cached creds expire (24h default TTL). Call once at
// boot after wifi_sta_init.
void turn_creds_init(void);

// Returns NULL until the first successful fetch completes (or after the
// cache expires). webrtc_peer reads these into its IceServer entries; on
// NULL, it falls back to STUN-only and the chip works on LAN-friendly
// networks but not on apartment-WiFi-shaped ones.
const char *turn_creds_username(void);
const char *turn_creds_credential(void);

// Pre-resolved TURN URL with IP literal (e.g. "turn:198.41.x.x:3478?transport=udp").
// We resolve turn.cloudflare.com once at boot so libpeer's create_answer
// doesn't do a synchronous getaddrinfo() per ice_server inside the BLE
// signaling window — apartment-WiFi DNS can take 20+s and blow the 30s
// timeout. Returns NULL until resolution succeeds.
const char *turn_creds_url(void);

// Last-error string from the most recent fetch attempt. Empty when no
// attempt has been made yet or the most recent one succeeded. Surfaced
// via telemetry so failures are debuggable without serial monitoring.
const char *turn_creds_last_error(void);
