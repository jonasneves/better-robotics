# User code

The Scripts panel is the IDE: write JavaScript that drives the robot, hit Run, iterate. localStorage is the file system; BLE is the runtime link. User code and Pip are co-equal authorable surfaces — both sit inside the IDE, both bounded by the same firmware safety floor.

## The `robot` API

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

// Tool-using LLM in the loop — same bridge Pip uses (claude.js).
// Costs the user's API quota per call. Throws on bridge failure.
const move = await pip.ask("Scene: chair ahead. Reply: forward, left, right, stop.", {
  system: "Reply with EXACTLY ONE token.",
  maxTokens: 8,
});
```

In scope inside a script: `robot`, `robots`, `phones`, `pip`, `sleep(ms)`, `log(...)`, `speak(text)`. The Scripts dialog ships templates demonstrating the shapes; pick one from the dropdown to load it.

The `pip` namespace is deliberately thin: today just `pip.ask(prompt, opts?)`, returning the LLM's text response. It's the seam between "user wrote the orchestration" and "the LLM decided this step" — same shape Pip uses internally, exposed to user scripts so the two surfaces aren't siloed.

## What you get for free

- **Zero deployment.** Edit, click Run. No flash, no OTA wait, no SSH.
- **Zero new infrastructure.** No CI, no server, no signing, no sync.
- **Zero new trust boundary.** Dashboard is already paired to the robot via TOFU. Browser code is already trusted to the same level.
- **Multi-robot is a `forEach`.** No per-robot deploy step.
- **Iteration is instant.** Same edit-reload loop as the rest of the dashboard.

## Safety floor

The firmware enforces motor watchdog + pulse magnitude/duration caps regardless of who issued the writes. User code, Pip, joypad — all see the same limits.

> Safety below the planner. Firmware-side limits are the hard floor. Pip and user code cannot bypass them, not even with a malformed or malicious tool call. (.claude/CLAUDE.md → Control-loop architecture)

`robot.move()` calls `pulseMotors`, carrying the same ±40 magnitude / 50–2000 ms duration caps the LLM is bound by. Dashboard-side clamps are advisory; firmware enforcement is binding.

## Deployment model

User code lives in the browser, not on the robot. No upload-to-Pi, no GH Actions push, no `scp`-from-the-dashboard. Pip's architecture says where the brain lives — user scripts share the same shape with a human writing the orchestration instead of an LLM generating it.

If a robot ever needs to run useful behavior with the dashboard disconnected for minutes+ (outside the wedge today — see `.claude/CLAUDE.md → Anti-drift guards`), the path forward is the existing OTA pipeline: drop user code into a `/home/robot/user/` slot via BLE OTA, have `pi_robot.py` import it via a typed plugin API. No new sync server needed.
