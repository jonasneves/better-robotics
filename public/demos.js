// Scripted demo routines — short, reliable, demo-friendly choreographies
// that always look the same. The "always-works safety net" complement
// to LLM-driven exploration: when you have 30 seconds in front of
// someone, you reach for these.
//
// Each demo's `run(ctx)` is async and orchestrates calls to ctx.exec()
// (the executor with pill rendering) and ctx.sleep(). Demos can issue
// `move_motor`, `speak`, `start_robot_camera`, `start_robot_watcher`,
// `get_robot_detections`, `view_robot_frame` — same primitives the LLM
// uses. So a demo step renders in the chat the same way an LLM-issued
// tool call does.
//
// Design philosophy (revised after first-pass screenshots showed tiny,
// twitchy motion):
//   - Use the full 2000ms pulse cap. Per-pulse gaps are noticeable
//     only on chained-forward; for arcs / spins, the slight pause
//     reads as "intentional pose-hold," not jitter.
//   - Vocal punctuation at section boundaries. Spot's viral dances
//     all have music sync; we substitute TTS phrases ("ready?", "ta-
//     da!", "scanning") which both narrate intent AND mask drift.
//   - Multi-section structure (intro → motif → bridge → finale) per
//     Petoi Bittle / Sphero RVR Trick Library convention. Even short
//     demos get a beginning, middle, end.
//   - LLM-grade demos (selfie, follow) use the camera + detections.
//     These are the ones competitors can't fake with timed pulses
//     because the planner-loop is the control system.

const SPEED = 40;        // saturate; firmware caps to ±40 anyway
const MAX = 2000;        // firmware duration cap per pulse

// pulse-and-settle: move_motor is bounded; we wait the pulse duration
// plus a small settle so we don't queue pulses on top of each other
// (firmware would cancel-and-replace and motion would jerk).
async function pulse(ctx, l, r, ms) {
  await ctx.exec("move_motor", { id: ctx.id, l, r, duration_ms: ms });
  await ctx.sleep(ms + 30);
}

// chain forward — N consecutive max-duration drives. Each ~2s pulse
// has a brief firmware-stop between, but the visual is "sustained drive
// across the floor" rather than a single brief lunge. Forward only
// (firmware clips when dist_cm < ~15, so it self-protects).
async function sustainedDrive(ctx, l, r, count = 2) {
  for (let i = 0; i < count; i++) await pulse(ctx, l, r, MAX);
}

// 1 — Figure-8. Two wide arcs in opposite curves, ~10s total. Bigger
//     diameter than the v1 (which was a tiny tight figure). Speaks at
//     start so the viewer knows what they're about to see.
async function figure8(ctx) {
  await ctx.exec("speak", { text: "Figure eight." });
  await ctx.sleep(500);
  // Right-arc forward (left wheel faster) — traces left lobe of the 8
  for (let i = 0; i < 3; i++) await pulse(ctx, SPEED, SPEED * 0.35, MAX);
  // Left-arc forward — traces right lobe
  for (let i = 0; i < 3; i++) await pulse(ctx, SPEED * 0.35, SPEED, MAX);
}

// 2 — Zigzag sweep. Wide alternating arcs forward — like a search
//     pattern. ~10s total. Vocal mid-sweep so the demo feels narrated.
async function zigzag(ctx) {
  await ctx.exec("speak", { text: "Scanning the area." });
  await ctx.sleep(400);
  for (let i = 0; i < 3; i++) {
    await pulse(ctx, SPEED, SPEED * 0.3, MAX);
    await pulse(ctx, SPEED * 0.3, SPEED, MAX);
  }
  await ctx.exec("speak", { text: "Sweep complete." });
}

