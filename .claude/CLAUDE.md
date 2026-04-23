# Developer reference

`DEV.md` at the repo root is the canonical list of URL flags, `window.*` handles, IndexedDB stores, and common debug paths. Check it before grepping the codebase for "how do I enable X?"; keep it in sync when adding any new URL flag, console handle, or diagnostic surface.

# Project layout gotchas

- **`docs/` is a symlink to `public/`.** GitHub Pages serves from `docs/` on `main`, but the site content lives in `public/`. Do not put repo-level documentation under `docs/` or `public/` unless you want it published as part of the dashboard. Repo-level docs live at the root (e.g. `HARDWARE.md`) or inside a subsystem (e.g. `firmware/pi_robot/README.md`).

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

- **Menus + popovers** (`robot-menu`, `avatar-menu`, help popovers): dismiss on both outside-click and Escape. Users reach for "click away" to close a menu; that's the expected affordance.
- **Dialogs (all of them)**: close only via the explicit × button or Escape (native `<dialog>` default). Outside-click dismiss is NOT wired — same rule for quick-views and session dialogs alike, because the cost of accidentally nuking a session dialog (recovery terminal, SD prep) outweighs the tiny convenience win for reopening a quick-view. `wireDialogOutsideClick()` exists in `dom.js` but isn't used; keep it out unless there's a clear reason.

# Control-loop invariants

Three design rules for anything that couples an LLM / VLM to the robot's motion. Think of it as our "openpilot panda" discipline: safety is enforced below the intelligent layer, not inside it.

- **Safety below the planner.** Firmware-side limits (pulse duration cap, max LLM-driven speed, watchdog auto-stop) are the hard floor. Claude and Pip cannot bypass them — not even with a malformed or malicious tool call. Max LLM-issued motor speed is separately capped from max user-joystick speed; only the human can command "fast."
- **Pulse-bounded motion under LLM control.** LLM-issued motor commands always carry `duration_ms` and the firmware auto-stops at the end. Persistent speed ("set and hold") is reserved for user joystick control, where a human is in the decision loop at 20Hz+. Between Pip decisions the robot is at rest — not cruising blindly while Claude thinks for 3 seconds.
- **Confidence-based handoff is core policy, not a tool.** `ask_human_via_phone` isn't an escape hatch, it's the terminal rung of the decision cascade. The model should ask to be overridden rather than wait to be overridden. Any new planner-layer feature that doesn't have a "defer upward" path is incomplete.

# Connection-first init

Same shape as safety-below-planner, applied to boot order: **connection infrastructure (BLE, WiFi, USB-CDC) initializes BEFORE capability infrastructure (camera, perception, motors, sensors).** When constrained resources (DMA-capable heap on ESP32, file handles on Pi, etc.) force a tradeoff, connection wins.

Reasoning: recovery and diagnostics require connectivity. A robot whose BLE stays up with no camera is observable + actionable; a robot whose camera works but BLE doesn't is a brick. Capabilities can degrade gracefully (no camera = `camera_err` in fw-info, dashboard hides the cap); connection failures cascade to total opacity.

Concrete examples:
- ESP32: `WiFi.mode(WIFI_STA)` runs at the top of `setup()` so the WiFi driver pre-allocates its 4 RX DMA buffers in fresh internal heap. Camera + BLE come after. If camera can't fit its 32 KB DMA buffer in what's left, it fails loudly via `camera_err`; the user can drop framesize. WiFi reliably works either way.
- Pi: `pi-robot-heartbeat.service` (always-on BLE) starts independent of `pi-robot.service` so the firmware-down state stays observable.
- Recovery plane: USB-CDC-ACM gadget runs as its own systemd unit so a `pi-robot.service` crash doesn't take serial recovery with it.

The pattern generalizes: any new on-device infrastructure should ask "if this resource is constrained, what would I rather lose first — connection or this capability?" The answer is almost always "this capability."

# Replay

Every Pip tool call is persisted to IndexedDB via `replay.wrapExecutor()` in `pip-tools.js`. Records carry `{sessionId, name, input, output, error, startedAt, endedAt, durationMs}`. Image data URLs (from `ask_human_via_phone`'s robot-camera attach) stay in the record — the point is to reconstruct "what did Pip see when it made that call?"

Dev handles exposed on `window`: `replayDownload()` → saves full JSON of the store; `replayAll()` → in-memory array; `replayClear()` → wipes; `replaySession` → current session id. Callable from DevTools console or the `?debug` overlay.

Use case: when upgrading Claude, we can re-run a past session's inputs against the new model offline and compare decisions. No hardware, no user, no risk. comma.ai's replay-your-drive pattern, scoped to our tool surface.

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

- Not autonomous. The human is always one `ask_human` away by design.
- Not real-time. Decision loop is seconds, not milliseconds. Reactive control is impossible at this latency; pulse-bounded motion is how we live with that.
- Not spatially aware. Monocular camera + VLM text — no depth, no SLAM, no metric maps. Navigation is semantic (landmarks, "further along the wall"), not geometric.
- Not a Waymo / Roomba. Don't sell safety guarantees we can't make. Don't promise "the robot will not hit things" — promise "the robot will stop and ask when uncertain, and motion is pulse-bounded to cap any blind-motion blast radius."
- Not a code-deploy target. User code runs in the browser, not on the Pi. The dashboard is where the brain lives (Pip already runs here); per-user logic lives where the brain lives. No GitHub Actions integration that pushes per-user code, no central sync server, no `scp`-from-the-dashboard. See `USER-CODE.md` for the full reasoning. The exception (canonical project firmware) is OTA'd via `public/firmware/`, owned by CI, and trust-rooted in the dashboard pairing.
- Not a remote-shell host over BLE/WiFi. The dashboard's USB-C recovery xterm is the only shell surface, bounded by physical access. BLE/WiFi debug needs go through the typed ops channel (`get-log`, `get-config`, `restart-service`, …) — each verb is a deliberate, reviewable decision. Don't add a real-shell transport without a concrete use case that typed ops can't cover. See `firmware/pi_robot/SHELL.md`.
- Not a content pipeline. Pip's proactive messages are observations from project state (replay records, robot telemetry, user scripts, direction docs) — not a scheduled feed of external robotics content. The `pulse`-style GH Action scraper is the right template *when* external content earns its way in, but it's a secondary input to a browser-side filter, never the primary signal. Build the state-aware layer first; skipping to the feed is building a pipeline before you know what you're filtering for. See `OBSERVATIONS.md`.

When scope creeps — "can Pip just drive the robot to the kitchen?" — match it against these. If the request requires something we've named we don't do, the honest answer is to surface that, not to quietly extend.
