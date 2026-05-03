# Pip's proactive messages come from project state, not external feeds

No scheduled pipeline scraping external robotics sources (X, Reddit, HN, ArXiv, Hackaday RSS) and dripping them into the dashboard as "here's what's new." No notification backend, no content channel.

## What we do instead

Pip's proactive messages are situational observations from state the dashboard already has. Match a colleague leaning over your desk saying *"hey, I notice X,"* not a newsletter.

Inputs, all same-origin, all already in the browser:

- Replay records (`replay.js`) — what Pip has been asked to do lately, what errored, what never completed.
- Robot telemetry — firmware version drift, last-seen timestamps, which robots are `firmware-down` vs `connected`, which capabilities have never been exercised.
- User scripts (`scripts.js` + localStorage) — scripts saved but never run, scripts that errored on last run, scripts related to a stalled goal.
- Project intent — `.claude/CLAUDE.md` (wedge + anti-drift guards) and `.claude/working.md` when present. The user's own statement of what they're trying to build is the highest-signal input.

One short observation at a time, tied to a user-activity boundary (session start, session end, robot reconnect after > 24h), not a wall-clock cron. Dismissable without consequence.

Shape examples:

```
Your "line-follow" script errored on BLE drop last Thursday.
Heartbeat shipped — worth retrying?

You've paired Pi-03 twice but never opened the camera capability.
Want me to walk through grounding?

Firmware on Pi-01 is 4 versions behind. New pulse caps landed in
between — OTA when convenient?
```

Each one names a *specific* thing *this user* did or didn't do. That's the signal a generic feed can't carry.

## Why this is the right shape

Pip runs in the browser; every input that would meaningfully change what Pip says is also in the browser, or one `fetch()` away in `.claude/*.md`. Putting signal source on a schedule outside the browser separates thinking from data and pays the cost of keeping them in sync.

What you get for free:

- **Zero new infrastructure.** No cron, no scraper, no CI job, no JSON corpus, no filter pipeline. Just `assistant.js` plus a small observation reader for existing state.
- **Zero new trust boundary.** Same-origin reads of the dashboard's own stores. Nothing crosses the network that doesn't already cross it.
- **High signal by construction.** An observation referencing the user's own script by name clears the "is this relevant?" bar before it's written. A trending-reddit link does not.
- **Dismissal is free.** Observations are ephemeral; ignoring one costs nothing and doesn't build unread debt.

## The failure mode this avoids

"Give Pip a feed so the messages aren't boring" is the engagement reflex every newsletter SaaS has tried: push content on a schedule, hope relevance averages out. Generic feeds get ignored for the same reason technical notifications get ignored: the user pays a translation cost from *"someone built X"* to *"does this matter for me right now?"* That translation cost kills engagement, not content cost.

Shipping a scheduled content pipeline *before* the state-aware layer exists pays pipeline maintenance for output the state-aware messaging would dominate on relevance anyway. Build the floor first.

## When would an external feed earn its way in?

Only when the state-aware layer saturates — when Pip has mined what the browser knows and the ceiling becomes *"Pip doesn't know about the new ESP32-S3 cam module that would unblock the perception loop."* At that point:

1. Add a GitHub Action on the `pulse` pattern — public-API-only, no-auth, committing JSON to `public/feed/`. Sources that fit: Reddit `.json`, HN Algolia, GitHub trending by topic, Hackaday/Adafruit/Sparkfun RSS, ArXiv. **Not X**: free tier died.
2. Feed is a **secondary input to the same filter** that already reads project state. Filter stays in the browser. The GitHub Action is dumb by design; intelligence stays where iteration is cheap.
3. Observations referencing external content still have to clear *"and here's why it matters for your current work."* A raw trending item never surfaces on its own.

Order matters: state-aware layer first, let it saturate, then add the corpus. Skipping to the feed is the classic "we built the pipeline before we knew what we were filtering for."
