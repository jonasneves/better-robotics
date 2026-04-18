// Customize-card dialog. Writes firmware + wheels + firstrun.sh + capability
// config onto the boot partition of a Pi SD card. Self-contained module — no
// BLE state, no dashboard state; just File System Access API over the picked
// directory handle.
import { $, wireDialogOutsideClick } from "./dom.js";

const FIRMWARE_URL    = "firmware/pi_robot";
const FIRMWARE_FILES  = [
  "pi_robot.py", "requirements.txt", "pi-robot.service",
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
  const r = await fetch(url);
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
  const username = $("prep-username").value.trim() || "pi";
  const password = $("prep-password").value;
  const sshKey   = $("prep-sshkey").value.trim();

  if (!password) {
    prepLog("Sudo password required.", "err");
    $("prep-go-btn").disabled = false;
    return;
  }
  if (!sshKey) {
    prepLog("No SSH key — recovery will require re-flashing the SD card.", "err");
    // non-fatal: continue without an ssh_authorized_keys step.
  }

  try {
    prepLog("Validating SD card…");
    const cfg = await readTextFile(dirHandle, "config.txt");
    if (cfg === null || (!cfg.includes("[cm4]") && !cfg.includes("arm_64bit"))) {
      prepLog("Warning: picked directory doesn't look like a Pi boot partition.", "err");
    }

    prepLog("Fetching firstrun template…");
    const template = await (await fetch(`${FIRMWARE_URL}/firstrun.template.sh`)).text();

    prepLog("Fetching firmware files…");
    const betterpi = await ensureDir(dirHandle, "betterpi");
    for (const f of FIRMWARE_FILES) {
      await writeFile(betterpi, f, await fetchBlob(`${FIRMWARE_URL}/${f}`));
      prepLog(`  ✓ ${f}`, "ok");
    }

    prepLog("Fetching wheels manifest…");
    const manifest = await (await fetch(`${FIRMWARE_URL}/wheels/manifest.json`)).json();
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

    // Capability config — firmware reads this at boot to know which hardware
    // the user declared. Absent → defaults all-on for backward compat with
    // pre-config Pis.
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
    prepLog("Done. Eject the card and boot the Pi.", "ok");
  } catch (err) {
    prepLog(`Error: ${err.message}`, "err");
  } finally {
    $("prep-go-btn").disabled = false;
  }
}

function openDialog() { $("prepare-dialog").showModal(); }
function closeDialog() { $("prepare-dialog").close(); }

export function initPrepare() {
  const supported = !!window.showDirectoryPicker;
  if (!supported) {
    $("prep-unsupported").hidden = false;
    $("prep-pick-btn").disabled = true;
  }

  try {
    const saved = localStorage.getItem(SSH_KEY_STORE);
    if (saved) $("prep-sshkey").value = saved;
  } catch {}

  $("prepare-open-btn").addEventListener("click", openDialog);
  $("prepare-close").addEventListener("click", closeDialog);
  $("prep-cancel-btn").addEventListener("click", closeDialog);
  wireDialogOutsideClick($("prepare-dialog"));

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
      $("prep-pick-meta").textContent = dirHandle.name;
      $("prep-go-btn").disabled = false;
    } catch { /* user cancelled */ }
  });

  $("prep-go-btn").addEventListener("click", runPrepare);

  // Bookmark / QR-code support: ?prepare auto-opens the dialog.
  if (new URLSearchParams(location.search).get("prepare") !== null) {
    openDialog();
  }
}
