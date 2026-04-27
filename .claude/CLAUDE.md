# Developer reference

`DEV.md` at the repo root is the canonical list of URL flags, `window.*` handles, IndexedDB stores, and common debug paths. Check it before grepping the codebase for "how do I enable X?"; keep it in sync when adding any new URL flag, console handle, or diagnostic surface.

# Project layout gotchas

- **`docs/` is a symlink to `public/`.** GitHub Pages serves from `docs/` on `main`, but the site content lives in `public/`. Do not put repo-level documentation under `docs/` or `public/` unless you want it published as part of the dashboard. Repo-level docs live at the root (e.g. `HARDWARE.md`) or inside a subsystem (e.g. `firmware/pi_robot/README.md`).

# Smoke testing

Two layers, each kept cheap:

- **`make smoke`** — pure-function tests via `node --test tests/*.test.js`. Anything in `public/format.js` (and any future pure helper) earns a row in `tests/format.test.js`. No DOM, no BLE, no Playwright. Runs in <1 s. Catches regressions in display logic, parsers, formatters, anything testable without hardware.
- **`SMOKE.md`** — manual checklist for the architectural promises (robot lifecycle, render patterns, capability behavior, Pip flow, recovery). When this list passes end-to-end, the project's stated value is intact. New behaviors that promise something to the user earn a row.

The split is deliberate: full automation (Playwright, hardware-in-the-loop) would cost more than the project earns from it today. Pure tests cover what's cheap; the manual checklist anchors what "working" means without the infra cost.

Pattern for new pure helpers: extract from app.js / capability runtime into `public/format.js`, import where used, add a test. The cost of extraction pays for itself in (a) test coverage and (b) preventing the same display logic from being implemented three slightly-different ways.

# Comment discipline

This is an AI-edited codebase. Every line of comment is context cost. The global CLAUDE.md rule ("default to writing no comments") applies with extra force here. Past drift has added module-preamble paragraphs and inline narration that collectively wasted real context window; a `brief` agent pass trimmed ~17 KB across the repo. Don't re-introduce it.

**Keep a comment when it carries:**
- **Schema / wire format** — JSON examples, opcode tables, config-file keys. The data shape isn't inferable from code.
- **WHY** — hidden constraints, workarounds, bug fixes we hit before, behavior that would surprise someone reading. Kernel quirks, API gotchas, protocol parity requirements.
- **Cross-file invariants** — "must match `firmware/pi_robot/pi_robot.py` exactly", "same protocol as OTA", "pins come from `pi-robot.conf`".
- **Gotcha notes** — Chrome flag requirements, PEP 668 externally-managed, CSI allocation after `stop()`, systemctl `reboot` vs `restart` semantics, rfkill on Trixie, `setBufferSizes` gone in arduino-esp32 3.x, `--experimental` + root for bless, drop-intermediate-values for sliders vs BLE write latency, etc.

**Cut a comment when it is:**
- A module-level preamble paragraph (5–15 lines at top) restating what filename/folder/imports already convey.
- A restatement of the next line of code.
- A section-divider banner (`// —————`, `// ===`, `// ──────`).
- A label above obvious code ("// Generic writer", "// Boot", "// Helpers").
- Procedural narration ("now we set up the listener", "first we read, then...").
- Tutorial-style explanation of self-evident function bodies.

**Heuristic:** if a comment explains why a line LOOKS wrong or surprising, keep it. If it only says what the code does, cut it.

**Commit comments + docstrings follow the same rule.** `working.md`, `direction.md`, and architecture docs are prose by design — those stay discursive. Source code is not.

# Dialog vs menu dismiss behavior

- **Menus + popovers** (`robot-menu`, `avatar-menu`, help popovers, the `assistant-panel`): dismiss on both outside-click and Escape. Users reach for "click away" to close a menu; that's the expected affordance. Pip's panel is a `<div popover>` for a reason — it follows this rule, not the dialog rule, so proactive surfacing over modals works without a re-modal regression.
- **Dialogs (all of them)**: close only via the explicit × button or Escape (native `<dialog>` default). Outside-click dismiss is NOT wired — same rule for quick-views and session dialogs alike, because the cost of accidentally nuking a session dialog (recovery terminal, SD prep) outweighs the tiny convenience win for reopening a quick-view. `wireDialogOutsideClick()` exists in `dom.js` but isn't used; keep it out unless there's a clear reason.

