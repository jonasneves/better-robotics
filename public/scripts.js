// Browser-resident user scripts. See USER-CODE.md (architectural decision)
// and .claude/CLAUDE.md → Control-loop invariants (motor writes go through
// pulseMotors's LLM-grade caps, same floor Pip is bound by).
import { $ } from "./dom.js";
import { state } from "./state.js";
import { setToggleValue } from "./capabilities/runtime/toggle.js";
import { pulseMotors } from "./capabilities/runtime/signed-pair.js";
import { sendCommand } from "./capabilities/runtime/command.js";
import { waitOpsResponse } from "./ops-response.js";
import { observeOnce, captureFrameDataUrl } from "./perception.js";
import { listPhones, askHuman } from "./phones.js";
import { ask as claudeAsk } from "./claude.js";

// pip.ask(prompt, opts?) — routes through whichever Pip backend the user
// picked in Settings (GitHub Models / Anthropic / OpenAI / Bridge / local).
// Throws on any backend/HTTP/parse failure so scripts catch a single error
// path instead of branching on null vs. text. Costs the user's quota.
const pip = {
  async ask(prompt, opts = {}) {
    const text = await claudeAsk(String(prompt), {
      system: opts.system,
      maxTokens: opts.maxTokens ?? 300,
    });
    if (text === null) throw new Error("pip.ask: backend unreachable (check Settings → Pip backend)");
    return text;
  },
};

const STORE_KEY = "better-robotics:scripts:v1";

