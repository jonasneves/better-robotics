# Developer reference

One-page cheat sheet for diagnostic flags, console handles, and debug paths. If it's not here and it's user-facing, it belongs in `README.md`; if it's instructional for Claude/agents, it belongs in `.claude/CLAUDE.md`.

## URL flags

### Dashboard (`index.html`)
- `?debug` or `#debug` — verbose pairing logs to console **and** a floating green-on-black log panel (bottom-right). Implementation: `pairing.js`.
- `?prepare` — opens the Customize-card SD-prep dialog on load. Implementation: `app.js`.
- `?robot=<name>` — pre-selects a robot by name (useful for direct-link workflows). Implementation: `app.js`.
- `?no-grounding-preload` — skip the background download of the spatial detector when Watch is enabled. VLM scene captions still work; `get_robot_detections` will load the model on first call instead (with a ~30–60s wait). Use on slow / metered connections. Implementation: `grounding.js`.

### Phone (`phone.html`)
- `?debug` or `#debug` — same pairing debug as above; the floating panel is visible on the phone too.
- `#pair=<uuid>` — the pairing room id, normally injected by the QR. Required for the phone to find the room. Implementation: `phone.js`.

Combine: `phone.html?debug#pair=<uuid>`.

## Window handles (DevTools console)

Live on both desktop and phone while `pairing.js` is loaded.

- `window.replayDownload()` — downloads every Pip tool call from the current session as JSON. Returns `{count, session}`.
- `window.replayAll()` — resolves to the full in-memory array of records.
- `window.replayClear()` — wipes the replay store. Destructive.
- `window.replaySession` — the current session id (string).

## What gets recorded in replay

Every Pip tool call is persisted to IndexedDB automatically. Record shape:
```
{ id, sessionId, name, input, output, error, startedAt, endedAt, durationMs }
```
`imageDataUrl` payloads (e.g. from `ask_human_via_phone`) are kept in-record so a replay can reconstruct what Pip saw. Implementation: `public/replay.js`.

## When to reach for what

- Pairing hangs or fails silently → enable `?debug` on whichever side is stuck (desktop and/or phone).
- Understand what Pip did last session → `replayDownload()` from DevTools console, inspect the JSON.
- Camera / VLM misbehaving → enable Watch, inspect the scene card on the robot's dashboard tile. VLM output is read-only; to cross-check, use the `ask_robot_scene` tool in a Pip chat with a neutrally-framed question.
- Spatial grounding (which way to turn toward a target) → `get_robot_detections` Pip tool. Returns normalized bboxes. Model loads on first call (~30–60s, cached).

## House rules

- **Dev flags → URL.** Per-session diagnostics that shouldn't persist.
- **User preferences → Settings.** Once there are enough of them to justify an *Advanced* section (roughly 3+ real persistent preferences), that's when to build the panel.
- Keep this doc in sync when adding a new URL flag, a new `window.*` handle, or a new IndexedDB store.
