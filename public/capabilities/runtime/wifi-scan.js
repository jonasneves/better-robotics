// Expected schema shape:
//   { name: "wifi", type: "wifi-scan",
//     chars: { scan: "…d93", join: "…d94", status: "…d95" } }
// Three-char protocol: scan (read + notify list), join (write {s,p}),
// status (read + notify {st, ssid, err, ip?}).
import { UUIDS_BY_CAP, decodeJson, encodeJson } from "../../ble.js";
import { capSection } from "./cap-section.js";
import { escapeHtml } from "../../dom.js";
import { logFor } from "../../log.js";

import { renderEntry } from "./render-bus.js";

// Classic ESP32 shares the radio between BLE and WiFi; a passive scan
// can take 7-12s. 30s gives headroom; longer = real failure.
const SCAN_TIMEOUT_MS = 30000;

// Auto-retry an empty scan result once. BLE/WiFi coex on classic ESP32
// makes passive scans flaky — the chip occasionally returns 0 entries
// when networks actually exist (especially right after a failed join).
// One retry is the conservative knob: enough to mask the most common
// flake, not so many that we build a positive feedback loop with the
// chip's scan duration.
const MAX_EMPTY_RETRIES = 1;
const RETRY_DELAY_MS = 2500;

function summarize(status) {
  const { st, ssid, err, ip } = status || {};
  // Drop the "Connected to " prefix — the cap label is "WiFi" already, so
  // "WiFi · MyNetwork · 192.168.1.4" reads cleaner than "WiFi · Connected
  // to MyNetwork · ..." and stops the SSID/IP from getting ellipsized at
  // narrow widths.
  if (st === "joined")  return `${ssid || "joined"}${ip ? ` · ${ip}` : ""}`;
  if (st === "joining") return `Joining${ssid ? ` ${ssid}` : ""}…`;
  if (st === "failed")  return `Failed${err ? ` — ${err}` : ""}`;
  return "Not configured";
}

// Inline 4-bar signal strength glyph. r is 0-100. Always renders 4 bars,
// fills the lower N based on strength so a weak network still looks like
// a valid signal indicator (not blank space).
function signalBars(r) {
  const bars = r > 75 ? 4 : r > 50 ? 3 : r > 25 ? 2 : 1;
  let svg = `<svg class="wifi-bars" viewBox="0 0 16 12" aria-label="signal strength ${bars}/4">`;
  for (let i = 0; i < 4; i++) {
    const h = 3 + i * 3;
    const cls = i < bars ? "wifi-bar on" : "wifi-bar off";
    svg += `<rect class="${cls}" x="${i * 4}" y="${12 - h}" width="3" height="${h}"/>`;
  }
  return svg + "</svg>";
}

const LOCK_SVG = `<svg class="wifi-lock" viewBox="0 0 12 14" aria-label="secured"><path d="M3 6V4a3 3 0 0 1 6 0v2h.5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-6a.5.5 0 0 1 .5-.5H3zm1 0h4V4a2 2 0 1 0-4 0v2z"/></svg>`;
const CHECK_SVG = `<svg class="wifi-check" viewBox="0 0 14 14" aria-label="connected"><path d="M5.5 10.4 2.6 7.5l-.9.9 3.8 3.8 7.6-7.6-.9-.9z"/></svg>`;