// 3 — Dance. Multi-section: intro → spin sequence → shimmy → charge →
//     finale. ~15s total. Each section visually distinct so it reads as
//     "choreography" not "scripted twitch."
async function dance(ctx) {
  await ctx.exec("speak", { text: "Watch this." });
  await ctx.sleep(700);
  // Section 1 — slow full spins, one each way
  await pulse(ctx, -SPEED,  SPEED, MAX);
  await pulse(ctx,  SPEED, -SPEED, MAX);
  // Section 2 — fast shimmy (tail-wag rhythm)
  for (let i = 0; i < 4; i++) {
    await pulse(ctx,  SPEED, -SPEED, 200);
    await pulse(ctx, -SPEED,  SPEED, 200);
  }
  // Section 3 — charge forward + retreat
  await ctx.exec("speak", { text: "Charge!" });
  await pulse(ctx,  SPEED,  SPEED, MAX);
  await pulse(ctx, -SPEED, -SPEED, MAX);
  // Section 4 — finale full spin + reveal
  await pulse(ctx, -SPEED,  SPEED, MAX);
  await ctx.exec("speak", { text: "Ta-da!" });
}

// 4 — Patrol. Sustained drive segments + big spin-and-look between
//     them. Reads as "alive and checking" because the look-around is
//     full-rotation, not a quick tic. ~18s total.
async function patrol(ctx) {
  await ctx.exec("speak", { text: "Patrolling." });
  for (let i = 0; i < 2; i++) {
    await sustainedDrive(ctx, SPEED, SPEED, 2);  // ~4s straight
    await ctx.sleep(300);
    await pulse(ctx, -SPEED,  SPEED, MAX);       // big spin one way
    await ctx.sleep(200);
    await pulse(ctx,  SPEED, -SPEED, MAX);       // big spin back
    await ctx.sleep(200);
  }
  await ctx.exec("speak", { text: "Patrol complete." });
}

// 5 — React. Theatrical: open camera → slow scan-spin so the user can
//     SEE the robot is paying attention → arm the watcher. The
//     fire-once watcher then halts and speaks when a person appears,
//     even if the user closes the dashboard.
async function react(ctx) {
  await ctx.exec("start_robot_camera", { id: ctx.id });
  await ctx.exec("speak", { text: "Watching for visitors." });
  // Full 360 scan so the viewer sees the robot looking around
  await pulse(ctx, -SPEED, SPEED, MAX);
  await pulse(ctx, -SPEED, SPEED, MAX);
  await ctx.exec("start_robot_watcher", {
    id: ctx.id,
    classes: ["person"],
    action: "halt_and_speak",
    speak_text: "Hello!",
  });
}

// 6 — Follow. Closed-loop detection-driven approach. Longer drive
//     pulses so motion is fluid rather than choppy. Aborts cleanly via
//     ctx.shouldAbort() (Stop button or "stop" voice command).
async function follow(ctx, target = "person") {
  await ctx.exec("start_robot_camera", { id: ctx.id });
  await ctx.exec("speak", { text: `Following ${target}.` });
  const STEPS = 12;
  for (let i = 0; i < STEPS; i++) {
    if (ctx.shouldAbort?.()) return;
    const r = await ctx.exec("get_robot_detections", { id: ctx.id, queries: [target] });
    const hits = r?.detections || r?.results || (Array.isArray(r) ? r : []);
    const det = hits[0];
    if (!det) {
      await pulse(ctx, -SPEED, SPEED, 400);  // scan-spin to re-acquire
      continue;
    }
    const cx = det.bbox?.cx ?? 0.5;
    if      (cx < 0.4) await pulse(ctx, -SPEED,  SPEED, 300);  // turn left
    else if (cx > 0.6) await pulse(ctx,  SPEED, -SPEED, 300);  // turn right
    else               await pulse(ctx,  SPEED,  SPEED, MAX);  // sustained drive toward
  }
}

// 7 — Introduce. Self-introduction routine for first-time viewers.
//     Slow 360 spin while narrating what's on the platform. Great
//     opener; sets context for everything else. ~12s.
async function introduce(ctx) {
  await ctx.exec("speak", { text: "Hi there. I'm a small wheeled robot." });
  await pulse(ctx, -SPEED, SPEED, MAX);
  await ctx.exec("speak", { text: "I have two motors, a camera, and an ultrasonic sensor." });
  await pulse(ctx, -SPEED, SPEED, MAX);
  await ctx.exec("speak", { text: "I can drive, detect objects, react, and follow you. What should we try?" });
}

