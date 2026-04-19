// Generic typed-characteristic runtime for `wifi-scan` capabilities.
// Three-char pattern: scan (read + notify list), join (write {s,p}),
// status (read + notify {st, ssid, err}). Field names on the entry
// derive from the schema's `name` so a second radio-scan type (Bluetooth
// scan, LoRa scan) could reuse the whole runtime if it followed the
// same protocol.
//
// Expected schema shape:
//   { name: "wifi", type: "wifi-scan",
//     chars: { scan: "…d93", join: "…d94", status: "…d95" } }
//
// State on entry (for name="wifi"):
//   wifiScanChar, wifiJoinChar, wifiStatusChar  — BLE handles
//   wifiStatus   — last decoded {st, ssid, err}
//   wifiNetworks — last decoded scan result array
//   wifiScanning — true while a scan is in flight
import { decodeJson, encodeJson } from "../../ble.js";
import { escapeHtml } from "../../dom.js";
import { logFor } from "../../log.js";

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

function summarize(status) {
  const { st, ssid, err } = status || {};
  if (st === "joined")  return `Connected to ${ssid || "network"}`;
  if (st === "joining") return `Joining${ssid ? ` ${ssid}` : ""}…`;
  if (st === "failed")  return `Failed${err ? ` — ${err}` : ""}`;
  return "Not configured";
}

export function makeWifiScanCap(schema) {
  const { name, chars } = schema;
  const scanField    = `${name}ScanChar`;
  const joinField    = `${name}JoinChar`;
  const statusField  = `${name}StatusChar`;
  const statusState  = `${name}Status`;
  const networksField = `${name}Networks`;
  const scanningField = `${name}Scanning`;
  const actionScan = `${name}-scan`;
  const actionJoin = `${name}-join`;
  const label = name.length <= 3 ? name.toUpperCase()
    : name[0].toUpperCase() + name.slice(1);

  async function scan(entry) {
    if (!entry[scanField]) return;
    entry[scanningField] = true;
    renderEntry(entry);
    try {
      const v = await entry[scanField].readValue();
      const cached = decodeJson(v);
      if (cached && cached.length) {
        entry[networksField] = cached;
        renderEntry(entry);
      }
    } catch (err) {
      entry[scanningField] = false;
      logFor(entry, `${name} scan failed: ${err.message}`);
      renderEntry(entry);
    }
  }

  async function join(entry, ssid, secured) {
    if (!entry[joinField]) return;
    let password = "";
    if (secured) {
      password = prompt(`Password for ${ssid}:`);
      if (password === null) return;
    }
    try {
      await entry[joinField].writeValueWithResponse(encodeJson({ s: ssid, p: password }));
    } catch (err) {
      logFor(entry, `${name} join failed: ${err.message}`);
    }
  }

  return {
    name,
    schema,
    initEntry: () => ({
      [scanField]: null, [joinField]: null, [statusField]: null,
      [statusState]: { st: "idle" },
      [networksField]: null,
      [scanningField]: false,
    }),

    async probe(entry, service) {
      try {
        entry[scanField]   = await service.getCharacteristic(chars.scan);
        entry[joinField]   = await service.getCharacteristic(chars.join);
        entry[statusField] = await service.getCharacteristic(chars.status);
        entry[statusState] = decodeJson(await entry[statusField].readValue()) || { st: "idle" };
        await entry[statusField].startNotifications();
        entry[statusField].addEventListener("characteristicvaluechanged", (e) => {
          entry[statusState] = decodeJson(e.target.value) || { st: "idle" };
          const { st, ssid, err: errMsg } = entry[statusState];
          logFor(entry, `${name} ${st}${ssid ? ` [${ssid}]` : ""}${errMsg ? ` — ${errMsg}` : ""}`);
          renderEntry(entry);
        });
        await entry[scanField].startNotifications();
        entry[scanField].addEventListener("characteristicvaluechanged", (e) => {
          entry[networksField] = decodeJson(e.target.value) || [];
          entry[scanningField] = false;
          renderEntry(entry);
        });
      } catch {
        entry[scanField] = null;
      }
    },

    cleanup(entry) {
      entry[scanField] = entry[joinField] = entry[statusField] = null;
      entry[networksField] = null;
      entry[scanningField] = false;
    },

    renderSection(entry) {
      if (entry.status !== "connected" || !entry[scanField]) return "";
      const networks = entry[networksField];
      const scanning = entry[scanningField];
      const nets = networks && networks.length ? `
        <div class="wifi-list">
          ${networks.map(n => `
            <div class="wifi-row">
              <div>
                <div>${escapeHtml(n.s)}</div>
                <div class="meta">${n.r} · ${n.p ? "secured" : "open"}</div>
              </div>
              <button class="secondary sm" data-action="${actionJoin}" data-ssid="${escapeHtml(n.s)}" data-secured="${n.p ? 1 : 0}">Join</button>
            </div>
          `).join("")}
        </div>
      ` : "";
      return `
        <div class="robot-controls row">
          <div>
            <div class="label">${escapeHtml(label)}</div>
            <div class="meta">${escapeHtml(summarize(entry[statusState]))}</div>
          </div>
          <button class="secondary sm" data-action="${actionScan}" ${scanning ? "disabled" : ""}>
            ${scanning ? "Scanning…" : "Scan"}
          </button>
        </div>
        ${nets}
      `;
    },

    wireActions(entry, node) {
      const scanBtn = node.querySelector(`[data-action="${actionScan}"]`);
      if (scanBtn) scanBtn.addEventListener("click", () => scan(entry));
      node.querySelectorAll(`[data-action="${actionJoin}"]`).forEach(btn => {
        btn.addEventListener("click", () => join(
          entry, btn.dataset.ssid, btn.dataset.secured === "1",
        ));
      });
    },
  };
}
