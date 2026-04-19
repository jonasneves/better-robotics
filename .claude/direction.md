# Architectural direction — better-robotics

Long-horizon shape decisions. Unlike `working.md` (tactical pending), this
file names structural moves the project is committing to. Updated when the
shape of the system changes.

## 1. Generic typed-characteristic runtime (in flight)

**Claim.** Every capability today exists in ~3 places (browser module, Pi
handler, ESP32 handler). 80% of those files are boilerplate isomorphic to
the capability's TYPE, not its identity. A generic runtime keyed on type
eliminates the boilerplate.

**The data already exists.** `fw-info.caps` declares typed schemas:

```json
{ "name": "led",    "char": "…d92", "type": "toggle" }
{ "name": "motors", "char": "…d99", "type": "signed-pair", "range": [-100, 100] }
{ "name": "wifi",   "chars": {...}, "type": "wifi-scan" }
{ "name": "ota",    "chars": {...}, "type": "bundle-ota" }
{ "name": "camera", "chars": {...}, "type": "webrtc-installable" }
{ "name": "ops",    "char": "…d9c", "type": "command" }
```

**The runtime (browser side).** A per-type constructor `makeXxxCap(schema)`
returns `{probe, cleanup, renderSection, wireActions, postRender?}`. Adding
a capability of a known type = one schema entry + zero JS code.

**Firmware-side direction (farther out).** Pi and ESP32 firmware have
identical ceremony: register char, parse read/write, notify on change,
gate on config. A "typed char runtime" on firmware reads the capability
declaration and handles generic typed chars with a small driver binding
per capability (`{ on_write: fn, on_read: fn }`).

**Progress so far:**
- fw-info.caps carries the typed schema (shipped)
- Browser reads + stores `entry.capSchema` (shipped)
- Each capability module exports its own `schema` for cross-check (shipped)
- **First type migrated: `toggle` → LED** (this session)
- Future types to migrate: `signed-pair`, `wifi-scan`, `bundle-ota`,
  `webrtc-installable`, `command`. Each is ~2–4 hours.

**Migration strategy.** Per-type, not per-capability. When we migrate
`signed-pair`, both motors AND any future 2-axis input use the same
runtime. The compound payoff is the Nth capability, not the first.

## 2. AI-maintained documentation (cheap, deferred)

**Claim.** `README.md`, `HARDWARE.md`, `firmware/pi_robot/README.md`, and
per-capability comments all describe what `fw-info.caps` + the code
already know. They drift. An AI agent watching the schema + commit log
can regenerate docs per release.

**Scope.** ~2 days to wire a pre-commit generator plus a CI check that
fails if docs aren't regenerated. Starts small: capability reference
page auto-generated from the live schema. Expands to change-log
summarization from commit messages.

**Not urgent.** Doc drift isn't causing failures today. Worth doing
when the project has contributors outside the core, or when we promise
backward-compatibility guarantees that require accurate docs.

## 3. Transparent-data-plane OTA (partially in flight)

**Claim.** Every robot should have three OTA lanes with a clear fallback
order. The dashboard picks the fastest available without user
intervention. Iteration-loop speed is the core dev experience; "how fast
does code get onto the robot" sets the tone for everything else.

**The three lanes, decreasing friction:**

1. **BLE-stream** — always works, no WiFi needed, no LAN co-location
   required. Baseline for every robot on every network.
   Today: `writeValueWithResponse` + ATT ack per 180-byte frame →
   3-10 min for a 1.6 MB bin. Switching to
   `writeValueWithoutResponse` + software flow control over
   `ota-status` gets it to ~30 sec. **Not yet implemented.**

2. **PNA direct to target robot** — dashboard fetches
   `http://<robot-ip>/ota` straight from the browser. Chrome/Edge's
   Private Network Access (shipped 2022) gates the first request on a
   one-time user consent per origin. No TLS on the robot, no cert
   ceremony, no crypto IRAM pressure. ~1 sec for a 1.6 MB bin over
   LAN. Works whenever the dashboard and robot share a network.
   **Not yet implemented on ESP32** (Pi doesn't need this lane — BLE
   bundle OTA is already fast enough for Pi-sized updates).

3. **Pi-as-gateway** — for multi-robot orchestration and offline-first
   classroom deployments. Pi runs an `aioquic` WebTransport server
   with a self-signed cert; dashboard uses `serverCertificateHashes`
   pinning (cert sha256 published in Pi's fw-info) to connect
   without PKI ceremony. Pi proxies raw TCP to the target ESP32 on
   the LAN. Same ~1 sec speed as PNA direct, with bonus orchestration
   surface (mesh multiple ESP32s, serve dashboard offline).
   **Not yet implemented.** Earns its slot when multi-robot coord or
   offline-first use cases land, not purely for OTA speed.

**Why the three-lane shape is right:**
- Lane 1 works on BLE only. No WiFi assumption.
- Lane 2 works when browser and robot share a LAN. Most common case.
- Lane 3 works when the fleet has a Pi (most Better Robotics fleets do).

Dashboard tries fastest available, falls back automatically. User never
picks a lane — it just updates as fast as the topology allows.

**What's baked in vs what's not:**
- BLE-stream as a baseline works today (for Pi bundle OTA; for ESP32
  single-binary OTA, the WithResponse variant is live and slow).
- ESP32 already runs a raw `WiFiServer` (for MJPEG) — adding a `/ota`
  endpoint on the same task is near-zero new code on the firmware side.
- Pi-as-gateway is purely additive to `pi_robot.py` — every Pi ships
  with it, no opt-in, just one more capability.
- Dashboard-side lane selection: not yet written. Attempts lanes in
  order, falls back on timeout/error.

**Sequencing:**
1. BLE-WithoutResponse first (universal, smallest change).
2. PNA + ESP32 `/ota` endpoint second (big bang for effort).
3. Pi-as-gateway when its orchestration/offline story earns it.

## 4. ESP32 build-as-a-service (bold, later)

**Claim.** ESP32 firmware is purely deterministic from `{board, caps}`.
Users currently install `arduino-cli` + core + toolchain to compile.
If a service accepts a config and returns a signed `.bin`, the dashboard's
"Flash firmware" button fetches a per-robot-config binary; no local dev
environment is needed for adding capabilities.

**Constraint.** The service has to be reliable enough that users aren't
stuck if it's down. Either (a) same-origin build on GitHub Actions, or
(b) a small hosted build service, or (c) in-browser compile via
something like Wokwi's WebAssembly toolchain (the bold option).

**The compound effect.** Combined with #1, adding an ESP32 capability
becomes: declare schema, bind driver code in a capability driver DSL,
click Flash. No C++, no toolchain, no linker flags.

**Worth it when.** Project has contributors who want to add capabilities
without learning the ESP32 toolchain. Today the audience is small enough
that `make flash` is fine.

## What this list doesn't include

These ideas were considered and rejected or deferred for specific reasons
— recording them here so we don't re-rehash:

- **Running without Linux on the Pi (bare-metal).** Loses Python, gpiozero,
  systemd, apt. Not a simplification; a regression. The Pi being a real
  computer is the feature.
- **Replacing BLE GATT with a custom protocol.** GATT is a standard with
  tooling, debuggers (`bluetoothctl`, `nRF Connect`), and cross-platform
  support. Reinventing would be faster to design and slower forever.
- **Making the dashboard a conversational (chat-only) UI.** Visual
  feedback for video, logs, and pinout has better throughput than text.
  The LLM-orchestrator direction adds chat alongside, doesn't replace.
