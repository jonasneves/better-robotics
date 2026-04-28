# Developer reference

`DEV.md` at the repo root is the canonical list of URL flags, `window.*` handles, IndexedDB stores, and common debug paths.

# Project layout

- `docs/` is a symlink to `public/`. GitHub Pages serves `docs/`; the site content lives in `public/`. Repo-level docs (HARDWARE.md, SMOKE.md, etc.) live at the root or inside subsystems.
- `public/` is flat by design — file count is manageable, naming prefixes carry the subsystem boundary. Promote a subsystem to its own folder (like `capabilities/`) once it passes ~5 files whose internals shouldn't leak outside.

# Subsystem map

- **Pair layer** — `pairing.js`, `phones.js`, `phone.js`, `phone.html`. Desktop ↔ phone WebRTC.
- **Perception** — `perception.js`. In-browser VLM, camera-frame capture, scene prompt.
- **Pip / assistant** — `assistant.js`, `claude.js`, `pip-tools.js`, `replay.js`. Claude integration, tool schemas, executor, replay logging.
- **Robot ops** — `ble.js`, `ops-response.js`, `capabilities/`. BLE protocol, ops channel, per-cap cards + runtime.
- **Robot lifecycle** — `prepare.js`, `recovery.js`, `pinout.js`. SD prep, USB recovery, pinout editor.
- **User code** — `scripts.js`. Browser-resident IDE for user-authored robot code. Mirrors the BLE capability surface; persisted in localStorage. See `USER-CODE.md`.
- **App shell** — `app.js`, `dom.js`, `state.js`, `settings.js`, `log.js`, `auth.js`, `passwords.js`, `index.html`, `styles.css`, `icons.svg`.

# Smoke testing

Two layers, kept cheap:

- `make smoke` — pure-function tests via `node --test tests/*.test.js`. Anything in `format.js` (and future pure helpers) earns a row in `tests/format.test.js`. Runs in <1 s.
- `SMOKE.md` — manual checklist for architectural promises (lifecycle, render patterns, capability behavior, Pip flow, recovery).

Pattern for new pure helpers: extract from `app.js` / cap runtime into `format.js`, import where used, add a test.

# Comment discipline

Default to no comments — every line is context cost in an AI-edited codebase.

Keep when the comment carries WHY: hidden constraints, kernel/API gotchas, workarounds for past bugs, cross-file invariants ("must match `firmware/pi_robot/pi_robot.py`"), schema/wire-format examples. Cut when it restates WHAT: module preambles, narration, section banners, labels above obvious code.

# Dialog vs menu dismiss

- **Menus + popovers** (robot-menu, avatar-menu, help popovers, Pip's `<div popover>`): outside-click + Escape dismiss.
- **Dialogs**: × button or Escape only. Outside-click would nuke session state (recovery terminal, SD prep) for a tiny convenience win.

# Control-loop architecture

The "openpilot panda" pattern: safety enforced *below* the intelligent layer, not inside it.

- Firmware caps motor speed, pulse duration, and watchdog auto-stop. The LLM planner can't bypass them — not even via a malformed tool call.
- LLM-issued motion is pulse-bounded (`duration_ms` mandatory; firmware auto-stops). Persistent speed is reserved for human joystick control where there's a 20Hz+ decision loop.
- `ask_human_via_phone` is the terminal rung of the decision cascade — the planner asks to be overridden rather than waits for the operator to step in.
- Pip has a silent local-LFM fallback when the primary backend returns null AND `settings.pipLocalInstalled` is true. A null Pip reply means BOTH paths returned null.

# Model discipline

Different model shapes are good at different jobs — distinct primitives, not interchangeable "AI". Past planner-layer attempts to paper over capability gaps with prompt-engineering have bitten us.

- **ArUco fiducial pose** (`aruco.js`): sub-pixel pose of *tagged* objects. ~10–20 ms in JS, deterministic. Doesn't see anything untagged.
- **YOLO26n closed-vocab detector** (`yolo.js`, in flight): fast bboxes for COCO + custom labels. ~10–30 ms on WebGPU. Reactive-tier; only sees trained classes.
- **VLM** (LFM2.5-VL-450M via `perception.js`): semantic + open-vocab spatial. Caption + structured-JSON bbox prompting. ~1.5 s — planner-tier, not reactive. Single-pulse motion based on VLM text is fine for a toy; chaining without a deterministic primitive re-asserting between pulses drifts.
- **OWLv2 open-vocab detector** (`grounding.js`): being retired in favor of YOLO26n + LFM-VL bbox-prompting.
- **Claude (planner)**: seconds-latency, multi-turn, tool-calling. Strong at goal decomposition, weak at closed-loop visual servo (2–5 s round-trip). Belongs at the planning layer.
- **Local LFM2.5** (`local-llm.js`): offline / API-outage fallback. 512-token output ceiling, retries needed.

# Transport channels

Each transport has a distinct job:

- **BLE** — control plane. Low latency, proximity-authenticated, lossy. Anything that sets motor speed, toggles an LED, commits state.
- **Typed ops over BLE** — structured verbs on a single characteristic (`get-log`, `get-config`, `restart-service`, `wifi-scan`, `wifi-join`). Each verb is a deliberate, reviewable decision instead of a real-shell transport.
- **WebRTC** — phone ↔ desktop. Pair-ceremony authenticated (Ed25519 pubkey + signed pair-request). Carries camera frames, ask-human responses, robot-command relays.
- **Wifi-presence** — mDNS + cached-IP probe. Robots publish over mDNS; dashboard probes `<name>.local:81/health`. No internet rendezvous (signal.neevs.io stays for cross-network phone-pair only).
- **USB-CDC** — recovery plane. Last-resort serial console, runs as its own systemd unit so a `pi-robot.service` crash doesn't take recovery with it. Bounded by physical access.

Pattern: control = BLE, observe = wifi/discover, recover = USB.

# Connection-first init

Connection infrastructure (BLE, WiFi, USB-CDC) initializes before capability infrastructure (camera, perception, motors). When constrained resources force a tradeoff, connection wins. A robot whose BLE stays up with no camera is observable and actionable; the reverse is a brick.

ESP32 example: `WiFi.mode(WIFI_STA)` runs at the top of `setup()` so the WiFi driver pre-allocates its DMA buffers in fresh internal heap. Camera comes after; if it can't fit its 32 KB DMA buffer in what's left, it fails loudly via `camera_err`.

# Replay

Every Pip tool call is persisted to IndexedDB so a session can be re-run offline against a new model (comma.ai's replay-your-drive pattern, scoped to our tool surface). Image data URLs from `ask_human_via_phone` stay in the record so reconstruction is faithful.

Wire-up via `replay.wrapExecutor()` in `pip-tools.js`. Surface in `DEV.md`.
