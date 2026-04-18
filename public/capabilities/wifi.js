// WiFi capability. Three characteristics:
//   wifi-scan   — read triggers rescan; notify delivers results as JSON array
//                 [{s, r, p}] sorted strongest-first, bounded by firmware SCAN_MAX.
//   wifi-join   — write JSON {s, p} to join a network (p empty for open nets).
//   wifi-status — read + notify JSON. States: idle, joining, joined, failed.
import {
  WIFI_SCAN_CHAR_UUID, WIFI_JOIN_CHAR_UUID, WIFI_STATUS_CHAR_UUID,
  decodeJson, encodeJson,
} from "../ble.js";
import { escapeHtml } from "../dom.js";
import { logFor } from "../log.js";
import { state } from "../state.js";

let renderEntry = () => {};
export function setRender(fn) { renderEntry = fn; }

export async function scanWifi(id) {
  const entry = state.devices.get(id);
  if (!entry || !entry.wifiScanChar) return;
  entry.wifiScanning = true;
  renderEntry(entry);
  try {
    const v = await entry.wifiScanChar.readValue();
    const cached = decodeJson(v);
    if (cached && cached.length) {
      entry.wifiNetworks = cached;
      renderEntry(entry);
    }
    // Fresh results arrive via the scan notification handler.
  } catch (err) {
    entry.wifiScanning = false;
    logFor(entry, `WiFi scan failed: ${err.message}`);
    renderEntry(entry);
  }
}

export async function joinWifi(id, ssid, secured) {
  const entry = state.devices.get(id);
  if (!entry || !entry.wifiJoinChar) return;
  let password = "";
  if (secured) {
    password = prompt(`Password for ${ssid}:`);
    if (password === null) return;
  }
  try {
    await entry.wifiJoinChar.writeValueWithResponse(encodeJson({ s: ssid, p: password }));
  } catch (err) {
    logFor(entry, `WiFi join failed: ${err.message}`);
  }
}

function wifiSummary(entry) {
  const { st, ssid, err } = entry.wifiStatus || {};
  if (st === "joined")  return `Connected to ${ssid || "network"}`;
  if (st === "joining") return `Joining${ssid ? ` ${ssid}` : ""}…`;
  if (st === "failed")  return `Failed${err ? ` — ${err}` : ""}`;
  return "Not configured";
}

export const wifi = {
  name: "wifi",
  initEntry: () => ({
    wifiScanChar: null, wifiJoinChar: null, wifiStatusChar: null,
    wifiStatus: { st: "idle" }, wifiNetworks: null, wifiScanning: false,
  }),

  async probe(entry, service) {
    try {
      entry.wifiScanChar   = await service.getCharacteristic(WIFI_SCAN_CHAR_UUID);
      entry.wifiJoinChar   = await service.getCharacteristic(WIFI_JOIN_CHAR_UUID);
      entry.wifiStatusChar = await service.getCharacteristic(WIFI_STATUS_CHAR_UUID);
      entry.wifiStatus = decodeJson(await entry.wifiStatusChar.readValue()) || { st: "idle" };
      await entry.wifiStatusChar.startNotifications();
      entry.wifiStatusChar.addEventListener("characteristicvaluechanged", (e) => {
        entry.wifiStatus = decodeJson(e.target.value) || { st: "idle" };
        const { st, ssid, err: errMsg } = entry.wifiStatus;
        logFor(entry, `WiFi ${st}${ssid ? ` [${ssid}]` : ""}${errMsg ? ` — ${errMsg}` : ""}`);
        renderEntry(entry);
      });
      await entry.wifiScanChar.startNotifications();
      entry.wifiScanChar.addEventListener("characteristicvaluechanged", (e) => {
        entry.wifiNetworks = decodeJson(e.target.value) || [];
        entry.wifiScanning = false;
        renderEntry(entry);
      });
    } catch {
      entry.wifiScanChar = null;
    }
  },

  cleanup(entry) {
    entry.wifiScanChar = entry.wifiJoinChar = entry.wifiStatusChar = null;
    entry.wifiNetworks = null;
    entry.wifiScanning = false;
  },

  renderSection(entry) {
    if (entry.status !== "connected" || !entry.wifiScanChar) return "";
    const nets = entry.wifiNetworks && entry.wifiNetworks.length ? `
      <div class="wifi-list">
        ${entry.wifiNetworks.map(n => `
          <div class="wifi-row">
            <div>
              <div>${escapeHtml(n.s)}</div>
              <div class="meta">${n.r} · ${n.p ? "secured" : "open"}</div>
            </div>
            <button class="secondary sm" data-action="join-wifi" data-ssid="${escapeHtml(n.s)}" data-secured="${n.p ? 1 : 0}">Join</button>
          </div>
        `).join("")}
      </div>
    ` : "";
    return `
      <div class="robot-controls row">
        <div>
          <div class="label">WiFi</div>
          <div class="meta">${escapeHtml(wifiSummary(entry))}</div>
        </div>
        <button class="secondary sm" data-action="scan-wifi" ${entry.wifiScanning ? "disabled" : ""}>
          ${entry.wifiScanning ? "Scanning…" : "Scan"}
        </button>
      </div>
      ${nets}
    `;
  },

  wireActions(entry, node) {
    const scan = node.querySelector('[data-action="scan-wifi"]');
    if (scan) scan.addEventListener("click", () => scanWifi(entry.id));
    node.querySelectorAll('[data-action="join-wifi"]').forEach(btn => {
      btn.addEventListener("click", () => joinWifi(
        entry.id, btn.dataset.ssid, btn.dataset.secured === "1",
      ));
    });
  },
};