// Templates are starting points, not a library. Each one demonstrates a slice
// of the architecture (multi-robot, vision, phone-coupled, typed ops). Pick
// one from the dropdown to load into the editor; the user can edit freely.
const TEMPLATES = [
  {
    id: "hello",
    name: "Hello — basic moves + ops",
    body: `// \`robots\` is every connected robot, \`robot\` is the first.
// \`sleep(ms)\`, \`log(...)\`, \`speak(text)\` available. \`phones\` lists paired
// phones. See USER-CODE.md.

if (!robot) {
  log("No robots connected. Pair one and click Connect first.");
  return;
}

log(\`\${robot.name} caps: \${robot.capabilities.join(", ") || "(none)"}\`);

// Read-back ops return data:
const cfg = await robot.op("get-config");
log("config:", cfg.text?.slice(0, 200) || "(empty)");

// Pulse-bounded motion (firmware-clamped to ±40 / 50–2000 ms):
await robot.move({ left: 30, right: 30, durationMs: 400 });
await sleep(500);
await robot.move({ left: -30, right: -30, durationMs: 400 });
log("done");
`,
  },
  {
    id: "disco",
    name: "Disco — multi-robot LED + spin choreography",
    body: `// All connected robots: alternate LED on/off and spin briefly.
// What's special: this is one browser orchestrating N robots over BLE
// in parallel — the architecture's defining trick.

if (robots.length === 0) { log("Pair at least one robot."); return; }

for (let i = 0; i < 6; i++) {
  await Promise.all(robots.map(async (r, idx) => {
    try { await r.led(i % 2 === idx % 2); } catch {}
    await r.move({ left: 30, right: -30, durationMs: 300 });
  }));
  await sleep(150);
}

await Promise.all(robots.map(r => r.led(false).catch(() => {})));
log("done");
`,
  },
  {
    id: "square",
    name: "Square dance — patterned drive",
    body: `// Drive a rough square. The ±40 / 2000 ms caps that pulseMotors
// enforces are the LLM-grade safety floor — same caps Pip is bound by.
// Tune the durations for your robot's actual turn rate.

if (!robot) { log("Pair a robot first."); return; }

for (let side = 0; side < 4; side++) {
  log(\`side \${side + 1} / 4\`);
  await robot.move({ left: 35, right: 35,  durationMs: 800 });   // forward
  await sleep(400);
  await robot.move({ left: 35, right: -35, durationMs: 380 });   // turn ~90°
  await sleep(400);
}
log("done — adjust durations if it doesn't close up");
`,
  },
  {
    id: "watch-and-wander",
    name: "Watch & wander — Pip-grade vision in the loop",
    body: `// Perception in the loop: ask the in-browser VLM what's in front of the
// camera, decide whether to step forward. Same VLM Pip uses
// (public/perception.js). Requires camera streaming on this robot —
// start it from the robot card first.

if (!robot) { log("Pair a robot first."); return; }

for (let i = 0; i < 5; i++) {
  log(\`look \${i + 1}…\`);
  let scene;
  try {
    scene = await robot.scene("In one short sentence: is the path ahead clear, or is something blocking it?");
  } catch (err) {
    log(\`scene failed: \${err.message}\`);
    log("Hint: open the camera card and start streaming first.");
    return;
  }
  log(\`saw: \${scene}\`);
  if (/block|wall|obstacle|chair|leg|hand|person|cat|dog/i.test(scene)) {
    log("blocked → stopping");
    speak("blocked, stopping");
    return;
  }
  await robot.move({ left: 25, right: 25, durationMs: 400 });
  await sleep(400);
}
log("five steps clear");
`,
  },
  {
    id: "phone-joystick",
    name: "Phone joystick — paired phone drives the robot",
    body: `// Phone in the loop: pop a question on the paired phone, drive based
// on the answer. Demonstrates the WebRTC phone pair layer + ask_human
// primitive — same one Pip uses to defer decisions upward.
// Pair a phone first via the Phone QR in the avatar menu.

if (!robot) { log("Pair a robot first."); return; }
if (phones.length === 0) { log("No paired phone — pair one via the Phone QR."); return; }

const phone = phones[0];
const CMDS = {
  Forward: { left: 30,  right: 30 },
  Back:    { left: -30, right: -30 },
  Left:    { left: -25, right: 25 },
  Right:   { left: 25,  right: -25 },
};

for (let step = 0; step < 6; step++) {
  const dir = await phone.ask({
    question: \`Step \${step + 1}/6 — which way?\`,
    options: ["Forward", "Back", "Left", "Right", "Stop"],
    timeoutMs: 30000,
  });
  log(\`phone said: \${dir ?? "(no answer)"}\`);
  if (!dir || dir === "Stop") break;
  if (CMDS[dir]) await robot.move({ ...CMDS[dir], durationMs: 400 });
}
log("done");
`,
  },
  {
    id: "pip-in-the-loop",
    name: "Pip in the loop — VLM sees, Claude decides, robot acts",
    body: `// The architecture's defining shape: vision feeds an LLM, the LLM picks
// a typed action, firmware enforces the safety floor. Same primitives Pip
// uses — the script is just driving the loop directly. Six steps, then stop.
//
// Requires: camera streaming on this robot + a connected Pip backend
// (pip.ask hits the user's Claude API key, same as Pip).

if (!robot) { log("Pair a robot first."); return; }

const SYSTEM = "You drive a small ground robot via short pulses. Given a one-sentence scene, reply with EXACTLY ONE token from: forward, left, right, stop. No punctuation, no explanation.";

for (let step = 0; step < 6; step++) {
  let scene;
  try { scene = await robot.scene("Describe what's directly in front of the robot in one short sentence."); }
  catch (err) { log(\`scene failed: \${err.message} — start the camera stream first.\`); return; }
  log(\`saw: \${scene}\`);

  let move;
  try { move = (await pip.ask(\`Scene: \${scene}\`, { system: SYSTEM, maxTokens: 8 })).trim().toLowerCase(); }
  catch (err) { log(err.message); return; }
  log(\`pip: \${move}\`);

  if (move === "stop") { speak("stopping"); break; }
  const cmd = {
    forward: { left: 25,  right: 25 },
    left:    { left: -22, right: 22 },
    right:   { left: 22,  right: -22 },
  }[move];
  if (!cmd) { log(\`unrecognized move: "\${move}"\`); break; }
  await robot.move({ ...cmd, durationMs: 350 });
  await sleep(400);
}
log("done");
`,
  },
  {
    id: "fleet-status",
    name: "Fleet status — typed ops across every robot",
    body: `// Multi-robot health check. Pulls config + recent log lines from every
// connected robot in parallel via the typed ops channel. Demonstrates
// the request/response form of robot.op() at fleet scale.

if (robots.length === 0) { log("Pair at least one robot."); return; }

await Promise.all(robots.map(async (r) => {
  try {
    const [cfg, lg] = await Promise.all([
      r.op("get-config"),
      r.op("get-log", { lines: 5, unit: "pi-robot" }),
    ]);
    const cfgObj = (() => { try { return JSON.parse(cfg.text || "{}"); } catch { return {}; } })();
    const caps = Object.entries(cfgObj)
      .filter(([k, v]) => k.endsWith("_enabled") && v)
      .map(([k]) => k.replace("_enabled", ""))
      .join(", ") || "(none enabled)";
    log(\`\${r.name}  caps: \${caps}\`);
    log(\`  last log: \${(lg.text || "").trim().split("\\n").pop() || "(empty)"}\`);
  } catch (err) {
    log(\`\${r.name}: \${err.message}\`);
  }
}));
log("done");
`,
  },
];