# Control-loop invariants

Three design rules for anything that couples an LLM / VLM to the robot's motion. Think of it as our "openpilot panda" discipline: safety is enforced below the intelligent layer, not inside it.

- **Safety below the planner.** Firmware-side limits (pulse duration cap, max LLM-driven speed, watchdog auto-stop) are the hard floor. Claude and Pip cannot bypass them — not even with a malformed or malicious tool call. Max LLM-issued motor speed is separately capped from max user-joystick speed; only the human can command "fast."
- **Pulse-bounded motion under LLM control.** LLM-issued motor commands always carry `duration_ms` and the firmware auto-stops at the end. Persistent speed ("set and hold") is reserved for user joystick control, where a human is in the decision loop at 20Hz+. Between Pip decisions the robot is at rest — not cruising blindly while Claude thinks for 3 seconds.
- **Confidence-based handoff is core policy, not a tool.** `ask_human_via_phone` isn't an escape hatch, it's the terminal rung of the decision cascade. The model should ask to be overridden rather than wait to be overridden. Any new planner-layer feature that doesn't have a "defer upward" path is incomplete. (For toy-scale autonomy, "defer upward" is allowed to fail open — the toy can stop and wait for the human; it doesn't have to escalate every uncertainty. The cascade rung still exists; we just don't gate every action on it.)
- **Pip reachability has a silent fallback.** `ask()` / `askWithTools()` retry via the local LFM model when the primary backend returns null AND `settings.pipLocalInstalled` is true (user opted in once; weights live in IndexedDB). A null Pip reply means BOTH the primary and the local retry returned null — not just the primary. Diagnose accordingly.

# Model discipline

Different model shapes are good at different jobs. Treat them as distinct primitives, not as interchangeable "AI". The project has been bitten by planner-layer attempts to paper over a capability gap with prompt-engineering — don't.

- **Fiducial pose (ArUco via `aruco.js`, working.md item G): sub-pixel pose of *tagged* objects.** ~10–20 ms in JS, deterministic. THE primitive for "where is the robot in this overhead frame," because the marker carries a known size + ID. Doesn't see anything that isn't tagged.
- **Closed-vocab detector (YOLO26n via `yolo.js`, working.md item H): fast bboxes for COCO classes + custom-trained labels.** ~10–30 ms on WebGPU. THE primitive for closed-loop reactive perception — fast enough to drive against. Limitation: only sees what it was trained for. (Replaces OWLv2; transition is in flight.)
- **VLM (LFM2.5-VL-450M via `perception.js`, exposed as `get_robot_scene` / `ask_robot_scene`): semantic + open-vocab spatial.** Answers "what's in the frame" via caption (~1.5 s) AND, since the April 2026 release, can output bboxes via structured-JSON prompting (RefCOCO-M 81.28). Slow enough to be planner-tier, not reactive-tier. Rule: a *single* directional motor pulse based on VLM text alone is fine for a toy; chaining without the deterministic primitive (ArUco or YOLO) re-asserting between pulses is not — that's where the loop drifts.
- **Open-vocab detector (OWLv2 via `grounding.js`): being retired** — superseded by YOLO26n (closed-vocab, fast) for reactive perception and LFM-VL bbox-prompting (open-vocab, slow) for ad-hoc semantic spatial queries. Don't add new dependencies on `grounding.js`; see working.md item H for the rotation plan.
- **Claude (planner): seconds-latency, multi-turn, tool-calling.** Strong at decomposing goals, weak at closed-loop visual servo (the 2–5s round-trip makes tight loops impossible). Can view images natively but shouldn't be relied on for pixel-accurate bbox coords. Belongs at the PLANNING layer; tight loops must live below.
- **Local LFM2.5 (via `local-llm.js`): fallback for offline / API-outage.** Reduced tool-calling reliability (512-token output ceiling, retries needed). Auto-engaged when primary returns null AND `settings.pipLocalInstalled` is true.

Generalizes: before proposing to "improve the VLM prompt" to get spatial answers, check whether the correct primitive already exists (it usually does) and is just disabled / unused. Adding a new prompt path that duplicates a disabled detector is debt.

# Transport discipline

Each transport has a job. Mixing them, or proposing a new one, should require naming what existing one fails — most "we need X protocol" requests are answered by an existing transport's verbs.

