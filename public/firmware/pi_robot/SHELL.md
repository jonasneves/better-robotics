# Shell over BLE — design doc

> **Status: not pursuing (2026-04-19, reaffirmed 2026-04-23).**
>
> Two reasons, ordered:
>
> **1. We don't need it.** The typed ops channel (`get-log`, `get-config`,
> `restart-service`, `reboot`, `install-pkg`, `enroll-key`) covers most
> debug needs over BLE without opening a shell. Heartbeat (added
> 2026-04-23) covers "is the robot alive when firmware is dead." The
> remaining cases — arbitrary debug from physical reach — go through the
> USB-C recovery xterm. Each typed op is a deliberate, reviewable
> decision; a shell is "everything you can run." The smart-safety move is
> to extend the typed ops set as new debug needs appear, not to open a
> general-purpose shell. See `.claude/CLAUDE.md → Scope discipline`.
>
> **2. The original blocker has shifted but isn't gone.** As of
> 2026-04-19 the doc cited `pi-robot.conf` containing the WiFi PSK in
> plaintext — that's stale: WiFi credentials now go straight to
> NetworkManager via `nmcli connection ... password ...`
> (`pi_robot.py:1139`), and NM's connection store is root-only mode 600.
> But `pi-robot.service` runs as root, so a naively-spawned BLE shell
> still inherits enough privilege to read those NM files. Plugging the
> leak now requires uid separation for the spawned shell (run as `pi`,
> tightened polkit), which is real work for a feature we don't have a
> use case for.
>
> The motivating use case (live parameter tuning) is better served by a
> structured `params` capability — typed `{key, value}` set/get over a
> dedicated characteristic, opt-in per param, no shell attack surface.
> See `mqtt-ai/ROADMAP.md` for the shape.
>
> **Revisit this doc only if:**
>
> - A concrete use case appears that typed ops + USB-C recovery genuinely
>   can't cover (e.g. a robot bolted somewhere physical access is
>   impractical), AND
> - uid separation has landed (the shell user can't read NM connection
>   files, equivalent of the original `pirobot` service-user split).
>
> Doc is left intact below as a record of the design exploration. Internal
> audit flagged concrete integration errors (capability `type` field missing,
> wrong config target — should be `public/prepare.js` not
> `firstrun.template.sh`, wrong file path — `public/capabilities/runtime/`
> not `public/capabilities/`, key name parity — `shell_enabled` not `shell`).
> These are NOT fixed; fixing them is only worth the effort when the feature
> is actually being built.
>
> Scout flagged two items worth remembering even if we never build this:
> BlueZ per-characteristic encryption via `bless` needs to be spiked on real
> hardware before relying on it (the flag exists in source; end-to-end
> behavior on Trixie is unverified), and Web Bluetooth gives no ordering /
> backpressure guarantees — a PTY protocol over BLE needs framing, not raw
> bytes.

---

## Goal

Give a paired robot an interactive shell from the dashboard, reusing the xterm.js
machinery from Recovery. Enables in-browser debugging, live parameter tuning,
and light scripting without SSH setup.

## Non-goals

- Rescue-mode shell — that's Recovery's job, over USB, independent of pi-robot.
- File transfer — use `scp` over the WiFi the robot already joined.
- Long-running jobs — shell over BLE is latency-sensitive; start nohup'd jobs
  and disconnect, don't watch them live.

## BLE service design

All characteristics under the existing `SERVICE_UUID`
(`a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d91`).

| Name        | Suffix | Properties               | Direction        | Payload                       |
|-------------|--------|--------------------------|------------------|-------------------------------|
| `SHELL_TX`  | `...9d` | notify, read             | Pi → client      | Raw bytes — pty stdout/stderr |
| `SHELL_RX`  | `...9e` | write-without-response   | client → Pi      | Raw bytes — keyboard input    |
| `SHELL_SIZE`| `...9f` | write                    | client → Pi      | 4 bytes: cols(u16) rows(u16)  |

Pattern mirrors [Nordic UART Service (NUS)] — the standard BLE serial-over-GATT
shape — with an added resize channel for proper PTY `TIOCSWINSZ`.

Suffix allocation continues the codebase convention in `pi_robot.py`: one suffix
byte per char, mapped from the capability name on the client side so the
fw-info characteristic doesn't bust MTU. (See the comment at line ~58 of
`pi_robot.py`.)

### Framing

Raw bytes both ways. No JSON envelope, no newline-terminated records — xterm
expects a stream. The PTY on the Pi handles VT100 escapes, line buffering,
echoing, `SIGWINCH`, etc.

**MTU.** ATT default is 23; Web BLE + Chrome negotiates up to 185 in practice.

- **TX (Pi → client):** each notification is a chunk. BLE guarantees in-order
  delivery per characteristic, so the client concatenates and writes directly
  to xterm. Typical shell output fits in a single notification; `cat largefile`
  fragments naturally.
- **RX (client → Pi):** Web BLE writes are limited to the negotiated MTU − 3.
  The client splits large inputs (pastes) into chunks, writes sequentially,
  awaits each completion to preserve byte order.

### Resize

Client writes 4 bytes to `SHELL_SIZE` on xterm's `onResize`. Pi unpacks
`cols, rows = struct.unpack("<HH", data)` and calls `fcntl.ioctl(fd,
TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))`. No reply needed — the pty
just adjusts and the shell sends `SIGWINCH` to the child.

