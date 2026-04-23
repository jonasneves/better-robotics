# Pip's proactive messages come from project state, not external feeds

A structural decision, captured here so it doesn't get re-litigated.

## What we don't do

We don't run a scheduled pipeline that scrapes external robotics sources
(X, Reddit, HN, ArXiv, Hackaday RSS) and drips them into the dashboard as
"here's what's new in Pi / ESP32 land." No GitHub Action cron that
commits a trending-feed JSON as the primary input to Pip's messages. No
notification backend. No content channel the user subscribes to.

## What we do instead

Pip's proactive messages are situational observations drawn from state
the dashboard already has. The model to match isn't a newsletter — it's
a colleague leaning over your desk saying *"hey, I notice X."*

Concrete inputs, all same-origin, all already in the browser:

- Replay records (`replay.js`) — what Pip has been asked to do lately,
  what errored, what never completed.
- Robot telemetry — firmware version drift, last-seen timestamps, which
  robots are `firmware-down` vs `connected`, which capabilities have
  never been exercised.
- User scripts (`scripts.js` + localStorage) — scripts saved but never
  run, scripts that errored on last run, scripts that look related to a
  stalled goal.
- Project intent — `.claude/direction.md` and `.claude/working.md` when
  present. The user's own statement of what they're trying to build is
  the highest-signal input available.

One short observation at a time, tied to a user-activity boundary
(session start, session end, robot reconnect after > 24h) — not to a
wall-clock cron. Dismissable without consequence.

Shape examples:

```
Your "line-follow" script errored on BLE drop last Thursday.
Heartbeat shipped — worth retrying?

You've paired Pi-03 twice but never opened the camera capability.
Want me to walk through grounding?

Firmware on Pi-01 is 4 versions behind. New pulse caps landed in
between — OTA when convenient?
```

Each one names a *specific* thing *this user* did or didn't do. That's
the signal a generic feed can't carry.

## Why this is the right shape

The architecture already says where the brain lives. Pip runs in the
browser; every input that would meaningfully change what Pip says is
also in the browser, or in a `.claude/*.md` file one `fetch()` away.
Putting the signal source on a schedule outside the browser would
separate the thinking from the data for no reason, and would pay the
cost of keeping them in sync.

What you get for free:

- **Zero new infrastructure.** No cron, no scraper, no CI job, no JSON
  corpus, no filter pipeline. `assistant.js` + a small
  `pip-observations.js` module reading existing state.
- **Zero new trust boundary.** Same-origin reads of the dashboard's own
  stores. Nothing crosses the network that doesn't already cross it.
- **High signal by construction.** An observation that references the
  user's own script by name clears the "is this relevant?" bar before
  it's even written. A trending-reddit link does not.
- **Dismissal is free.** Observations are ephemeral; the user ignoring
  one costs nothing and doesn't build up unread debt.

## The failure mode this avoids

"Give Pip a feed so the messages aren't boring" is the same shape as
the engagement reflex every newsletter SaaS has tried: push content on
a schedule, hope relevance averages out. It doesn't. Generic feeds get
ignored for the exact reason technical notifications get ignored — the
user has to do the translation from *"someone built X"* to *"does this
matter for me right now?"* The translation cost is what kills
engagement, not the content cost.

Shipping a scheduled content pipeline *before* the state-aware layer
exists guarantees we pay pipeline maintenance for output that
state-aware messaging would dominate on relevance anyway. Build the
floor first.

## What we DON'T need (and don't build)

- **GitHub Action cron scraping X / Reddit / HN.** The `pulse` pattern
  (see `~/Github/jonasneves/pulse/.github/workflows/fetch-trending.yml`)
  is the right template *when* external content earns its way in. It
  hasn't.
- **A notifications backend.** No server to push from, no inbox
  abstraction, no delivery guarantees. Observations appear inline in
  the dashboard and are forgotten when dismissed.
- **A relevance scoring service.** The filter lives in the browser
  where iteration is cheap; shipping it as infra inverts the cost curve.
- **Subscription / preferences UI.** Users don't subscribe to a
  coworker's observations. Frequency is tied to activity boundaries,
  not to a user-configured schedule.

## When would an external feed earn its way in?

Only when the state-aware layer has saturated — when Pip has mined out
what the browser already knows and the ceiling becomes *"Pip doesn't
know about the new ESP32-S3 cam module that would unblock the perception
loop."* At that point:

1. Add a GitHub Action on the `pulse` pattern — public-API-only,
   no-auth, committing JSON to `public/feed/`. Free sources that fit:
   Reddit `.json` endpoints, HN Algolia, GitHub trending by topic,
   Hackaday / Adafruit / Sparkfun RSS, ArXiv. **Not X** — free tier
   died.
2. The feed is a **secondary input to the same filter** that already
   reads project state. The filter stays in the browser. The GitHub
   Action is dumb by design; intelligence stays where iteration is
   cheap.
3. Observations referencing external content still have to clear the
   *"and here's why it matters for your current work"* bar. A raw
   trending item never surfaces on its own.

Order matters: build the state-aware layer first, let it saturate, then
add the corpus as a secondary input. Skipping to the feed is the
classic "we built the pipeline before we knew what we were filtering
for."

Until then, this doc is the answer.