// 8 — Wiggle. Quick "tail-wag" emote — Cozmo-grade personality. 3
//     seconds of fast alternating mini-spins. Looks happy. Good
//     standalone reaction or filler between bigger demos.
async function wiggle(ctx) {
  for (let i = 0; i < 6; i++) {
    await pulse(ctx,  SPEED, -SPEED, 180);
    await pulse(ctx, -SPEED,  SPEED, 180);
  }
}

// 9 — Selfie. Take a frame, run closed-vocab COCO detection against
//     likely scene anchors, narrate what's there. This is the demo
//     competitors can't fake — the platform is reasoning about what
//     the camera actually saw. COCO-only labels here (open-vocab is
//     disabled); the 5-query cap matches the tool schema.
async function selfie(ctx) {
  await ctx.exec("start_robot_camera", { id: ctx.id });
  await ctx.exec("speak", { text: "Let me take a look around." });
  await ctx.sleep(800);
  const probes = ["person", "laptop", "cup", "cell phone", "chair"];
  const r = await ctx.exec("get_robot_detections", { id: ctx.id, queries: probes });
  const hits = (r?.detections || r?.results || (Array.isArray(r) ? r : []))
    .filter(d => d?.label && (d.score ?? 1) > 0.3);
  if (hits.length === 0) {
    await ctx.exec("speak", { text: "I can't quite make out the room. Bring something closer?" });
    return;
  }
  const labels = [...new Set(hits.map(d => d.label))].slice(0, 4);
  const list = labels.length === 1 ? `a ${labels[0]}` : `${labels.slice(0, -1).map(l => `a ${l}`).join(", ")}, and a ${labels[labels.length - 1]}`;
  await ctx.exec("speak", { text: `I see ${list}.` });
  await ctx.sleep(400);
  await pulse(ctx, -SPEED, SPEED, 600);  // small "nod" to acknowledge
  await ctx.exec("speak", { text: "Nice meeting you." });
}

// 11 — Stopsign patrol. Long open-loop wavy traverse + 180° turn,
//      repeated until the COCO watcher catches a stop sign. Showcases
//      "long-running motion interrupted by a reflex" — the canonical
//      reactive-robotics shape (Spot's "walk until you see X", DJI's
//      ActiveTrack with a stop condition).
//
//      The watcher's halt action is the firmware-level safety floor:
//      the robot stops the *moment* it sees the sign, regardless of
//      where we are in the loop. The demo also listens to the same
//      fire event via ctx.onWatcherFire so it can break out of its
//      sweep and narrate the catch.
async function stopsignPatrol(ctx) {
  // Intentionally do NOT announce what we're watching for — the demo's
  // wow moment is the unexpected halt when the watcher catches the sign.
  // Spoiling it up front ("looking for a stop sign") kills the reveal.
  await ctx.exec("speak", { text: "Patrol mode." });
  await ctx.exec("start_robot_camera", { id: ctx.id });
  await ctx.exec("start_robot_watcher", {
    id: ctx.id,
    classes: ["stop sign"],
    action: "halt",
  });

  let caught = false;
  const unsub = ctx.onWatcherFire?.((entry, det) => {
    if (entry?.id === ctx.id && det?.label === "stop sign") caught = true;
  });
  const shouldStop = () => caught || ctx.shouldAbort?.();

  // Wavy forward — alternating slight-right and slight-left arcs feels
  // organic, like a vehicle gently changing lanes. Each segment is a
  // max-duration pulse so the sweep covers serious ground per loop.
  // Six segments = ~12s of forward motion = ~3-4m at 35 cm/s.
  const wavyForward = async (segments = 6) => {
    for (let i = 0; i < segments; i++) {
      if (shouldStop()) return;
      const arc = i % 2 === 0
        ? [SPEED,         SPEED * 0.65]
        : [SPEED * 0.65,  SPEED       ];
      await pulse(ctx, arc[0], arc[1], MAX);
    }
  };

  // 180° spin in place. Two max-duration spin pulses are roughly a
  // half rotation at speed 40; tune the count if the robot under-turns.
  const turnAround = async () => {
    for (let i = 0; i < 2; i++) {
      if (shouldStop()) return;
      await pulse(ctx, -SPEED, SPEED, MAX);
    }
  };

  try {
    let lap = 0;
    while (!shouldStop()) {
      lap++;
      await wavyForward(6);
      if (shouldStop()) break;
      await ctx.exec("speak", { text: `Lap ${lap}, turning around.` });
      await turnAround();
    }
  } finally {
    unsub?.();
  }

  if (caught) {
    // Halt is firmware-level; this is just the spoken announcement.
    // The watcher stays armed so it'll keep guarding after the demo.
    await ctx.exec("speak", { text: "Stop sign detected. Patrol halted." });
  } else if (ctx.shouldAbort?.()) {
    await ctx.exec("speak", { text: "Patrol stopped." });
  }
}