const DEFAULT_TEMPLATE_ID = "hello";
const templateById = (id) => TEMPLATES.find(t => t.id === id) || TEMPLATES[0];

let _wired = false;
let _running = false;

function loadBody() {
  try { return localStorage.getItem(STORE_KEY) ?? templateById(DEFAULT_TEMPLATE_ID).body; }
  catch { return templateById(DEFAULT_TEMPLATE_ID).body; }
}

function saveBody(body) {
  try { localStorage.setItem(STORE_KEY, body); } catch {}
}

function loadTemplate(id) {
  const tpl = templateById(id);
  const editor = $("scripts-editor");
  const current = editor.value;
  // If the user has unsaved divergence from any known template, confirm.
  const isKnown = TEMPLATES.some(t => t.body === current);
  if (current && !isKnown && !confirm(`Replace current script with "${tpl.name}"?`)) return false;
  editor.value = tpl.body;
  saveBody(tpl.body);
  return true;
}

// Pick whichever template's body matches the editor verbatim, or "" if none
// — keeps the dropdown reading as STATE (what's loaded) instead of an action
// menu that fires-and-forgets.
function syncDropdownToEditor() {
  const sel = $("scripts-template");
  if (!sel) return;
  const ed = $("scripts-editor").value;
  const match = TEMPLATES.find(t => t.body === ed);
  sel.value = match ? match.id : "";
}

// Per-robot wrapper. Methods are thin pass-throughs to the existing capability
// surface — same code path the dashboard UI uses, so safety/clamp behavior is
// identical.
function makeRobotApi(entry) {
  return {
    id: entry.id,
    name: entry.name,
    get connected() { return entry.status === "connected"; },
    get capabilities() { return (entry.capSchema || []).map(c => c.name); },
    entry,

    async move({ left = 0, right = 0, durationMs = 400 } = {}) {
      return pulseMotors(entry.id, left, right, durationMs);
    },

    async led(on) {
      if (!entry.ledChar) throw new Error(`${entry.name}: no LED capability`);
      await setToggleValue(entry, "led", on);
    },

    // op(name, args, opts?) — sends a typed op and, by default, waits for the
    // response carrying the same op name. Pass {await: false} for ops that
    // intentionally have no response (restart-service, reboot — the robot is
    // mid-restart and BLE drops). Pass {timeoutMs: N} for slow ops.
    async op(name, args = {}, opts = {}) {
      const sent = await sendCommand(entry, "ops", { op: name, args });
      if (!sent) throw new Error(`${entry.name}: ops write failed (not connected?)`);
      if (opts.await === false) return { ok: true };
      return waitOpsResponse(name, entry.id, opts.timeoutMs ?? 10000);
    },

    // Vision: same in-browser VLM Pip uses (perception.js). Requires the
    // robot's camera stream to be live — start it from the camera card first.
    async scene(prompt = "Describe what the robot sees in one short sentence.") {
      return observeOnce(entry, prompt);
    },
    frame(maxDim = 320) { return captureFrameDataUrl(entry, maxDim); },
  };
}