- **BLE (control plane).** Low latency, proximity-authenticated for free, lossy. THE control channel between dashboard and robot. Anything that sets motor speed, toggles an LED, or commits state goes here.
- **Typed ops (over BLE).** Structured verbs on a single characteristic — `get-log`, `get-config`, `restart-service`, `get-status`, `wifi-scan`, `wifi-join`. Each verb is a deliberate, reviewable decision. Don't add a real-shell transport; add a typed verb that does the specific thing.
- **WebRTC (phone ↔ desktop).** Authenticated by the pair ceremony (Ed25519 pubkey + signed pair-request). Carries chat, camera frames, ask-human responses, robot-command relays. Trusted peer; phone can request things the desktop will gate.
- **Wifi-discover (presence plane).** Pi + ESP32 → signal.neevs.io REST `/discover` ads (Pi: optionally signed Ed25519 via `peer-key.json`; ESP32: unsigned, TLS-only). Answers "is this robot online" — passive, not control. TTL-bounded so disappearance is automatic. Future-foundation for any signed wifi exchange that earns its keep.
- **USB-CDC (recovery plane).** Last-resort serial console, runs as its own systemd unit so a `pi-robot.service` crash doesn't take serial recovery with it. Bounded by physical access — that's the safety story.

The pattern: **control = BLE, observe = wifi/discover, recover = USB.** Never add a new transport without a concrete use case the existing three can't cover.

# Connection-first init

Same shape as safety-below-planner, applied to boot order: **connection infrastructure (BLE, WiFi, USB-CDC) initializes BEFORE capability infrastructure (camera, perception, motors, sensors).** When constrained resources (DMA-capable heap on ESP32, file handles on Pi, etc.) force a tradeoff, connection wins.

Reasoning: recovery and diagnostics require connectivity. A robot whose BLE stays up with no camera is observable + actionable; a robot whose camera works but BLE doesn't is a brick. Capabilities can degrade gracefully (no camera = `camera_err` in fw-info, dashboard hides the cap); connection failures cascade to total opacity.

Concrete examples:
- ESP32: `WiFi.mode(WIFI_STA)` runs at the top of `setup()` so the WiFi driver pre-allocates its 4 RX DMA buffers in fresh internal heap. Camera + BLE come after. If camera can't fit its 32 KB DMA buffer in what's left, it fails loudly via `camera_err`; the user can drop framesize. WiFi reliably works either way.
- Pi: `pi-robot-heartbeat.service` (always-on BLE) starts independent of `pi-robot.service` so the firmware-down state stays observable.
- Recovery plane: USB-CDC-ACM gadget runs as its own systemd unit so a `pi-robot.service` crash doesn't take serial recovery with it.

The pattern generalizes: any new on-device infrastructure should ask "if this resource is constrained, what would I rather lose first — connection or this capability?" The answer is almost always "this capability."

# Replay

Every Pip tool call is persisted to IndexedDB so a session can be re-run offline against a new model and decisions compared — comma.ai's replay-your-drive pattern, scoped to our tool surface. Image data URLs from `ask_human_via_phone` stay in the record so "what did Pip see when it made that call?" reconstructs accurately.

Wire-up via `replay.wrapExecutor()` in `pip-tools.js`. Surface (record shape, `window.*` handles) is in `DEV.md`.

# Subsystem map