// 10 — Show-off. Greatest-hits reel chaining intro + figure8 + wiggle +
//      dance. ~45s. Use this as the "full pitch" — every capability,
//      back to back, with vocal narration tying them together.
async function showOff(ctx) {
  await ctx.exec("speak", { text: "Demo reel, here we go." });
  await ctx.sleep(600);
  await introduce(ctx);
  await ctx.sleep(400);
  await ctx.exec("speak", { text: "Figure eight." });
  await figure8(ctx);
  await ctx.sleep(400);
  await ctx.exec("speak", { text: "Happy wiggle." });
  await wiggle(ctx);
  await ctx.sleep(400);
  await dance(ctx);
  await ctx.exec("speak", { text: "End of reel. Thanks for watching." });
}

const DEMOS = {
  figure8:   { run: figure8,   label: "figure-8"   },
  zigzag:    { run: zigzag,    label: "zigzag"     },
  dance:     { run: dance,     label: "dance"      },
  patrol:    { run: patrol,    label: "patrol"     },
  react:     { run: react,     label: "react"      },
  follow:    { run: follow,    label: "follow"     },
  introduce: { run: introduce, label: "introduce"  },
  wiggle:    { run: wiggle,    label: "wiggle"     },
  selfie:    { run: selfie,    label: "selfie"     },
  stopsign:  { run: stopsignPatrol, label: "stop-sign-patrol" },
  showoff:   { run: showOff,   label: "show-off"   },
};

export const DEMO_NAMES = Object.keys(DEMOS);

// Match `demo <name>` or `/demo <name>`. Aliases cover the variations
// Web Speech produces — "figure eight" / "figure 8", "zig zag" /
// "zigzag", "show off" / "showoff", etc. Dictated demo invocations
// should "just work" without the user having to spell things exactly.
// Order matters: more-specific aliases come first so they win against
// shorter ones (e.g. `stopsign` before `patrol`, since "stop sign
// patrol" should map to the stopsign demo, not vanilla patrol).
const ALIASES = {
  figure8:   /(?:figure[\s-]*(?:eight|8))/i,
  zigzag:    /(?:zig[\s-]*zag)/i,
  stopsign:  /(?:stop[\s-]*sign)/i,
  dance:     /dance/i,
  patrol:    /patrol/i,
  react:     /react/i,
  follow:    /follow/i,
  introduce: /(?:introduce|introduction|intro)/i,
  wiggle:    /(?:wiggle|wag)/i,
  selfie:    /(?:selfie|look\s+around|describe\s+room)/i,
  showoff:   /(?:show[\s-]*off|reel|highlights?)/i,
};
const RX_PREFIX = /^\/?demo\s+(.+)$/i;

export function tryMatchDemo(text) {
  const m = RX_PREFIX.exec((text || "").trim());
  if (!m) return null;
  const tail = m[1];
  for (const [name, rx] of Object.entries(ALIASES)) {
    if (rx.test(tail)) {
      // Optional trailing word for follow's target ("demo follow cup").
      const argMatch = name === "follow"
        ? tail.replace(rx, "").trim().split(/\s+/)[0]
        : null;
      const d = DEMOS[name];
      return { name, label: d.label, run: (ctx) => d.run(ctx, argMatch || undefined) };
    }
  }
  return null;
}
