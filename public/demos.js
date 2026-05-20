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

// speak() returns immediately and TTS plays async; the NEXT speak
// cancels any prior utterance still speaking (see pip-tools.js speak
// case). So calling speak then immediately doing motion (or another
// speak) cuts off the audio mid-word. speakAndWait pads with a sleep
// based on a rough TTS-rate estimate (~70ms/char + small fixed tail)
// so the words actually land before the next action. Cap at 6s so a
// runaway long line can't stall a demo forever.
async function speakAndWait(ctx, text, paddingMs = 250) {
  const t = String(text || "").trim();
  if (!t) return;
  await ctx.exec("speak", { text: t });
  const estMs = Math.min(6000, t.length * 70 + paddingMs);
  await ctx.sleep(estMs);
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
  await ctx.exec("speak", { text: "Figure eight. Here we go." });
  await ctx.sleep(500);
  // Right-arc forward (left wheel faster) — traces left lobe of the 8
  for (let i = 0; i < 3; i++) await pulse(ctx, SPEED, SPEED * 0.35, MAX);
  // Left-arc forward — traces right lobe
  for (let i = 0; i < 3; i++) await pulse(ctx, SPEED * 0.35, SPEED, MAX);
}

// 2 — Zigzag sweep. Wide alternating arcs forward — like a search
//     pattern. ~10s total. Vocal mid-sweep so the demo feels narrated.
async function zigzag(ctx) {
  await ctx.exec("speak", { text: "Hmm... scanning around." });
  await ctx.sleep(400);
  for (let i = 0; i < 3; i++) {
    await pulse(ctx, SPEED, SPEED * 0.3, MAX);
    await pulse(ctx, SPEED * 0.3, SPEED, MAX);
  }
  await ctx.exec("speak", { text: "All clear." });
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
  await ctx.exec("speak", { text: "Boom." });
}

// 4 — Patrol. Sustained drive segments + big spin-and-look between
//     them. Reads as "alive and checking" because the look-around is
//     full-rotation, not a quick tic. ~18s total.
async function patrol(ctx) {
  await ctx.exec("speak", { text: "Patrolling. Keep an eye out." });
  for (let i = 0; i < 2; i++) {
    await sustainedDrive(ctx, SPEED, SPEED, 2);  // ~4s straight
    await ctx.sleep(300);
    await pulse(ctx, -SPEED,  SPEED, MAX);       // big spin one way
    await ctx.sleep(200);
    await pulse(ctx,  SPEED, -SPEED, MAX);       // big spin back
    await ctx.sleep(200);
  }
  await ctx.exec("speak", { text: "Sweep done." });
}

