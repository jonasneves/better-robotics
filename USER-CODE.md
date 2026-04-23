# User code lives in the browser, not on the robot

A structural decision, captured here so it doesn't get re-litigated.

## What we don't do

We don't ship a way to upload arbitrary user code to a Pi or ESP32. No
GitHub Actions integration that pushes per-user code to robots. No central
sync server. No `scp`-from-the-dashboard. No "drop your `.py` into this
folder and it'll run."

## What we do instead

User code runs in the browser, alongside the dashboard, with access to a
`robot` API that calls the robot's typed BLE capabilities. The Scripts
panel is the IDE; localStorage is the file system; BLE is the runtime
link.

```js
// Multi-robot is a forEach.
for (const r of robots) {
  await r.led(true);
  await r.move({ left: 30, right: 30, durationMs: 400 });
  await sleep(500);
  await r.led(false);
}

// Typed ops with responses — same channel Pip uses.
const cfg = await robot.op("get-config");
const log = await robot.op("get-log", { lines: 50, unit: "pi-robot" });

// Fire-and-forget for ops where the robot drops BLE mid-call.
await robot.op("reboot", {}, { await: false });

// Vision in the loop — same in-browser VLM Pip uses (perception.js).
// Camera must be streaming on this robot first.
const scene = await robot.scene("Is the path ahead clear?");

// Phone in the loop — paired phone via the WebRTC pair layer.
const dir = await phones[0].ask({
  question: "Which way?",
  options: ["Forward", "Back", "Stop"],
});
```

In scope inside a script: `robot`, `robots`, `phones`, `sleep(ms)`, `log(...)`,
`speak(text)`. The Scripts dialog ships several templates that demonstrate the
shapes — pick one from the dropdown to load it into the editor.

## Why this is the right shape

The architecture already says where the brain lives. Pip — the LLM
orchestrator — runs in the browser and drives the robot via typed BLE
calls. User code is the same shape with a human writing the orchestration
instead of a model generating it. Putting one of them in the browser and
the other on the Pi would be inconsistent for no reason.

What you get for free:

- **Zero deployment.** Edit, click Run. No flash, no OTA wait, no SSH.
- **Zero new infrastructure.** No CI, no server, no signing, no sync. The
  three things the project already refuses to add (cf. README:
  "no servers, no broker, no cloud in the critical path") stay refused.
- **Zero new trust boundary.** The dashboard is already paired to the
  robot via TOFU. Code in the browser is already trusted to the same
  level as the dashboard itself.
- **Multi-robot is a `forEach`.** No per-robot deploy step.
- **Iteration is instant.** Same edit-reload loop as the rest of the
  dashboard.

## The safety argument

Standard reflex for "user code on device": code signing, sandboxing,
restricted shell, signed OTA, review pipeline. Each of those costs real
engineering. Each of them is needed because *the device is now executing
foreign code* — the threat surface is "everything you can run."

Browser-side user code doesn't have that surface. The robot only ever
sees typed BLE writes, and the firmware's safety floor (motor watchdog,
pulse magnitude/duration caps) applies to those writes regardless of
who issued them.

This is the same panda doctrine that governs Pip:
> Safety below the planner. Firmware-side limits are the hard floor.
> Claude and Pip cannot bypass them — not even with a malformed or
> malicious tool call. (.claude/CLAUDE.md → Control-loop invariants)

User code is just another planner. The hard floor doesn't care which
planner is driving. `robot.move()` calls `pulseMotors`, which carries the
same ±40 magnitude / 50–2000 ms duration caps the LLM is bound by, and
the firmware enforces those caps regardless of dashboard-side clamps.

What we DON'T need (and don't build):

- **Code signing.** The dashboard's TOFU pairing is the trust. Browser
  code is already inside that trust boundary.
- **Sandbox.** The browser's same-origin model is the sandbox. The
  firmware's capability boundary is the *real* sandbox — it's what stops
  a runaway script from spinning the wheels at full power for 10 minutes.
- **Review pipeline.** It's the user's browser tab.
- **GH Actions integration.** Right pattern for canonical firmware (one
  source of truth, project-owned). Wrong pattern for per-user code (N
  users, N trust contexts, N pipelines, all to solve a deploy problem
  that doesn't need to exist).
- **Central sync server.** Adds a backend the project explicitly refuses.

## When would Pi-side user code be the right answer?

Only if a robot needs to run useful behavior with the dashboard
disconnected for an extended span (minutes+). That violates the project's
stated `Not autonomous` scope (`.claude/CLAUDE.md → Scope discipline`),
so it's not a current need.

If it ever becomes one, the right path is to **reuse the existing OTA
pipeline** (drop user code into a `/home/robot/user/` slot via BLE OTA;
have `pi_robot.py` import it via a typed plugin API) rather than invent
GH Actions integration or a sync server. That's the version of this
problem worth solving when a real use case demands it.

Until then, this doc is the answer.
