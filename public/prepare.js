import { $, freshUrl, fetchWithTimeout } from "./dom.js";
import { pubkeySsh } from "./auth.js";
import { ensurePassword } from "./passwords.js";

const FIRMWARE_URL    = "firmware/pi_robot";
const FIRMWARE_FILES  = [
  "pi_robot.py", "requirements.txt", "pi-robot.service",
  "heartbeat.py", "pi-robot-heartbeat.service",
  "usb-gadget-setup.sh", "usb-gadget.service",
];
const SSH_KEY_STORE   = "better-robotics:ssh-pub";
// libcomposite is the generic USB-gadget driver; the actual composite
// (ECM ethernet + ACM serial) is configured via configfs at boot by
// usb-gadget.service. Replaces the old `g_ether` one-function gadget.
const CMDLINE_USB     = " modules-load=dwc2,libcomposite";
const CONFIG_USB_MARKER = "# Better Robotics: USB gadget mode";
const CONFIG_USB_LINES  = `\n${CONFIG_USB_MARKER}\n[all]\ndtoverlay=dwc2\n`;
const SYSTEMD_RUN =
  " systemd.run=/boot/firmware/firstrun.sh" +
  " systemd.run_success_action=reboot" +
  " systemd.unit=kernel-command-line.target";

let dirHandle = null;

function prepLog(msg, cls) {
  const el = document.createElement("div");
  if (cls) el.className = cls;
  el.textContent = msg;
  $("prep-progress").prepend(el);
}

const shSingleQuote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
const ensureDir = (parent, name) => parent.getDirectoryHandle(name, { create: true });

async function writeFile(dir, name, contents) {
  const h = await dir.getFileHandle(name, { create: true });
  const w = await h.createWritable();
  await w.write(contents);
  await w.close();
}

async function readTextFile(dir, name) {
  try {
    const h = await dir.getFileHandle(name);
    const f = await h.getFile();
    return await f.text();
  } catch { return null; }
}

async function fetchBlob(url) {
  // 60s — wheels / binaries can be a few MB each on slow connections.
  const r = await fetchWithTimeout(freshUrl(url), { cache: "no-cache" }, 60000);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.blob();
}

function patchCmdline(text) {
  let line = text.replace(/\n+$/, "").trim();
  line = line.replace(/\s+systemd\.run=\S+/g, "");
  line = line.replace(/\s+systemd\.run_success_action=\S+/g, "");
  line = line.replace(/\s+systemd\.unit=\S+/g, "");
  line = line.replace(/\s+modules-load=\S+/g, "");
  return line + CMDLINE_USB + SYSTEMD_RUN + "\n";
}

function patchConfig(text) {
  if (text.includes(CONFIG_USB_MARKER)) return text;
  return text.replace(/\n*$/, "") + CONFIG_USB_LINES;
}

function renderFirstrun(template, values) {
  let out = template;
  for (const [k, v] of Object.entries(values)) {
    out = out.replaceAll(`__REPLACE_${k}__`, shSingleQuote(v));
  }
  return out;
}