export function makeWifiScanCap(schema) {
  const { name } = schema;
  const chars = schema.chars || UUIDS_BY_CAP[name];
  const scanField     = `${name}ScanChar`;
  const joinField     = `${name}JoinChar`;
  const statusField   = `${name}StatusChar`;
  const statusState   = `${name}Status`;
  const networksField = `${name}Networks`;
  const scanningField = `${name}Scanning`;
  const scanTimerField = `${name}ScanTimer`;
  const scanStartedField = `${name}ScanStartedAt`;
  const retriesField = `${name}ScanRetries`;
  const actionScan = `${name}-scan`;
  const actionJoin = `${name}-join`;
  const actionManualJoin = `${name}-join-manual`;
  // "wifi" auto-capitalizes to "Wifi" via the default rule; force the correct
  // stylization so the section header matches the collapsed-row pill.
  const label = name === "wifi" ? "WiFi"
    : name.length <= 3 ? name.toUpperCase()
    : name[0].toUpperCase() + name.slice(1);

  function clearScanTimer(entry) {
    if (entry[scanTimerField]) {
      clearTimeout(entry[scanTimerField]);
      entry[scanTimerField] = null;
    }
  }

  async function scan(entry, isRetry = false) {
    if (!entry[scanField]) return;
    clearScanTimer(entry);
    entry[scanningField] = true;
    entry[scanStartedField] = Date.now();
    if (!isRetry) entry[retriesField] = 0;
    renderEntry(entry);
    // Trigger the scan via read; results land via notify (set up in probe()).
    // The read returns whatever's currently cached on the firmware side, which
    // is why we don't clear `scanning` here — fresh results arrive later.
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
      return;
    }
    // Failsafe: if notify never arrives (silent firmware failure, BLE/WiFi
    // contention on classic ESP32), surface a clear timeout instead of an
    // infinite spinner.
    entry[scanTimerField] = setTimeout(() => {
      if (!entry[scanningField]) return;
      entry[scanningField] = false;
      entry[scanTimerField] = null;
      logFor(entry, `${name} scan timed out (${SCAN_TIMEOUT_MS / 1000}s) — try again`);
      renderEntry(entry);
    }, SCAN_TIMEOUT_MS);
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

  // When scan fails (classic ESP32 + BLE coexistence commonly returns zero
  // APs even when networks exist), the user can still join by typing SSID +
  // password directly. Mirrors iOS's "Join Other Network…" affordance.
  // macOS auto-corrects ' / " to curly equivalents (\u2018\u2019\u201C\u201D)
  // inside prompt() dialogs unless the user has Smart Quotes off. Network
  // SSIDs are byte-exact — "Jonas's iPhone" with a curly apostrophe doesn't
  // match the AP's beacon "Jonas's iPhone" with a straight one, and the chip
  // returns ssid_not_found. Normalize before sending so the typed path
  // matches the scan-and-join path.
  function straightenQuotes(s) {
    return (s || "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"');
  }

  async function joinManual(entry) {
    if (!entry[joinField]) return;
    const ssid = straightenQuotes(prompt("Network name (SSID):"));
    if (!ssid) return;
    const password = straightenQuotes(prompt(`Password for "${ssid}" (leave blank for open):`));
    if (password === null) return;
    try {
      await entry[joinField].writeValueWithResponse(encodeJson({ s: ssid, p: password }));
    } catch (err) {
      logFor(entry, `${name} manual join failed: ${err.message}`);
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
      [scanTimerField]: null,
      [scanStartedField]: 0,
      [retriesField]: 0,
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
          const result = decodeJson(e.target.value) || [];
          // BLE/WiFi coex on classic ESP32 returns 0 entries fairly often
          // even when networks exist. Retry silently a couple of times
          // before showing "No networks found" so the user doesn't have
          // to click Scan repeatedly.
          if (result.length === 0
              && entry[scanningField]
              && (entry[retriesField] || 0) < MAX_EMPTY_RETRIES) {
            entry[retriesField] = (entry[retriesField] || 0) + 1;
            logFor(entry, `${name} scan empty — retry ${entry[retriesField]}/${MAX_EMPTY_RETRIES}`);
            setTimeout(() => scan(entry, true), RETRY_DELAY_MS);
            return;
          }
          // Only overwrite networksField when the new result is non-empty
          // OR we had nothing before. Otherwise an empty result after
          // retries would wipe a still-useful cached list (chip's first
          // read response) — the "list appears briefly then disappears"
          // glitch.
          if (result.length > 0 || !entry[networksField] || !entry[networksField].length) {
            entry[networksField] = result;
          }
          entry[scanningField] = false;
          entry[retriesField] = 0;
          clearScanTimer(entry);
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
      clearScanTimer(entry);
    },

    renderSection(entry) {
      if (entry.status !== "connected" || !entry[scanField]) return "";
      const networks = entry[networksField];
      const scanning = entry[scanningField];
      const status = entry[statusState] || {};
      const joinedSsid = status.st === "joined" ? status.ssid : null;
      // Three distinct list states:
      //   networks=[...non-empty]       → render the list
      //   scanning=true                 → spinner + "Looking…"
      //   networks=[] (empty array)     → "No networks found" (we did scan,
      //                                    firmware just returned nothing)
      //   networks=null (never scanned) → nothing
      const networkRows = networks && networks.length
        ? networks.map(n => {
            const isJoined = n.s === joinedSsid;
            // Joined rows: tint + check svg encode the state; meta would echo.
            // Other rows: show Open/Secured (genuine info, not in any visual).
            const metaHtml = isJoined ? "" :
              `<div class="wifi-meta">${n.p ? "Secured" : "Open"}</div>`;
            const action = isJoined
              ? `<span class="wifi-status-tag">${CHECK_SVG}</span>`
              : `<button class="secondary sm" data-action="${actionJoin}" data-ssid="${escapeHtml(n.s)}" data-secured="${n.p ? 1 : 0}">Join</button>`;
            return `
              <li class="wifi-row${isJoined ? " joined" : ""}">
                ${signalBars(n.r)}
                <div class="wifi-text">
                  <div class="wifi-ssid">${escapeHtml(n.s)}</div>
                  ${metaHtml}
                </div>
                ${n.p ? LOCK_SVG : ""}
                ${action}
              </li>
            `;
          }).join("")
        : scanning
          ? `<li class="wifi-row wifi-row-status"><span class="wifi-spinner"></span> Looking for networks…</li>`
          : Array.isArray(networks)
            ? `<li class="wifi-row wifi-row-status">No networks found — try again.</li>`
            : "";
      const otherRow = `
        <li class="wifi-row wifi-row-other" data-action="${actionManualJoin}" role="button" tabindex="0">
          <svg class="icon-svg wifi-row-other-icon" aria-hidden="true"><use href="icons.svg#icon-plus"/></svg>
          <div class="wifi-text">
            <div class="wifi-ssid">Join other network…</div>
          </div>
        </li>
      `;
      const nets = `<ul class="wifi-list">${networkRows}${otherRow}</ul>`;
      return capSection({
        name,
        label,
        state: summarize(entry[statusState]),
        action: `<button class="secondary sm" data-action="${actionScan}" ${scanning ? "disabled" : ""}>
          ${scanning ? `<span class="wifi-spinner"></span> Scanning…` : "Scan"}
        </button>`,
        body: nets,
        transport: "ble",
      });
    },

    wireActions(entry, node) {
      const scanBtn = node.querySelector(`[data-action="${actionScan}"]`);
      if (scanBtn) scanBtn.addEventListener("click", () => scan(entry));
      const manualRow = node.querySelector(`[data-action="${actionManualJoin}"]`);
      if (manualRow) {
        manualRow.addEventListener("click", () => joinManual(entry));
        manualRow.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); joinManual(entry); }
        });
      }
      node.querySelectorAll(`[data-action="${actionJoin}"]`).forEach(btn => {
        btn.addEventListener("click", () => join(
          entry, btn.dataset.ssid, btn.dataset.secured === "1",
        ));
      });
    },
  };
}