## Firmware

### Subscribe = spawn

On SHELL_TX subscribe (CCCD write), fork a pty:

- User `pi` (non-root). Do **not** inherit pi-robot's uid if it's elevated.
- `TERM=xterm-256color`, `LANG=C.UTF-8`, `HOME=/home/pi`, cwd=`/home/pi`.
- Shell: `/bin/bash --login`. Not `rbash` — learning context needs flexibility.
- Pump stdout/stderr → notifications. Pump SHELL_RX writes → pty stdin.

On unsubscribe or disconnect: `os.kill(pid, SIGHUP)`, then `waitpid` with short
timeout, then `SIGKILL` fallback. No session persistence — fresh pty per
connection, matching SSH default.

### Capabilities manifest

Add `"shell"` to the array returned by the fw-info characteristic. Dashboard
reads this to decide whether to show the Shell menu entry. No UI changes
required on robots that don't enable it.

### Config

`pi-robot.conf` gets a `shell = true/false` key, **default `false`**. Opt-in.
`firstrun.template.sh` adds a commented line pointing to it so setup is
discoverable.

Rationale for default-off: BLE shell = radio-range interactive root-adjacent
access, even with user=pi. Teachers enable explicitly on classroom robots.

## Security model

### Threat

BLE advertises publicly (~10m range). Without protections, anyone nearby with
a browser could connect to a paired robot and drop into a bash session.

### Mitigations (defense in depth)

1. **Encryption required on shell characteristics.** `bless` exposes per-char
   encryption flags; SHELL_TX, SHELL_RX, SHELL_SIZE require an encrypted link.
   Force BlueZ pairing (with PIN or Just Works, depending on bond agent) before
   the chars can be used. Existing pi-robot caps (LED, motors) currently use no
   encryption — this is a tightening for shell specifically.

2. **Non-root uid.** Shell runs as `pi`. `sudo` requires password unless
   already configured NOPASSWD on the robot. Classroom default: sudo password
   set during firstrun, no NOPASSWD rules.

3. **Opt-in in config.** `shell = false` by default. Administrator action
   required to expose this attack surface.

4. **Session logging.** Every shell session writes to
   `/var/log/pi-robot/shell.log` with session id (uuid4), client BLE address,
   start/end timestamps, and each command line (parsed from bash via
   `PROMPT_COMMAND` or auditd). File is append-only (`chattr +a`).

5. **One session at a time.** Second SHELL_TX subscriber while a session is
   active is rejected. Prevents silent sharing.

### Explicitly not doing

- **Restricted shell (rbash).** Too restrictive for the education use case;
  students need to `pip install`, `nano`, `ls /`. User=pi + sudo password is
  our boundary.
- **SELinux / AppArmor confinement.** Out of v1 scope. Worth considering if a
  threat arises.
- **Key-based auth at the BLE layer.** BLE bonding does the equivalent; adding
  a second key layer doubles failure modes without adding security.
- **Full command audit (auditd).** Overkill; PROMPT_COMMAND logging is
  sufficient for "who did what in a classroom."

## Frontend

### Shared term module

Extract xterm + FitAddon boilerplate from `public/recovery.js` into
`public/term.js`:

```js
export async function createTerm(container, { onData, onResize }) { ... }
```

Both `recovery.js` and `capabilities/shell.js` call it. Keeps xterm lazy-loaded
(still ~250 KB per the existing comment in `recovery.js`).

### Capability module: `public/capabilities/shell.js`

On `start(entry)`:

- Subscribe to SHELL_TX (triggers pty spawn on Pi).
- `createTerm(container, { onData: writeRx, onResize: writeSize })`.
- SHELL_TX notifications → `term.write(value)`.

On `stop(entry)`: unsubscribe. Pi tears down pty.

### Dialog / menu entry

- New menu item "Shell" in the `⋯` robot-card menu, above Pinout.
- Visible only when `entry.capabilities.includes("shell")`.
- Opens a new `#shell-modal` dialog, same shape as `#recovery-modal`:
  820×640, flex column, xterm fills the body.
- Unlike recovery, the dialog can be opened per-robot — multiple shells aren't
  supported (firmware enforces one), but the UI can show which robot's shell
  is active via the dialog title.

## Open questions for review

1. **Confirmation prompt on first open?** "Enter shell for robot X? Session
   will be logged." — or silent?
2. **Session concurrency.** Firmware rejects second subscriber. Should the
   client get a clear error, or just "failed to subscribe"?
3. **Paste handling.** xterm has native bracketed-paste detection. Does bash
   on the Pi enable `bind 'set enable-bracketed-paste on'` by default?
4. **MTU negotiation on Pi side.** Worth explicitly requesting larger MTU via
   BlueZ for reduced notification overhead on `cat`-style output?
5. **Interactive vs canonical mode.** Does the pty correctly forward ANSI
   cursor keys, `Ctrl-C`, `Ctrl-D`? (Should — standard PTY does this — but
   worth a deliberate test.)
6. **UTF-8 byte fragmentation.** If a multi-byte UTF-8 char is split across
   two notifications, does xterm handle it? (It's robust; mention anyway.)