function makePhoneApi(phone) {
  return {
    id: phone.id,
    label: phone.label,
    // ask({question, options?, imageDataUrl?, timeoutMs?}) — pops a question
    // on the paired phone, resolves with the user's answer string. Returns
    // null if they skipped or timed out (so script can decide to retry vs.
    // give up without a try/catch).
    async ask(opts = {}) {
      const { answer } = await askHuman(phone.id, opts);
      return answer;
    },
  };
}

function connectedRobots() {
  return [...state.devices.values()]
    .filter(e => e.status === "connected")
    .map(makeRobotApi);
}

function appendOutput(line) {
  const out = $("scripts-output");
  if (!out) return;
  const div = document.createElement("div");
  div.textContent = line;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
}

async function runScript() {
  if (_running) return;
  _running = true;
  const runBtn = $("scripts-run");
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = "Running…"; }
  const out = $("scripts-output");
  if (out) out.innerHTML = "";
  const body = $("scripts-editor").value;
  saveBody(body);
  const log = (...args) => appendOutput(args.map(a =>
    typeof a === "string" ? a : JSON.stringify(a)
  ).join(" "));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // Web Speech is browser-native, no deps. Useful for ambient feedback in
  // demos where staring at the laptop screen pulls focus from the robot.
  const speak = (text) => {
    try { speechSynthesis.speak(new SpeechSynthesisUtterance(String(text))); }
    catch {}
  };
  const robots = connectedRobots();
  const robot = robots[0] || null;
  const phones = listPhones().map(makePhoneApi);
  try {
    // AsyncFunction so `await` works at the top of the user's script.
    const fn = new (Object.getPrototypeOf(async function () {}).constructor)(
      "robot", "robots", "phones", "pip", "sleep", "log", "speak", body
    );
    const ret = await fn(robot, robots, phones, pip, sleep, log, speak);
    if (ret !== undefined) appendOutput(`→ ${typeof ret === "string" ? ret : JSON.stringify(ret)}`);
  } catch (err) {
    appendOutput(`Error: ${err.message || err}`);
  } finally {
    _running = false;
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = "Run"; }
  }
}

export function openScriptsDialog() {
  const dlg = $("scripts-modal");
  $("scripts-editor").value = loadBody();
  syncDropdownToEditor();
  dlg.showModal();
}

export function init() {
  if (_wired) return;
  _wired = true;
  $("scripts-close").addEventListener("click", () => $("scripts-modal").close());
  $("scripts-run").addEventListener("click", runScript);
  // Placeholder option for "no template loaded / editor diverged from any known
  // template." innerHTML overwrites any placeholder in the markup, so we re-add
  // it here. Dropdown reads as STATE (what's currently loaded) — change fires
  // load + leaves the picked option visible. If the user has unsaved edits and
  // cancels the confirm, snap the dropdown back to whatever the editor holds.
  const sel = $("scripts-template");
  sel.innerHTML = `<option value="">— (custom)</option>` +
    TEMPLATES.map(t => `<option value="${t.id}">${t.name}</option>`).join("");
  sel.addEventListener("change", () => {
    if (!sel.value) return;
    if (!loadTemplate(sel.value)) syncDropdownToEditor();
  });
  $("scripts-editor").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runScript();
    }
  });
}
