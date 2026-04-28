# Current working model — better-robotics

Last updated: 2026-04-19 (three-lane OTA architecture named; typed-ops verbs replace shell-over-BLE; identity + Pinout-edit-over-BLE + telemetry + ESP32 camera all landed)

## Project shape (stable — don't re-question unless new evidence)

The architecture is **three independent planes**:

- **Control plane — BLE.** Always on. Commands, telemetry, state, ops (install, restart, inspect, enroll, get-log, get-config). The browser's pairing UI is the gatekeeper; no credentials cross the air.
- **Data plane — WiFi.** Optional, onboarded over BLE. Large OTA payloads, video streams, cloud calls. Robots work fully without it.
- **Recovery plane — USB.** Last-resort. Composite gadget (ECM ethernet + ACM serial) runs under `usb-gadget.service`, independent of pi-robot firmware. Dashboard exposes a real xterm.js terminal over the ACM endpoint — works even when BLE and WiFi are dead.

OTA within the data plane uses **three lanes, fastest-available**
(see `direction.md` item #3 for the full shape):

1. **BLE-stream** — baseline, works for any robot on any network. ~30 sec
   per 1.6 MB once WithoutResponse lands (currently 3-10 min WithResponse).
2. **PNA direct** — dashboard → robot's plain HTTP via Chrome Private
   Network Access. ~1 sec when LAN-shared. ESP32 serves via its existing
   raw WiFiServer; no TLS.
3. **Pi-as-gateway** — Pi on the LAN runs WebTransport with pinned
   self-signed cert; proxies to target ESP32. Same ~1 sec speed plus
   orchestration surface. Every Pi ships with the role by default.

Dashboard picks highest-available lane automatically, falls back on
error. User never picks a lane.

Other invariants:
- Each robot advertises a single BLE GATT service. Capabilities (LED, motors, WiFi, OTA, camera, admin) are characteristics inside it. `fw-info` reports `{type, url, caps, bundle_url}` so the dashboard picks the right data plane per-robot and picks between legacy single-file OTA vs bundle OTA automatically.
- **Capability presence is config-driven on Pi** via `/boot/firmware/pi-robot.conf`. Unwired LEDs don't show up; missing motor drivers don't show up. The dashboard renders only what's advertised.
- Actuator characteristics (motor, future servos/pumps/relays) ship with a built-in watchdog — every write resets a timer, silence reverts to safe default.
- Dashboard is the brain; firmware lives on GH Pages and updates via OTA. No server in the critical path.
- **Browser is ES-module-organized.** Capability registry (`public/capabilities/*.js`) + shared infra (`ble.js`, `state.js`, `log.js`, `settings.js`, `dom.js`) + input modules (`gamepad.js`, `voice.js`) + recovery (`recovery.js`) + prepare (`prepare.js`). `app.js` is ~490 lines of orchestration.
- **Dashboard render is per-entry.** `state.devices: Map<id, entry>`; each entry owns its DOM node via `entry.node`. `renderEntry(entry)` rebuilds one card; `render()` reconciles the list (add/remove/order). A characteristic notify for robot A never touches robot B's DOM.
- Chrome/Edge required (Web Bluetooth, Web Serial, File System Access API).

## Pending, roughly ranked

### NOT YET IMPLEMENTED — next work, in order

**A. BLE-WithoutResponse OTA (~30 lines, no new infra).** Switch
`writeValueWithResponse` → `writeValueWithoutResponse` + ESP32 signals
buffer headroom via `ota-status` every N KB; dashboard pauses when low.
Brings 1.6 MB OTA from 3-10 min to ~30 sec on every ESP32, every network.
This is the baseline speed lane from direction.md item #3. Universal
unblock for the current slow-OTA pain.

**B. PNA + plain HTTP `/ota` on ESP32 (~2-3 hours).** Dashboard
`fetch('http://<robot-ip>/ota', { body: binBytes })` with a one-time
Chrome PNA consent. Requires ESP32 to (1) respond correctly to the
`Access-Control-Request-Private-Network` preflight, (2) accept
`POST /ota` on its existing raw `WiFiServer` (same task that serves
MJPEG), (3) stream bytes into `Update.write()`. ~1 sec OTAs for any
ESP32 on the same LAN as the dashboard. No TLS, no IRAM cost, no new
library. Direction.md item #3 lane 2.

**C. Pi-as-gateway via WebTransport (~1.5 days).** Every Pi ships with
an `aioquic` WebTransport server; self-signed cert fingerprint published
in fw-info; dashboard pins it via `serverCertificateHashes`; Pi proxies
raw TCP to target ESP32 on LAN. Direction.md item #3 lane 3. Cheap to
enable on every Pi once built; unlocks orchestration / offline-first
futures too. Earns its slot when (B) isn't enough, or when multi-robot
coord lands.

**D. ESP32 pin configuration parity with Pi.** Requires ESP32 firmware
to read a config (from SPIFFS or Preferences), fw-info to declare
editable caps with pin schemas, dashboard to render an ESP32 board
layout (different from Pi's 40-pin header). Do when the first real
user-configurable ESP32 capability lands; until then LED_PIN + motor
pin stubs are compiled in.

**E. Fallback lane selector in ota.js.** Dashboard picks A, B, or C
based on availability. Currently picks one path; needs to try fastest
available and fall back on error. Part of landing (B) and (C) cleanly.

**F. Robot = composite of devices, not a single device.** Trigger:
the operator can put a phone on top of a Pi rover and now it has a
second camera; or pair an ESP32-cam onto the same chassis as a Pi.
Today both cases force two top-level cards pretending to be two
robots, and Pip can only reason about one camera at a time. The
unit of work is a *robot* (the thing you task); a robot owns a list
of *devices* (Pi as brain, ESP32 as a second camera, attached phone
as a third). Helpers stay separate but narrow to operator-side only
(laptop cam, unattached phones).

Shape:
- `state.robots: Map<robot_id, { devices: [...], capabilities: aggregated }>`.
  Replaces `state.devices`. A device row tracks `host_robot_id` (null =
  standalone helper). Phone moves between roles by changing this field —
  no new pairing.
- Visual: one card per *robot*, sub-rows per device-with-a-camera.
  Helpers section shows only unattached devices.
- Attach is a routing decision, not a permission decision (phone is
  already paired Ed25519); no new trust gates.
- Pip tool reshape: `get_robot_scene(robot_id)` returns labeled set
  `{front: caption, mounted_phone: caption, esp32_cam: caption}`
  rather than one caption. Planner reads side-by-side and notices
  contradictions. Same shape for `ask_robot_scene` and
  `get_robot_detections` (bboxes are per-camera; frames have
  different geometry). VLM-text-only invariant unchanged.

Phases:
1. **State + visual rename.** `state.robots`, robot-card aggregates
   sub-device rows, helpers section narrows. No Pip-tool change yet —
   keep `get_robot_scene` returning the primary camera. Ships as a
   refactor; nothing changes for single-Pi users.
2. **Attach gesture.** "Attach to <robot>" on phone helper card,
   "Detach" inside the robot card under the attached camera row.
   Persistence: `host_robot_id` lives in IndexedDB alongside the
   pair record.
3. **Multi-camera Pip.** Tool outputs become labeled sets; update
   tool descriptions. Add primary/secondary hint so the planner can
   default to one when the question is unambiguous.

Validation criterion: pair an ESP32-cam alongside a Pi, attach the
phone, ask Pip "what's in front of you?" — Pip gets three captions
back, reasons about which view to trust given the question. If
shipping leaves Pip getting one caption, or the user has to pick the
camera every turn, we missed.

Skeptical angle worth holding: this is a load-bearing rename of the
central abstraction. Phase 1 ships even without phase 3 landing
(robot-as-composite reads cleaner regardless). Don't gate phases 1+2
on phase 3 being "right" — phase 3 is best validated on real
hardware sessions, not on imagined cases.

**G. Draw-a-path-from-overhead-phone.** Trigger: operator holds the
phone above the robot, sees the floor + the robot from above, finger-
draws a line on the phone screen, and the robot follows it. Builds
directly on the phone-as-eye work (item F-adjacent — the phone's
WebRTC stream already arrives at the dashboard). The hard sub-problem
isn't drawing or motor control — it's pose. Without knowing where
the robot is in the image every frame, the closed loop doesn't close
and the robot drifts off the path within seconds.

Shape (the right primitives, in order of "what's load-bearing"):
- **Pose via fiducial marker (ArUco) on top of robot.** Boring,
  deterministic, sub-pixel pose, ~10-20 ms per frame in JS, gives a
  known-size scale reference for free. Markerless tracking is a
  research project; ArUco is a tape-this-on-and-it-works primitive.
  This is the right MVP. Markerless can earn its way later.
- **Where compute lives:** phone is I/O (camera out, drawing strokes
  in over the existing WebRTC data channel) — no CV on phone.
  Dashboard runs ArUco + controller + emits BLE motor pulses. Robot
  unchanged. Same control-plane / data-plane split as everything
  else.
- **Tech recs:** `js-aruco2` (~100 KB pure JS) is enough for 5-10 Hz
  pose. Reach for OpenCV.js (~10 MB WASM) only if measurement says
  js-aruco can't keep up. Pure-pursuit controller in plain JS
  (~50 lines). Three.js / WebGPU / WebNN are NOT load-bearing for
  this — three.js is a 3D renderer (use only for debug overlay if
  needed later); WebGPU is overkill for marker matching.
- **Control loop:** ArUco detect (~15 ms) + plan (~1 ms) + BLE
  WithResponse write (~50 ms) ≈ 70 ms / iteration → ~14 Hz. Each
  iteration emits a short pulse (`duration_ms ≈ 100 ms`); firmware
  watchdog auto-stops if the next iteration doesn't arrive. The
  existing pulse-bounded-motion + watchdog invariants are the
  correct safety floor — this is "another planner above the
  capability" and lives under the same discipline as Pip / user
  scripts.
- **New Pip tool surface:** `get_robot_pose(robot_id)` returns
  `{x, y, theta, confidence}` from the fiducial detector when a
  marker-bearing camera is available on the robot. Pip can use it
  for grounded spatial reasoning beyond what `get_robot_detections`
  provides (which is image-coords-only). Optional, not on the MVP
  critical path.

Phases:
1. **Marker + dashboard pose pipeline.** Print + tape ArUco on the
   robot. Wire `js-aruco2` against the phone's video stream when
   it's mounted on a robot. Render the detected pose as a small
   debug overlay on the robot card so we can SEE it works before
   trusting it for control. No motors yet.
2. **Phone-side drawing.** `<canvas>` overlay on phone.html
   viewfinder; touch listeners build a stroke-point array; send
   over the existing WebRTC data channel as a typed message
   (`{type: "path", points: [[x, y], ...]}`). Dashboard receives
   and stores; renders the path on the same debug overlay. Still
   no motors.
3. **Closed-loop follower.** Pure-pursuit driving the most-recent
   path; pulse-bounded each iteration; safety stops on marker-loss
   ≥ 1 s, end-of-path, or new tap-to-cancel from the phone.
   Confidence-based handoff (CLAUDE.md invariant): low marker
   confidence → ask_human rather than guess.

Validation criterion: tape marker on Pi rover, hold phone overhead,
draw a curved path on the phone screen, watch the robot trace the
curve to within ~5 cm of the drawn line over 1-2 m. If shipping
leaves the rover drifting off-line within a few seconds, or if the
loop falls below 5 Hz on the target devices, the primitive isn't
load-bearing and we redesign before extending.

Scope honesty (CLAUDE.md update gated on validation): today scope
says "Not spatially aware. Monocular camera + VLM text — no depth,
no SLAM, no metric maps. Navigation is semantic (landmarks, 'further
along the wall'), not geometric." Phase 1 of this work flips that
partially — fiducial marker = ground-plane metric pose for the
robot, when an overhead camera is available. Not full SLAM, not
depth, but a real 2D ground-truth primitive. CLAUDE.md should be
updated to "Spatial awareness is fiducial-bounded — when an overhead
camera + marker is present, the robot has a known 2D pose; otherwise
the existing semantic-only invariant holds." DO NOT update CLAUDE.md
until phase 3 lands and the validation criterion passes — claiming
a capability before it works is the worst kind of scope drift.

Skeptical angle worth holding: this is a meaningful primitive, not
a one-off feature. Two failure modes to watch:
- "Marker lost" handling. The phone is held by a human; it WILL
  shake, tilt, occlude. Over 1 s of marker loss → safety stop. Not
  optional; this IS the safety story for this loop.
- The "phone overhead" geometry assumption. If the user holds the
  phone at an angle, the floor isn't co-planar with the image. For
  short paths and small angles, marker pixel position is good
  enough as a proxy for ground position. For larger paths, a
  homography (4 known floor points OR phone IMU + marker scale)
  earns its way. Defer until path length actually demands it.

**H. Perception model rotation: drop OWLv2, add YOLO26n.** Trigger:
the project direction softened toward "toy self-driving car" — desk
/ tabletop scale, walking speed, single robot. The current two-model
perception stack (OWLv2 for bboxes via `grounding.js`, LFM2.5-VL-450M
for captions via `perception.js`) is shaped for the OLD scope where
the loop was seconds-latency and "spatially aware" was off the
table. With closed-loop control on the table, OWLv2 at 1–2 s per
inference is the wrong primitive — too slow to drive against. YOLO26n
runs at 10–30 ms per inference on WebGPU, cleared January 2026, ONNX
exports cleanly, NMS-free deterministic latency. That's the missing
"fast reflex layer" the comma.ai-shaped two-tier pattern needs.

The other shift worth banking: LFM2.5-VL-450M's April 2026 release
added bbox prediction (RefCOCO-M 81.28). That inverts a CLAUDE.md
assumption — VLM was "text only, never spatial." With bbox-output
LFM-VL we can do "where is the doorway?" without a separate detector
session. Combined with YOLO26n's closed-vocab speed, OWLv2's
open-vocab niche shrinks to "things you can describe but YOLO wasn't
trained for AND need bboxes faster than LFM-VL prompting can do."
That niche is small enough that retiring OWLv2 is probably right.

Shape:
- **YOLO26n** — fast detector for the closed COCO class set + any
  custom classes the toy needs (lane lines / colored objects via
  re-train). New module `public/yolo.js` mirroring `grounding.js`'s
  shape; transformers.js with onnx-community/yolov26n-onnx (or the
  Ultralytics export path if the community port lags). Tool surface:
  rename `get_robot_detections` to be backed by YOLO instead of
  OWLv2 — Pip's prompt doesn't change.
- **LFM2.5-VL-450M with bbox prompts** — already loaded for captions;
  add `ask_robot_scene` variants that prompt for structured JSON
  output (`{objects: [{name, box: [x, y, w, h]}, ...]}`) for
  open-vocab spatial when "what objects with positions" is the
  question. One model, one session.
- **OWLv2** — retire. Delete `grounding.js` once YOLO26n + LFM-VL
  bbox-prompting cover the use cases observed in replay. Keep the
  module flag pattern (`GROUNDING_ENABLED`) renamed to a generic
  detector-availability gate so the stop-rule executor doesn't
  break.

Phases:
1. **Add YOLO26n alongside OWLv2.** Don't delete anything yet. Add a
   `?detector=yolo` URL flag so the dashboard can A/B which model
   answers `get_robot_detections` for a session. Compare quality on
   a fixed set of typical "what's in front of the robot" questions.
2. **LFM-VL bbox prompting.** Add a structured-JSON output mode to
   `ask_robot_scene` — one prompt template that asks for objects +
   normalized boxes, parsed back into the same shape OWLv2 returns
   today. Validate that LFM-VL's bboxes survive on this die /
   browser combo (its older sibling didn't always).
3. **Retire OWLv2.** When (1) shows YOLO is faster + good enough
   AND (2) shows LFM-VL covers the open-vocab niche, delete
   `grounding.js`. Update CLAUDE.md model discipline.

Validation criterion: closed-loop "drive toward yellow can on the
floor" at ≥ 5 Hz with YOLO26n alone. If the toy can servo to a
target without stalling on perception, the model rotation is the
right call. Failing < 5 Hz means we either need a smaller YOLO
variant, fewer frames per inference, or revisit whether browser
ONNX hits the latency budget on the target hardware.

Skeptical angle: this is a perception-architecture move and they're
hard to reverse cleanly — once Pip's prompts assume YOLO's class
vocabulary, switching back to open-vocab is more work than the
flag-gated A/B suggests. Don't merge the prompt assumption changes
in phase 1; only land them after phase 3's deletion. And the
YOLO26 export-format gotcha (default 1×84×8400 vs the embedded
NMS-free format) needs to be settled at the export stage, not in JS
post-processing — confirm before committing.

**I. WebRTC byte transport (Pi: aiortc; ESP32: libpeer).** Trigger:
the user wants browser-side shell into the Pi (over BLE *or* WiFi),
and the natural browser primitive (no raw TCP) forced the question of
how a browser can speak any custom byte protocol to a robot. WebRTC
data channels are the answer — both targets become peers, the dashboard
opens labeled DataChannels, anything that needs a stream rides one of
them. libpeer (sepfy, pure C, ~6 KLOC, mbedTLS-backed) compiles for
both Linux/ARM (Pi) and ESP-IDF (ESP32-CAM-MB), so one stack covers
the fleet.

What it unlocks once the substrate exists:
- **Shell** (Phase 1.A): DataChannel(`shell`) bridges to Pi's
  localhost:22 sshd. Browser runs `ssh2` inside a WebContainer; a
  Duplex stream wraps the DataChannel and ssh2 thinks it has a real
  net.Socket. Real SSH crypto end-to-end, key auth via auth.js's
  existing ed25519 (which finally does its second job — the prepare
  flow already enrolls the dashboard pubkey in `authorized_keys`).
- **OTA at WiFi speeds** (Phase 1.B): replaces the slow BLE-chunked
  OTA path with a DataChannel push. Brings firmware updates from
  minutes to seconds without waiting for lane B (PNA) to land.
- **Log streaming**: `journalctl -f` over a `logs` DataChannel instead
  of get-log snapshot polling.
- **Camera (Phase 2, ESP32-CAM-MB)**: hardware-encoded video track
  replaces MJPEG-over-HTTP. Lower latency, lower CPU, native browser
  playback. The target hardware has 4 MB PSRAM, enough for libpeer +
  camera framebuffer per Sepfy's reference designs.
- **File transfer, telemetry firehose, future channels**: each is a
  new DataChannel label, not a new daemon/port.

Architecture:
- Pi runs `pi-robot-rtc.service` — small C daemon linking libpeer +
  mbedTLS + libsrtp, exposes signaling on the existing `:81` HTTP
  surface (`POST :81/webrtc/offer` returns answer + ICE inline). LAN-
  direct, no signal.neevs.io.
- ESP32 firmware grows libpeer integration; signaling either via the
  same HTTP-on-`:81` shape (camera task already runs an HTTP server)
  or via a BLE typed-op (`webrtc-offer`) when WiFi is the resource
  being constrained.
- Dashboard: new `webrtc-robot.js` (peer manager + DataChannel pool
  per robot), `shell.js` (xterm + WebContainer + ssh2 + Duplex shim),
  later `webrtc-camera.js` (consume the video track). Lazy-loaded —
  WebContainer only mounts when shell opens.

Phase plan:
- **Phase 1.A** — Pi shell over WebRTC. Smallest end-to-end demo:
  click Shell in robot menu → xterm pops → real bash on the Pi via
  SSH-over-DataChannel. Validates the substrate.
- **Phase 1.B** — OTA over a second DataChannel (highest user-visible
  latency win after shell).
- **Phase 1.C** — Log streaming.
- **Phase 2** — ESP32-CAM-MB libpeer integration + camera-as-WebRTC-
  video-track.

**Pivot 2026-04-29: aiortc on Pi, libpeer reserved for ESP32.** The
"libpeer everywhere" plan above survived first contact with reality
until two issues stacked: (1) browser Mixed Content blocks HTTPS
dashboard → HTTP `<pi>:82` fetches before PNA preflight runs, killing
the local-HTTP signaling path, and (2) routing through wss:// would
have required either an MQTT broker on signal.neevs.io (libpeer's
built-in signaling) or a hand-rolled WebSocket client in C. aiortc
speaks WebSocket via aiohttp trivially and runs in pi-robot.py's
existing asyncio loop, so the Pi side ships in hours. ESP32 keeps
libpeer for Phase 2 where Python isn't an option. The "one stack
across the fleet" property was nice-to-have; "Python where Python
lives, C where C lives" is also defensible and let signaling go
through the existing `wss://signal.neevs.io/<roomId>/ws` rendezvous
that phone-pair already uses. roomId is `pi-rtc-<robotId>` so the
dashboard finds each Pi without separate discovery.

Skeptical angle: libpeer is a real C dep with build/cross-compile
work. Phase 1.A proves the architecture but doesn't yet save anything
the user couldn't get with `ssh robot@hostname.local` from their
terminal. Phases 1.B and 2 are where the substrate earns out — don't
declare victory at 1.A, plan to build through 1.B at minimum.

### Background-rank items (known, not urgent)

### 1. ESP32 URL-trigger OTA still fails with http -1 on CAM-MB (superseded by lane work)
**Status: SHELVED.** URL-trigger required TLS on ESP32 (HTTPClient +
NetworkClientSecure + mbedTLS), which doesn't fit IRAM alongside the
camera. The above lane-A (BLE-WithoutResponse) and lane-B (PNA direct)
give the same speedup without the IRAM cost, on the same binary.
Keeping the notes below for historical context; not the path forward.

Original analysis:
- Firmware confirmed new on-device (fw-info read returns esp32/url JSON). HTTPS GET fails before data flows.
- `HTTPClient.GET()` returns -1 = `HTTPC_ERROR_CONNECTION_FAILED`. Root cause most likely **TLS handshake under memory pressure** — BLE stack + mbedTLS co-resident on ESP32-CAM.
- **Shipped mitigations:** setFollowRedirects, 20s timeout, free-heap logging in the failure message so we can confirm memory pressure next attempt.
- **Couldn't ship:** `setBufferSizes(rx, tx)` — the API went away in ESP32 Arduino 3.x (WiFiClientSecure → NetworkClientSecure).
- **BLE-stream fallback still active** — dashboard auto-retries over BLE after 8s silence, so users aren't stuck.
- **Corrected NimBLE framing (verified 2026-04-18 from primary sources):** NimBLE is NOT the default on ESP32 WROOM/CAM in arduino-esp32 3.3.x — only on newer SoCs (S3/C3/C6) that lack Bluedroid support. Built-in `BLEDevice.h` stays Bluedroid-backed on WROOM/CAM; our current sketch compiles unchanged on 3.3.8. A NimBLE migration on CAM requires switching to the separate `h2zero/NimBLE-Arduino` library (include + class-name rewrite) — not a recompile. The "CAM NimBLE instability" concern from an earlier scan was unverifiable from primary sources; treat it as unknown, not blocking. ~100KB memory savings from NimBLE is still the right direction for CAM-MB's TLS pressure problem, just more work than we thought.
- **Pinned arduino-esp32 3.3.8** in Makefile + CI — 3.3.6/3.3.7 silently bypass signed-OTA verification (PR #12425).
- **Heap logging stays** — load-bearing until the next on-device test confirms whether pressure is the cause.
- **Next moves, in priority order:**
  1. **Accept BLE fallback** as the CAM-MB story (10 min vs 10 sec is a cost, not a failure). Doc it as "expected on CAM" so users don't hunt a ghost. Lowest-effort resolution.
  2. **FreeRTOS-task HTTPS fetch** — separate stack for the download, doesn't steal from BLE. Keeps Bluedroid. ~2 hr work.
  3. **NimBLE migration via `h2zero/NimBLE-Arduino`** — real code rewrite, ~100KB relief. Validate on S3/C6 first (stable NimBLE territory), then try on CAM. Half-day work plus on-device iteration.
  4. Signal/WebSocket transport — still TLS, doesn't solve the memory problem.

### 2. Would a Service Worker improve the architecture? (open question)
- **Yes for:** offline dashboard (cache static assets + firmware bins so pairing+basic use works without internet, OTA keeps working after a WiFi drop), PWA installability (Add to Home Screen for classroom/demo iPads and Android), faster repeat visits.
- **No for:** holding BLE connections across page reloads (SW can't use Web Bluetooth — only foreground page can), running robot activity in the background.
- **When it earns itself:** if the project leans into field/classroom use where flaky WiFi + many-robot demos matter. Today the dashboard works fine as a page; SW is polish, not critical path.
- **Not blocking anything.** Decide when the use case surfaces.

### 3. USB gadget mode validation
- `dtoverlay=dwc2` + `modules-load=dwc2,libcomposite` + NM shared-mode `usb0` at `10.55.0.1/24` is wired in. Recovery console (Web Serial → ttyGS0) is in use by the user as of 2026-04-19; ECM ssh path still untested. Autologin on ttyGS0 lands once OTA propagates.
- **Plan:** next card re-prep, plug USB-C to Mac, try `ssh robot@10.55.0.1`. Confirms the debug channel works before we actually need it.
- **Not a blocker.**

### 4. Signal as messaging transport (deferred, not rejected)
- Considered using `~/Github/jonasneves/signal` (Cloudflare Workers rendezvous rooms) as the data plane instead of hardcoded URLs.
- Doesn't solve the current TLS-memory bug (WSS = still TLS on ESP32).
- Adds WebSocket client lib to firmware (~50KB). Adds signal as critical-path infra.
- **Reconsider when:** streaming video, multi-robot coordination, or another feature requires browser-as-source for bulk data that doesn't fit BLE.

### 5. Scout-surfaced follow-ups (folded in 2026-04-18)
- **`bluez-peripheral` 0.2.0a5 spike.** Modern BlueZ-native peripheral lib; if it works non-root and without `--experimental`, the Pi firstrun script gets materially simpler. Worth a time-boxed trial.
- **Update `HARDWARE.md` to call out ESP32-C6** as the recommended board for new non-camera BLE-first builds. S3 is fine but C6 has native BLE 5.3 + more RAM headroom and matches the "BLE is the control plane" framing better than S3's dual-radio emphasis.
- **Treat `getDevices()` persistence fallback as load-bearing, not transitional.** Web Bluetooth's `getDevices()` has stayed flag-gated for years with no movement. The localStorage+filter-by-name path in `loadPaired()` is the primary paired-device persistence story; don't plan to retire it.

### 6. In-browser SD-card flasher (backlog, ~2 days when it earns a slot)
- Kill the last "install something" step in the user journey: Raspberry Pi Imager. Replace with a browser flow that claims the USB SD-card reader via WebUSB, issues SCSI WRITE(10) commands to stream Pi OS onto the card, verifies with SHA-256 readback, then hands off to the existing Customize-card flow.
- **Precedent, not standardized:** `balena-sdcard-web` and a couple of educational-kit vendors ship this. Official `rpi-imager` has no web version.
- **Friction caveat on macOS:** OS auto-mounts the card; user has to `diskutil unmountDisk /dev/diskN` before the browser can claim the USB interface. Doable but needs explicit guidance in the UI. ChromeOS handles this cleaner.
- **Scope:** ~1.5–2 days. Stage 1: WebUSB device claim + single-partition raw write + verify. Stage 2: progress UI + resume-on-disconnect + SHA-256 readback.
- **Worth it when:** 3+ people are setting up Pis from scratch. Until then, `open -a "Raspberry Pi Imager"` is one shell command.

### 6.5. Phone-to-phone state sub-protocol (sketch, pre-paving phone-to-phone WebRTC)

**Why now (sort of):** user asked about sharing state across connected
devices "like a shared localStorage." Reframe: localStorage is a storage
primitive; the right model is "what *concepts* should sync, when, and
what's the conflict policy." The concrete near-term need is multi-
operator phone-to-phone sessions where each phone holds a different
role (eye, driver). Today, role coordination flows desktop-as-relay;
once phone-to-phone direct WebRTC ships, peers need a shared session
state without bouncing through the desktop.

**Scope decision (selection lens):** *don't* build full preferences-
sync (server-side, persistent across all-offline). The toy-scale scope
doesn't earn the auth + storage backend. *Do* build ephemeral peer-
sync over the existing WebRTC data channel — state lives only while
≥1 peer holds it, vanishes when all go offline.

**Wire shape (data-channel sub-protocol):**

```js
// publish a key
{ type: "state-set", key: "active-eye-phone", value: "<phoneId>",
  rev: <Lamport tick>, origin: "<phoneId>" }

// acknowledge / merge
{ type: "state-applied", key: "active-eye-phone", rev: <tick> }

// initial sync on peer-join
{ type: "state-snapshot", entries: [{key, value, rev, origin}] }
```

Conflict policy: last-write-wins by Lamport rev; tie-break by origin
id (deterministic). One key per concept, one origin per write.

**Keyset (start small, grow per use case):**
- `active-eye-phone` — which paired phone is currently mounted on the
  robot (today bounces through desktop's `attachedFromPhoneId`)
- `pip-led-intent` — Pip's most recent directional intent ("look left",
  "describe scene"), so all peers see what Pip is asking for
- `robot-source-pref` — which camera the *operator* is currently
  watching (today set per-phone via tap-pick; share so peers know)

**Out of scope (explicit):**
- BLE pairings (controller-bonded, physically untransferable)
- localStorage broadly ("everything everywhere syncs")
- Cross-session persistence (state vanishes when last peer leaves)
- Auth tokens (privacy + security cost > value)

**Cost:** ~150 LOC. New file `public/peer-state.js` with `set(key,
value)`, `get(key)`, `subscribe(key, fn)`. Hooks into `phones.js`'s
existing `_phones` Map for peer enumeration; piggybacks on the
existing data-channel send/receive.

**Trigger to actually build:** when phone-to-phone direct WebRTC lands
(audit option B from the camera-sharing discussion). Keysets above
become real then; today's desktop-relay model covers the same
behaviors with less infrastructure.

### 7. LLM-orchestrated dashboard (direction, not yet in flight)
- Direction confirmed: eventually an LLM (webmcp-style) drives pairing, driving, OTA, etc. through a tool interface. Per-card render ships today specifically to set up this future — one state change mutates one card, a `get_robot_state(id)` tool returns one entry, a state-push channel notifies by entry-id rather than whole-page snapshots.
- **Patterns worth stealing from `~/Github/organizations/hatch` when we get here:**
  1. Domain-scoped tool adapters with per-context system prompts (one adapter per "mode" — pairing, debugging, classroom demo).
  2. Tool results as JSON objects, not text. Errors too (`{error: "..."}`, not mixed strings).
  3. Two-phase inspection: `list_robots()` → `get_robot_state(id)` → targeted actions. LLM learns to drill down.
  4. Approval gates for learned tools + confidence scoring. Gate before auto-executing; refine-and-resubmit on drift.
  5. SSE state push (optional, when state changes originate outside the LLM — e.g., a watchdog firing on a robot).
- **Don't copy from hatch:** behavioral-trust ledger (overkill for single-user dashboard), multi-bridge primary/secondary election (only needed for multi-client orchestration).

## Recently landed (context for what's "done")
- **Typed BLE ops verbs replace shell-over-BLE.** SHELL.md is "not pursuing"; the working alternative is a growing set of typed verbs on `ops` + `ops-response` (chunked notify): `restart-service`, `reboot`, `install-pkg`, `enroll-key`, `get-log`, `get-config`, plus single-file uploads via `uploadFile()` (mini-bundle on the OTA channel). Every concrete "why would I SSH in" use case has a verb. New verbs scale this without opening a tty.
- **Pinout editing over BLE.** Per-Pi `⋯ → Pinout (GPIO) → Edit pins`. Fetches `pi-robot.conf` via `get-config`, lets user retarget LED / motor GPIOs / camera enable, flags pin conflicts, saves via single-file bundle OTA with `restart: pi-robot`. SSH no longer required for pin tweaks.
- **Telemetry char (notify, every 6s):** `{uptime_s, mem_free_mb, temp_c?}` rendered as a compact line below the robot-status state.
- **Robot-status with sticky-on-disconnect.** Top-level `{st, msg?}` notify channel; "rebooting" / "restarting" / "installing" announce 2s before action so the dashboard sees context before BLE drops; last-known status sticks for 30s after disconnect ("was rebooting").
- **Dashboard identity = ed25519 keypair** in IndexedDB. Auto-authorizes SSH on freshly-prepped Pis (writes `dashboard.pub` to /boot/firmware/, firstrun appends to `authorized_keys`). BLE TOFU enrollment for already-deployed Pis (Phase 3 — `enroll-key` ops verb + `authorized` list in fw-info). Phase 4 (challenge/response verification) deferred — no consumer needs it now that typed verbs cover the access patterns.
- **Firmware version stamping.** `make publish-pi-firmware` writes commit SHA into `version.py` + `ota-manifest.json.commit`. fw-info surfaces it; OTA log shows what's about to flash. Cache-busted manifest fetch + SD-prep fetches stop GH Pages CDN serving stale.
- **Username `pi → robot` decoupling.** $HOME / __HOME__ / __USER__ expand at OTA-apply time; service unit, OTA dest paths, allowed prefixes all derive from the install location instead of hardcoding pi. `_derive_install_home()` parses from `__file__` so the bug where `_OTA_HOME = os.path.expanduser("~")` returned `/root` (service runs as root) is gone.
- **ESP32 camera (OV3660 / OV2640 / OV5640 on CAM-MB socket).** Firmware initializes `esp_camera` with the AI-Thinker pin map, auto-detects the sensor, starts an MJPEG HTTP server on `:81/stream` after WiFi joins, and advertises `caps: [{name:"camera", type:"mjpeg-stream"}]` in fw-info. Dashboard's new `mjpeg-stream` runtime renders `<img src="http://<ip>:81/stream">`. IP comes from an expanded `wifi-status.ip` field (published on Pi too for parity). LAN-shared browser required — the WiFi data plane, not BLE.
- **Bluetooth pairable on every pi-robot start.** `ExecStartPre=-/usr/bin/bluetoothctl pairable on` in pi-robot.service. Pi OS Trixie boots with adapter Pairable=no by default which silently broke `gatt.connect()` from Chrome.
- **Bluetooth unblock on every bluetoothd start.** `ExecStartPre=-/usr/sbin/rfkill unblock bluetooth` in bluetooth.service drop-in. Masking systemd-rfkill alone isn't enough — kernel default re-blocks on boot.
- **Serial Recovery autologin.** `serial-getty@ttyGS0` drop-in with `--autologin <user>`. USB cable possession is already the trust boundary.
- **QR-arrival pair flow.** `?robot=X` URL hint shows a one-tap Pair banner at the top of the dashboard.

- **Recovery plane: USB-CDC-ACM + xterm.js.** Pi runs composite USB gadget (ECM + ACM) via `usb-gadget.service` (independent of pi-robot). Dashboard has a Recovery console menu item that dynamic-loads xterm.js over a Web Serial connection to `/dev/cu.usbmodem*`. Real terminal — Ctrl+C, ANSI escapes, arrows, selection all work.
- **Bundle OTA.** Multi-file updates in one BLE transfer. Manifest at `firmware/pi_robot/ota-manifest.json` declares files + modes + post_install commands + reboot. Pi's `_apply_bundle` validates, stages to `.new` paths, atomic-renames, runs hooks, reboots. Legacy single-file OTA still works for backward compat (pi sniffs payload shape at commit). Dest-path whitelist prevents a malformed manifest from writing to arbitrary locations.
- **Install-on-demand for camera.** Admin-style BLE opcode → Pi runs apt+pip in background with progress streamed back via camera-status notify. No SSH needed for optional dep install. Uses sys.executable (venv's python) to avoid PEP 668 externally-managed Python errors.
- **Admin characteristic.** `Restart service` menu item → ADMIN_OP_RESTART opcode → Pi runs `systemctl restart pi-robot`. Soft-stuck recovery without USB or SSH.
- **Capability config on Pi.** `/boot/firmware/pi-robot.conf` declares `led_enabled`, `led_pin`, `motors_enabled`, `camera_enabled`. Firmware gates characteristic registration on config. Dashboard Customize-card flow writes the config based on checkboxes.
- **Consistent modal close behavior.** `wireDialogOutsideClick()` helper in dom.js. Every `<dialog>` closes on backdrop click (Escape is native). Popover `robot-menu` has explicit click + Escape listeners at document level.
- **Browser refactor (stages 1–3).** app.js went from 1440-line monolith to 490 lines of orchestration + capability registry + input modules. Adding a capability = one new file + one line in registry.
- **Per-card render foundation.** `entry.node` owns the card DOM; `renderEntry(entry)` scopes innerHTML rebuild to one card; `render()` handles list-level changes only.
- **Wider layout.** `main` max-width 1200px; `#robot-list` is `repeat(auto-fill, minmax(360px, 1fr))` — stacks on phone, side-by-side on laptop. Setup-grid capped at 800px so two onboarding cards don't stretch across a wide page. `h1`/`p.lede` capped at 640px for readability.
- **Collapsible setup section.** `<details id="setup-section">` with "Set up new hardware" as the `<summary>`; folded by default when robots exist, expanded when the list is empty. Session's user toggle persists (render doesn't force-reset).
- **Dashboard visual compression pass.** Log is now a three-column grid (time · name · msg) with name-dedup across bursts; system-level log lines (no robot name) span the message into the name slot; status dot moved left of the robot name; "Connected" / "Not connected" text dropped (dot + button carry it); redundant connecting/connected/disconnected log lines removed; dead `_debug_log` wifi-scan instrumentation in pi_robot.py removed; watchdog-rationale comments tightened to one sentence at each declaration; `makeEntry()` factory shared between `entryFor` and `loadPaired` hydration.
- **Vision-led README + `docs/hardware.md` split.** Tagline matches the website; board-specific FQBNs / LED pins / kext notes moved out.
- **New tagline:** "Pair any robot in a browser tab. No network, no accounts, no servers." Set on the website and GitHub About.
- **Setup section split into two top-level cards** (ESP32 / Pi), label moved outside, CTA buttons anchored to the bottom so they align across cards.
- **SSH Upload overlay** in the prepare dialog — replaces the separate "Load from file…" row with a code-block-style button in the textarea corner.
- **ESP32 advertising resumes on disconnect** — no more reboot-to-re-pair; matches the Pi's BlueZ behavior.
- **Dashboard split into html/css/js; prepare.html folded into a `<dialog>` inside index.html.** styles.css and app.js linked; IIFE-scoped prepare logic shares helpers. `?prepare` URL param auto-opens the dialog.
- Per-card "last activity" footer; log lines prefixed with robot name.
- Motors with watchdog (both platforms)
- Multi-robot simultaneous BLE connections
- Per-robot top-level cards (each robot is its own `<section class="card">`)
- URL-trigger OTA + BLE-stream fallback
- OTA commit deferred restart (fixes the "GATT operation failed" false negative after successful flash)
- Log messages prefixed with robot name + per-card last-activity line
- Platform APIs adopted: Wake Lock during OTA, Bluetooth availability detection, Forget repairs Chrome's paired-list via `getDevices()`
- CI builds firmware on `firmware/**` push and commits artifacts back
- README architecture rewrite: control/data channels named, watchdog as a convention, ESP32-S3 recommended for new builds
- CLI `make sd-prep` / `prepare-sd.py` removed — browser `prepare.html` is the only blessed path

## Known gotchas — don't re-learn these
- Pi OS Trixie = Python 3.13 (Bookworm = 3.11). Stage wheels for the running version.
- Pi OS Trixie ships Bluetooth **soft-blocked** by rfkill. `bluetoothctl power on` silently fails until `rfkill unblock bluetooth` runs. This was a multi-cycle debug.
- `bless` requires BlueZ `--experimental` flag *and* `Experimental=true` in `/etc/bluetooth/main.conf`. Both — different BlueZ versions honor different paths.
- `bless` on Pi OS must run as root. Non-root DBus policy is brittle across BlueZ versions.
- `bless` Linux dep chain: `bless` needs `dbus-next` (not `dbus-fast`); `bleak` needs `dbus-fast` + `typing-extensions` (Python<3.12). pip's resolver cross-platform picks the wrong variants.
- `files.pythonhosted.org` has no CORS headers. Wheels must be hosted same-origin as the dashboard.
- ESP32 BLE default `numHandles` is 15. Current service needs ~22. Excess characteristics are silently dropped at registration — devices appear to advertise only the first N.
- `ESP.restart()` inside a BLE `onWrite` callback eats the ATT response. Defer via a flag polled in `loop()`.
- Web Bluetooth serializes writes per-characteristic. Fast slider events cause "GATT operation already in progress." Use drop-intermediate-values: always queue the latest wanted value, send after in-flight write completes.

## Conventions (active rules)
- **Reframe at stable checkpoints** (cross-project, lives in `~/.claude/CLAUDE.md`) — after a thing works, ask if the shape itself was right rather than micro-optimizing what shipped.
- Actuator characteristics ship with a watchdog; don't layer safety above the capability.
- BLE writes with sha256 integrity means `setInsecure()` on the ESP32 HTTPClient is OK — integrity is cryptographically verified before commit.
- Commit messages name what the project has now, not the diff.
- No hardcoded trust in external infrastructure in the critical path. WiFi/signal/etc. are optional data planes; BLE always works.