async function runPrepare() {
  $("prep-go-btn").disabled = true;
  $("prep-progress").hidden = false;
  $("prep-progress").innerHTML = "";

  const hostname = $("prep-hostname").value.trim() || "betterpi";
  const username = $("prep-username").value.trim() || "robot";
  let password   = $("prep-password").value;
  const sshKey   = $("prep-sshkey").value.trim();
  let passwordGenerated = false;
  if (!password) {
    password = await ensurePassword(hostname);
    passwordGenerated = true;
  }

  // Password optional: firstrun skips chpasswd when empty (SSH-key-only login).

  try {
    prepLog("Validating SD card…");
    const cfg = await readTextFile(dirHandle, "config.txt");
    if (cfg === null || (!cfg.includes("[cm4]") && !cfg.includes("arm_64bit"))) {
      prepLog("Warning: picked directory doesn't look like a Pi boot partition.", "err");
    }

    prepLog("Fetching firstrun template…");
    const template = await (await fetchWithTimeout(freshUrl(`${FIRMWARE_URL}/firstrun.template.sh`), { cache: "no-cache" })).text();

    prepLog("Fetching firmware files…");
    const betterpi = await ensureDir(dirHandle, "betterpi");
    for (const f of FIRMWARE_FILES) {
      await writeFile(betterpi, f, await fetchBlob(`${FIRMWARE_URL}/${f}`));
      prepLog(`  ✓ ${f}`, "ok");
    }

    prepLog("Fetching wheels manifest…");
    const manifest = await (await fetchWithTimeout(freshUrl(`${FIRMWARE_URL}/wheels/manifest.json`), { cache: "no-cache" })).json();
    const wheels = await ensureDir(dirHandle, "wheels");
    for await (const entry of wheels.values()) {
      if (entry.kind === "file") await wheels.removeEntry(entry.name).catch(() => {});
    }
    for (const filename of manifest.wheels) {
      await writeFile(wheels, filename, await fetchBlob(`${FIRMWARE_URL}/wheels/${filename}`));
      prepLog(`  ✓ ${filename}`, "ok");
    }

    prepLog("Rendering firstrun.sh…");
    const firstrun = renderFirstrun(template, {
      HOSTNAME:  hostname,
      USER_NAME: username,
      USER_PASS: password,
      SSH_KEY:   sshKey,
    });
    await writeFile(dirHandle, "firstrun.sh", firstrun);

    prepLog("Writing dashboard.pub…");
    await writeFile(dirHandle, "dashboard.pub", (await pubkeySsh()) + "\n");

    // Absent → firmware defaults all-on for backward compat with pre-config Pis.
    prepLog("Writing pi-robot.conf…");
    const piConfig = {
      led_enabled: $("prep-cap-led").checked,
      led_pin: parseInt($("prep-cap-led-pin").value, 10) || 17,
      motors_enabled: $("prep-cap-motors").checked,
      camera_enabled: $("prep-cap-camera").checked ? "auto" : false,
    };
    await writeFile(dirHandle, "pi-robot.conf", JSON.stringify(piConfig, null, 2));

    prepLog("Patching cmdline.txt…");
    const oldCmd = await readTextFile(dirHandle, "cmdline.txt");
    if (oldCmd === null) throw new Error("cmdline.txt not found on card");
    await writeFile(dirHandle, "cmdline.txt", patchCmdline(oldCmd));

    prepLog("Enabling USB gadget mode…");
    const oldCfg = await readTextFile(dirHandle, "config.txt");
    if (oldCfg === null) throw new Error("config.txt not found on card");
    await writeFile(dirHandle, "config.txt", patchConfig(oldCfg));

    try { localStorage.setItem(SSH_KEY_STORE, sshKey); } catch {}
    if (passwordGenerated) {
      prepLog(`Generated a random sudo password — see Settings → Robot passwords.`, "ok");
    }
    // Browsers can't eject a volume — File System Access API is file-only and
    // mass-storage WebUSB is blocked. Best we can do: confirm writes are
    // flushed (every writable closed above) and tell the user how to eject.
    const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
    const tip = isMac ? "⌘E in Finder" : "right-click the card → Eject";
    prepLog(`Safe to eject now (${tip}). Then boot the Pi.`, "ok");
  } catch (err) {
    prepLog(`Error: ${err.message}`, "err");
  } finally {
    $("prep-go-btn").disabled = false;
  }
}

function closeDialog() { $("prepare-dialog").close(); }

// Module is lazy-loaded by app.js on first "Set up a Pi robot" click, so
// one-time setup runs in initOnce() guarded by a flag. The "prepare-open-btn"
// handler itself is owned by app.js — it triggers the import, then calls
// openDialog() here. No outside-click dismiss on the dialog: SD prep is a
// multi-step write to the card, and accidental close mid-flight leaves a
// partially-prepped card. Users close via × or Cancel explicitly.
let _initialized = false;
function initOnce() {
  if (_initialized) return;
  _initialized = true;

  const supported = !!window.showDirectoryPicker;
  if (!supported) {
    $("prep-unsupported").hidden = false;
    $("prep-pick-btn").disabled = true;
  }

  try {
    const saved = localStorage.getItem(SSH_KEY_STORE);
    if (saved) $("prep-sshkey").value = saved;
  } catch {}

  $("prepare-close").addEventListener("click", closeDialog);
  $("prep-cancel-btn").addEventListener("click", closeDialog);

  $("prep-sshkey-load").addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pub,text/*";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      $("prep-sshkey").value = (await file.text()).trim();
    });
    input.click();
  });

  $("prep-pick-btn").addEventListener("click", async () => {
    try {
      dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      const pickMeta = $("prep-pick-meta");
      pickMeta.textContent = dirHandle.name;
      pickMeta.className = "meta";
      $("prep-go-btn").disabled = false;
    } catch { /* user cancelled */ }
  });

  $("prep-go-btn").addEventListener("click", runPrepare);
}

export async function openDialog() {
  initOnce();
  // Guarantee the dashboard key is present in the textarea on open, without
  // clobbering anything the user pasted or saved from a previous prep.
  const dashKey = await pubkeySsh();
  const ta = $("prep-sshkey");
  if (!ta.value.includes(dashKey)) {
    ta.value = ta.value.trim() ? `${dashKey}\n${ta.value.trim()}` : dashKey;
  }
  $("prepare-dialog").showModal();
}
