# Developer reference

Cheat sheet for diagnostic flags, console handles, debug paths. User-facing → `README.md`. Agent-facing → `.claude/CLAUDE.md`.

## URL flags

### Dashboard (`index.html`)
- `?prepare` — opens the Customize-card SD-prep dialog on load. Implementation: `app.js`.
- `?robot=<name>` — pre-selects a robot by name (useful for direct-link workflows). Implementation: `app.js`.

### Phone (`phone.html`)
- `#pair=<uuid>` — the pairing room id, normally injected by the QR. Required for the phone to find the room. Implementation: `mobile.js`.

## Keyboard control

WASD / arrow keys drive the **active motors target** — one robot at a time,
mutually exclusive. With a single connected robot, it's the auto-pick.
With two or more, the active card's Motors section shows `Motors · Driving`.
Switch via:

- Click anywhere on a card's **Motors section** → that robot becomes active.
- Number keys **`1`–`9`** → activate the Nth connected robot (in `state.devices`
  insertion order — same as the card list).

Active disconnects → auto-pick re-runs on the next key/joypad event.
Implementation: `public/capabilities/runtime/signed-pair.js`. State key:
`state.activeMotorsRobotId` (session-only, not persisted).

## Window handles (DevTools console)

Live on both desktop and phone while `pairing.js` is loaded.

- `window.replayDownload()` — downloads every Pip tool call from the current session as JSON. Returns `{count, session}`.
- `window.replayAll()` — resolves to the full in-memory array of records.
- `window.replayClear()` — wipes the replay store. Destructive.
- `window.replaySession` — the current session id (string).
- `window.lastPairDiagnostic()` — **async**, returns a Promise. Local + remote ICE candidates from this side's most recent pair attempt, plus role/roomId/iceServers, **plus a live `pc.getStats()` snapshot** (candidate-pair states, transport, certificates, dataChannel) and the four pc state strings. Same data `chrome://webrtc-internals/` shows, no privileged-page hop. Resets on each new `hostPairingRoom`/`joinPairingRoom` call. DevTools console auto-awaits the Promise — `await window.lastPairDiagnostic()` from elsewhere.
- `window.probeNetwork({ timeoutMs })` — runs a unilateral STUN probe on demand and returns `{stunReachable, candidateTypes, publicIp, mdnsObfuscated, candidates, durationMs}`. Stashes the result in `window.lastNetProbe()`.
- `window.lastNetProbe()` — last `probeNetwork()` result, or `null` if never run.
- `window.probeIceReachability(iceServers, { timeoutMs })` — per-server reachability + first-hit latency. Returns `[{urls, reachable, latencyMs, types}]`. Pass the array `fetchIceServers()` returns to test the TURN-enabled config a real pair uses.

## What gets recorded in replay

Every Pip tool call is persisted to IndexedDB automatically. Record shape:
```
{ id, sessionId, name, input, output, error, startedAt, endedAt, durationMs }
```
`imageDataUrl` payloads (e.g. from `ask_human_via_phone`) are kept in-record so a replay can reconstruct what Pip saw. Implementation: `public/replay.js`.

## Robot endpoints

- `:81/health` (per-Pi HTTP) — wifi-presence probe. JSON `{ok, type, robotId, ip, uptime_s, pi_robot_service}`. Implementation: `firmware/pi_robot/pi_robot_health.py`. PNA preflight supported.
- **WebRTC peer** (per-Pi). The dashboard writes a chunked SDP offer to the BLE `SIGNAL` characteristic; `pi_robot.py` (root) reassembles and forwards to a local aiortc daemon (`pi_robot_rtc.py`, non-root) over `/run/pi-robot-rtc.sock`. The daemon answers non-trickle (all candidates inline); pi_robot.py chunks the answer back via BLE notify. Used by `public/webrtc-robot.js` for the Shell dialog, OTA bundle staging, and log tail. No internet rendezvous — BLE pair is the signal substrate.

## Chrome internal pages

`chrome://` dashboards that surface state the page can't see:

- `chrome://webrtc-internals/` — every active RTCPeerConnection, ICE candidate pair tried, which got disqualified and why, DTLS/SCTP state, getStats output. **First stop** when WebRTC video or pair signaling fails. Auto-records on connection start; "candidate-pair selected" vs "channel open" timing is usually what you want.
- `chrome://bluetooth-internals/` — Web Bluetooth devices Chrome knows, services discovered, last scan results. Useful when a robot doesn't appear in the chooser or GATT operations stall. "Adapter" section surfaces OS-level state (powered, discoverable, paired).
- `chrome://device-log/` — per-event log for BLE, USB, serial. Captures errors the page never sees (e.g. "GATT operation already in progress").
- `chrome://inspect/#devices` — remote DevTools for Chrome on USB-connected Android. Full console + Sources + Network on the phone's tab.
- `chrome://serial-internals/` — Web Serial state. Useful when the recovery-console terminal stalls.
- `chrome://net-export/` — full network capture. Heavyweight; for sharing a `.json` log or correlating cross-protocol failures.

## When to reach for what

- Pairing hangs or fails silently → open the Diagnostics dialog (menu) and Refresh — captures STUN probe + last pair attempt's `getStats()` + connected-robot telemetry into one JSON. If even the unilateral probe returns no `srflx`, the network is blocking outbound STUN/UDP — pair will fail before it starts.
- Understand what Pip did last session → `replayDownload()` from DevTools console, inspect the JSON.
- Camera / VLM misbehaving → enable Watch, inspect the scene card on the robot's dashboard tile. VLM output is read-only; to cross-check, use the `ask_robot_scene` tool in a Pip chat with a neutrally-framed question.
- Spatial grounding (which way to turn toward a target) → `get_robot_detections` Pip tool. Returns normalized bboxes. Model loads on first call (~30–60s, cached).

## House rules

- **Dev flags → URL.** Per-session diagnostics that shouldn't persist.
- **User preferences → Settings.** Build the panel once there are 3+ real persistent preferences.
- Keep this doc in sync when adding a URL flag, `window.*` handle, or IndexedDB store.