`public/` is still flat on purpose — file count is manageable and naming prefixes carry the subsystem boundary. Use this map to know where new files belong, and promote a subsystem to its own folder (following `capabilities/`'s pattern) once it passes ~5 files whose internals shouldn't leak outside.

- **Pair layer** — `pairing.js`, `phones.js`, `phone.js`, `phone.html`. Desktop ↔ phone WebRTC link; anything protocol-shaped between the two belongs here.
- **Perception** — `perception.js`. In-browser VLM, camera-frame capture, scene prompt.
- **Pip / assistant** — `assistant.js`, `claude.js`, `pip-tools.js`, `replay.js`. Claude integration, tool schemas, tool executor, replay logging. Anything Pip reasons with belongs here.
- **Robot ops** — `ble.js`, `ops-response.js`, `capabilities/`. BLE protocol, ops channel, per-capability cards + runtime handlers.
- **Robot lifecycle** — `prepare.js`, `recovery.js`, `pinout.js`. SD card prep, USB serial recovery, pinout config editor. Covers "getting a robot running or repaired."
- **User code** — `scripts.js`. Browser-resident IDE for user-authored robot code. The `robot` API mirrors the BLE capability surface; user scripts are "another planner" under the same control-loop invariants as Pip. Persisted in localStorage; never deployed to the Pi. See `USER-CODE.md`.
- **App shell** — `app.js`, `dom.js`, `state.js`, `settings.js`, `log.js`, `auth.js`, `passwords.js`, `index.html`, `styles.css`, `icons.svg`. Dashboard chrome and cross-cutting utilities.

Likely next promotion candidate: **nav/** once `probe.js`, `navigate.js`, and friends land on top of the action-observation primitive.

# Scope discipline

Name what the system WON'T do, as loudly as what it will:

- Toy-scale autonomy is fair game; production-scale autonomy is not. Tabletop / desk / driveway, walking speed, one robot, AI-permitted-to-drive-itself — fine, and item H in `working.md` is converging on it. What we don't try to make: Waymo-shaped guarantees (cert, redundancy, formal proof, "the robot will not hit things" promises). The pulse-bounded-motion + watchdog floor stays cheap discipline regardless of scale — it's not the safety story for production, it's the "while debugging" floor that prevents a brief LLM hallucination from running the toy off the table.
- Not real-time at the planner layer. The LLM planner stays at seconds-cadence; tight reactive loops live below it (YOLO26n + ArUco both clear 10 Hz). "Real-time" used to mean "no closed-loop control at all" — that's no longer true now that fast deterministic perception primitives exist. The two-tier discipline is: planner reasons in seconds, reactive layer executes in tens of milliseconds, planner doesn't try to be the reactive layer.
- Spatial awareness is fiducial-bounded. ArUco fiducial + overhead camera gives ground-truth 2D pose; YOLO26n gives image-frame bboxes. Monocular VLM text alone is still confabulation territory — left/right/near/far from a caption is unreliable even on LFM2.5-VL-450M. Build new spatial behaviors on the fast deterministic primitives, not on prompt-engineering the VLM.
- Not a code-deploy target. User code runs in the browser, not on the Pi. The dashboard is where the brain lives (Pip already runs here); per-user logic lives where the brain lives. No GitHub Actions integration that pushes per-user code, no central sync server, no `scp`-from-the-dashboard. See `USER-CODE.md` for the full reasoning. The exception (canonical project firmware) is OTA'd via `public/firmware/`, owned by CI, and trust-rooted in the dashboard pairing.
- Not a remote-shell host over BLE/WiFi. The dashboard's USB-C recovery xterm is the only shell surface, bounded by physical access. BLE/WiFi debug needs go through the typed ops channel (`get-log`, `get-config`, `restart-service`, …) — each verb is a deliberate, reviewable decision. Don't add a real-shell transport without a concrete use case that typed ops can't cover. See `firmware/pi_robot/SHELL.md`.
- Not a content pipeline. Pip's proactive messages are observations from project state (replay records, robot telemetry, user scripts, direction docs) — not a scheduled feed of external robotics content. The `pulse`-style GH Action scraper is the right template *when* external content earns its way in, but it's a secondary input to a browser-side filter, never the primary signal. Build the state-aware layer first; skipping to the feed is building a pipeline before you know what you're filtering for. See `OBSERVATIONS.md`.
- Not a robot-fleet manager. One operator, one robot at a time, mostly. The dashboard renders multi-robot lists for completeness, but workflow / Pip / scripts assume a single-target focus. "Orchestrate two robots simultaneously" is out of scope; two operators on two dashboards is the supported shape.
- Not a vision-first system. Text + bounding-box is the primary representation Pip reasons over (cheap, structured, debuggable). Direct image inspection (`view_robot_frame`) is opt-in and last-resort — frames leaving the device is a privacy + cost change the user owns. New features should reach for VLM/detector/text first; only escalate to vision when the cheaper primitives genuinely can't answer.
- Not a primary-online product. Dashboard works on cafe wifi, after API outages, with no network at all (offline shell + local LFM fallback once installed). Cloud is augmentation. Features that *require* the network without an offline-degraded path don't belong here.

When scope creeps — "can Pip just drive the robot to the kitchen?" — match it against these. If the request stays inside toy-scale + pulse-bounded + planner-stays-above-reactive, it's fair. If it requires production-grade safety claims or breaking the planner/reactive split, surface that and don't quietly extend.