// 5 — React. Active scan loop: spin a bit, check for a person, repeat
//     until someone shows up OR the budget elapses. On detection, grab
//     a frame and ask Claude for a personalized greeting that references
//     ONE specific thing it can see (the wow moment — the LLM is
//     reasoning about pixels in real time, no canned lines). Arms a
//     watcher at the end either way so future visitors get caught.
//
//     Previous version used invalid watcher args ("halt_and_speak"
//     isn't an action; ACTION_NAMES = ["halt", "speak", "notify"]) and
//     ended immediately after arming — the reactive moment landed when
//     the watcher fired minutes later, visually disconnected from the
//     demo. This version makes the reactive moment BE the demo.
async function react(ctx) {
  await ctx.exec("start_robot_camera", { id: ctx.id });
  await ctx.exec("speak", { text: "Hmm, who's around..." });

  // Scan-and-check loop. 8 ticks × ~700ms spin = ~5.5s of motion + ~8
  // detections = ~16s wall clock. Stops as soon as a person is found.
  let found = null;
  for (let i = 0; i < 8; i++) {
    if (ctx.shouldAbort?.()) return;
    const r = await ctx.exec("get_robot_detections", { id: ctx.id, queries: ["person"] });
    const hits = r?.detections || (Array.isArray(r) ? r : []);
    const hit = hits.find(d => (d?.score ?? 0) > 0.4);
    if (hit) { found = hit; break; }
    await pulse(ctx, -SPEED, SPEED, 700);  // small scan-spin
  }

  if (!found) {
    await ctx.exec("speak", { text: "Nobody around. I'll keep an eye out." });
    // Backstop: arm the watcher so a later visitor still gets caught.
    await ctx.exec("start_robot_watcher", { id: ctx.id, classes: ["person"], action: "halt" });
    return;
  }

  // Try the LLM-grade personalized greeting. Grab a fresh frame, send
  // it to Claude with a tight prompt. Cost is ~$0.0015 on Sonnet —
  // negligible for the wow it lands. Falls back to a canned greeting
  // if vision is off, the backend isn't Claude, or the call fails.
  let greeting = null;
  const frameRes = await ctx.exec("view_robot_frame", { id: ctx.id }).catch(() => null);
  const imageBlock = frameRes?._pipContent?.find(c => c.type === "image");
  if (imageBlock && ctx.askAboutFrame) {
    const dataUrl = `data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`;
    greeting = await ctx.askAboutFrame(
      dataUrl,
      "You are a friendly robot meeting someone. Reply with one short greeting (12 words max) that references ONE specific thing you can see about them (clothing color, what they're holding, posture, or the room behind them). Plain text only — no quotes, no preamble.",
      { maxTokens: 60 }
    );
  }
  await ctx.exec("speak", { text: greeting || "Hello there!" });
  // Keep the watcher armed for future visitors after the demo ends.
  await ctx.exec("start_robot_watcher", { id: ctx.id, classes: ["person"], action: "halt" });
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

// 7 — Introduce. Multi-section self-introduction with audience
//     engagement. Previously the lines were getting truncated because
//     speak() returns immediately but TTS plays async and the next
//     speak cancels it — now uses speakAndWait so each phrase lands
//     fully before the next motion. Also reframed as Disney/Spot-
//     style "engage the room": small forward step + alternating
//     side-turns so the robot reads as addressing different parts of
//     the audience between phrases, then a forward-facing finale.
//
//     Phrases are short + contraction-heavy to make the Web Speech
//     voice feel less recital-stiff. Each motion segment is sized
//     against the TTS line that just played so the choreography
//     stays in sync: short line → short move, long line → bigger move.
async function introduce(ctx) {
  // Opening — a small "lean in" forward as we greet, like a person
  // taking a small step toward the audience to start a presentation.
  await ctx.exec("speak", { text: "Hey." });
  await pulse(ctx, SPEED, SPEED, 250);  // small lean-forward
  await ctx.sleep(550);  // beat for the "Hey" to land + dramatic pause

  // First line + face left side of the room
  await speakAndWait(ctx, "I'm a little wheeled robot.");
  await pulse(ctx, -SPEED, SPEED, 700);   // ~90° left to "address" that side
  await ctx.sleep(150);

  // Second line + sweep across to the right side
  await speakAndWait(ctx, "I've got a camera, two motors, and a distance sensor.");
  await pulse(ctx,  SPEED, -SPEED, 1400); // ~180° spin to address the other side
  await ctx.sleep(150);

  // Third line + return to facing forward
  await speakAndWait(ctx, "I can drive...");
  await pulse(ctx, SPEED, SPEED, 700);    // quick forward burst to punctuate "drive"

  await speakAndWait(ctx, "spin...");
  // Empirically: 1 max pulse at speed 40 ≈ 180° on this chassis (the
  // earlier "full 360" comment was wrong). Two chained pulses for a
  // proper full rotation that lands back facing the audience.
  await pulse(ctx, -SPEED, SPEED, MAX);
  await pulse(ctx, -SPEED, SPEED, MAX);

  await speakAndWait(ctx, "and follow you around.");
  await pulse(ctx,  SPEED, -SPEED, 700);  // settle back to facing forward
  await ctx.sleep(200);

  // Closing — open invitation, brief pause for emphasis
  await speakAndWait(ctx, "So... what should we try?");
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
  await ctx.exec("speak", { text: "One sec, let me look around..." });
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
  await ctx.exec("speak", { text: "Patrolling. Watch this." });
  await ctx.exec("start_robot_camera", { id: ctx.id });
  await ctx.exec("start_robot_watcher", {
    id: ctx.id,
    classes: ["stop sign"],
    action: "halt",
  });

  // Per-cycle latch — fires when the watcher catches "stop sign" this
  // lap; cleared after the announce+wait+resume sequence so the next
  // sighting fires the announcement again. Outer demo only ends on
  // ctx.shouldAbort (Stop button) so the patrol runs indefinitely with
  // a pause-and-resume at every stop sign.
  let firedThisCycle = false;
  // Debounce + escalation state for the announcement: catchCount drives
  // the line variation (1st = wow, 2nd = neutral, 3rd+ = sassy);
  // lastAnnounceTs gates re-announces inside a 10s window (operator
  // still holding the sign while the watcher cool-down re-fires).
  let catchCount = 0;
  let lastAnnounceTs = 0;
  const unsub = ctx.onWatcherFire?.((entry, det) => {
    if (entry?.id === ctx.id && det?.label === "stop sign") firedThisCycle = true;
  });
  const breakLeg = () => firedThisCycle || ctx.shouldAbort?.();

  // Wavy forward — alternating slight-right and slight-left arcs feels
  // organic, like a vehicle gently changing lanes. Each segment is a
  // max-duration pulse so the sweep covers serious ground per loop.
  //
  // Tuned for "real patrol" feel: 12 segments × 2000ms ≈ 24s of forward
  // motion per leg ≈ 7-8m at 35 cm/s. Firmware caps speed at 40 and
  // pulse duration at 2000ms so this is as fast as a single leg can go
  // without changing the firmware floor.
  //
  // dist_cm guard: firmware silently clips pure-forward motion when
  // dist_cm < ~15 and still returns ok:true, so without this check the
  // demo would keep "driving" into a wall forever. Break the leg as
  // soon as we're under the threshold — the outer loop's turn-around
  // gets us pointed away.
  const NEAR_OBSTACLE_CM = 20;
  let blockedAhead = false;
  const wavyForward = async (segments = 12) => {
    blockedAhead = false;
    for (let i = 0; i < segments; i++) {
      if (breakLeg()) return;
      const dist = ctx.getDistCm?.();
      if (typeof dist === "number" && dist < NEAR_OBSTACLE_CM) {
        blockedAhead = true;
        return;
      }
      const arc = i % 2 === 0
        ? [SPEED,         SPEED * 0.75]
        : [SPEED * 0.75,  SPEED       ];
      await pulse(ctx, arc[0], arc[1], MAX);
    }
  };

  // 180° turn-around. Empirically 1 MAX pulse at speed 40 ≈ 180° on
  // this chassis (earlier "2 pulses = half rotation" comment was wrong;
  // 2 pulses = full 360° = robot ends up facing the SAME way it was,
  // which is why patrol seemed to stop making progress — the firmware
  // ultrasonic clip stopped it, then we "turned" all the way around
  // back toward the same wall).
  const turnAround = async () => {
    if (breakLeg()) return;
    await pulse(ctx, -SPEED, SPEED, MAX);
  };

  try {
    let lap = 0;
    while (!ctx.shouldAbort?.()) {
      lap++;
      await wavyForward();
      if (ctx.shouldAbort?.()) break;

      // Reflex caught mid-leg? Announce (debounced), wait for the gate
      // to clear (operator removes the sign), then resume without
      // turning around — we picked up where we left off.
      //
      // catchCount tracks repeat halts to enable a "I get it" escalation:
      // 1st catch is the wow moment, 2nd is normal, 3rd+ gets a sassy
      // line and silent resume. Sub-10s repeat catches are debounced
      // entirely — they're the operator holding the sign in view while
      // the watcher cool-down keeps re-firing; surfacing every one as
      // a fresh "Stop sign detected" reads as stuttering, not as
      // attention.
      if (firedThisCycle) {
        const now = Date.now();
        const sinceLast = now - (lastAnnounceTs || 0);
        if (sinceLast > 10000) {
          // Fresh catch: announce.
          catchCount++;
          const line = catchCount === 1 ? "Whoa — stop sign. Holding."
                     : catchCount === 2 ? "Stop sign again. Pausing."
                     :                    "Alright, I see it. Holding here.";
          await ctx.exec("speak", { text: line });
          lastAnnounceTs = now;
        }
        // Else: silent debounce — the operator's still holding the sign
        // from the last catch; the firmware halt already stopped us.

        if (ctx.awaitReflexGate) {
          await ctx.awaitReflexGate(ctx.id, {
            maxMs: 60000,
            isAborted: () => !!ctx.shouldAbort?.(),
          });
        } else {
          await ctx.sleep(3000);
        }
        if (ctx.shouldAbort?.()) break;
        // Only narrate the resume on the first 1-2 catches; after that
        // the operator knows the loop.
        if (catchCount <= 2) await ctx.exec("speak", { text: "Off again." });
        firedThisCycle = false;
        continue;
      }

      // If the leg cut short because of an obstacle, say so — otherwise
      // the user sees the robot stop and turn for no apparent reason.
      if (blockedAhead) {
        await ctx.exec("speak", { text: "Wall ahead — turning." });
      } else {
        await ctx.exec("speak", { text: "Around we go." });
      }
      await turnAround();
    }
  } finally {
    unsub?.();
  }

  if (ctx.shouldAbort?.()) {
    await ctx.exec("speak", { text: "Patrol stopped." });
  }
}

// 10 — Show-off. Greatest-hits reel chaining intro + figure8 + wiggle +
//      dance. ~45s. Use this as the "full pitch" — every capability,
//      back to back, with vocal narration tying them together.
async function showOff(ctx) {
  await ctx.exec("speak", { text: "Alright. Showtime." });
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
  await ctx.exec("speak", { text: "That's a wrap. Thanks for watching." });
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
