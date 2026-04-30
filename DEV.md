# Developer reference

One-page cheat sheet for diagnostic flags, console handles, and debug paths. If it's not here and it's user-facing, it belongs in `README.md`; if it's instructional for Claude/agents, it belongs in `.claude/CLAUDE.md`.

## URL flags

### Dashboard (`index.html`)
- `?debug` or `#debug` — verbose pairing logs to console **and** a floating green-on-black log panel (bottom-right). Implementation: `pairing.js`.
- `?probe` — runs a unilateral STUN probe on load (no pair, no peer) and logs candidate types, public IP, and `stunReachable`. Composes with `?debug` (also goes to the floating panel). Implementation: `pairing.js` + `net-probe.js`.
- `?prepare` — opens the Customize-card SD-prep dialog on load. Implementation: `app.js`.
- `?robot=<name>` — pre-selects a robot by name (useful for direct-link workflows). Implementation: `app.js`.

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
- `window.lastPairDiagnostic()` — **async**, returns a Promise. Local + remote ICE candidates from this side's most recent pair attempt, plus role/roomId/iceServers, **plus a live `pc.getStats()` snapshot** (candidate-pair states, transport, certificates, dataChannel) and the four pc state strings. Same data `chrome://webrtc-internals/` shows, no privileged-page hop. Resets on each new `hostPairingRoom`/`joinPairingRoom` call. DevTools console auto-awaits the Promise — `await window.lastPairDiagnostic()` from elsewhere.
- `window.probeNetwork({ timeoutMs })` — runs a unilateral STUN probe on demand and returns `{stunReachable, candidateTypes, publicIp, mdnsObfuscated, candidates, durationMs}`. Stashes the result in `window.lastNetProbe()`.
- `window.lastNetProbe()` — last `probeNetwork()` result, or `null` if never run.

## What gets recorded in replay

Every Pip tool call is persisted to IndexedDB automatically. Record shape:
```
{ id, sessionId, name, input, output, error, startedAt, endedAt, durationMs }
```
`imageDataUrl` payloads (e.g. from `ask_human_via_phone`) are kept in-record so a replay can reconstruct what Pip saw. Implementation: `public/replay.js`.

## Robot endpoints

- `:81/health` (per-Pi HTTP) — wifi-presence probe. JSON `{ok, type, robotId, ip, uptime_s, pi_robot_service}`. Implementation: `firmware/pi_robot/pi_robot_health.py`. PNA preflight supported.
- **WebRTC peer** (per-Pi, signaling via `wss://signal.neevs.io/pi-rtc-<robotId>/ws`). Used by `public/webrtc-robot.js` for the Shell dialog + future channels (OTA, logs, telemetry). Implementation: `firmware/pi_robot/pi_robot_rtc.py` (aiortc). The Pi presents as `desktop-<id>` in the existing pairing protocol; the dashboard joins as `dashboard-<id>` and sends the offer.

Why signaling via signal.neevs.io and not a per-Pi HTTP endpoint: browser Mixed Content blocks HTTPS dashboard → HTTP private-IP fetches before PNA preflight runs. WebSocket over wss:// avoids the gate.

## Chrome internal pages

Chrome ships several diagnostic dashboards behind `chrome://` URLs that surface state the page can't see. Most useful for this project:

- `chrome://webrtc-internals/` — every active RTCPeerConnection, ICE candidate pair tried, which got disqualified and why, DTLS/SCTP state, getStats output. **Reach for this first** when WebRTC video or pair signaling fails — the symptom is at the application layer, the cause is usually two layers down. Auto-records on connection start; the timing of "candidate-pair selected" vs "channel open" is what you usually want.
- `chrome://bluetooth-internals/` — Web Bluetooth devices Chrome currently knows about, services discovered, last scan results. Useful when a robot doesn't appear in the chooser or when GATT operations stall. The "Adapter" section also surfaces OS-level Bluetooth state (powered, discoverable, paired).
- `chrome://device-log/` — Chrome's per-event log for BLE, USB, and serial. Captures errors that the page never sees (e.g. "GATT operation already in progress" comes through here with extra context).
- `chrome://inspect/#devices` — remote DevTools for Chrome on a USB-connected Android phone. The phone surface is hard to debug otherwise; this gives full console + Sources + Network on the phone's tab from the laptop.
- `chrome://serial-internals/` — Web Serial state. Useful when the recovery-console terminal stalls.
- `chrome://net-export/` — full network capture. Heavyweight; reach for it when you need to share a `.json` log with someone or correlate cross-protocol failures.

## When to reach for what

- Pairing hangs or fails silently → enable `?debug` on whichever side is stuck, then read `window.lastPairDiagnostic()` from the console for each side's gathered candidates. If even a unilateral probe (`?probe` or `window.probeNetwork()`) returns no `srflx`, the network is blocking outbound STUN/UDP — pair will fail before it starts.
- Understand what Pip did last session → `replayDownload()` from DevTools console, inspect the JSON.
- Camera / VLM misbehaving → enable Watch, inspect the scene card on the robot's dashboard tile. VLM output is read-only; to cross-check, use the `ask_robot_scene` tool in a Pip chat with a neutrally-framed question.
- Spatial grounding (which way to turn toward a target) → `get_robot_detections` Pip tool. Returns normalized bboxes. Model loads on first call (~30–60s, cached).
- Robot pose from overhead phone → mount the phone on the robot via the helper card's `Camera →` picker, then tape an "Original ArUco" marker (id 0) on top of the robot. Generator: https://chev.me/arucogen/. Detection runs at 10 Hz on the dashboard via `js-aruco2` and renders a green outline + heading line + id label on the mounted-camera section. No markers visible = check lighting / marker isn't tilted past ~30° from the camera axis. Implementation: `aruco.js`.

## House rules

- **Dev flags → URL.** Per-session diagnostics that shouldn't persist.
- **User preferences → Settings.** Once there are enough of them to justify an *Advanced* section (roughly 3+ real persistent preferences), that's when to build the panel.
- Keep this doc in sync when adding a new URL flag, a new `window.*` handle, or a new IndexedDB store.
