// Expected schema shape:
//   { name: "snapshot", type: "ble-snapshot" }
// Pairs a write-trigger char with a notify-out chunked stream. Same envelope
// the OTA path uses (just outbound here): 0x01 begin+u32 len, 0x02 chunk,
// 0x03 commit, 0xff err+text. ~10-30 KB JPEG over BLE → ~1-2s per shot.
import { UUIDS_BY_CAP } from "../../ble.js";
import { escapeHtml } from "../../dom.js";
import { logFor } from "../../log.js";
import { capSection, setOpen } from "./cap-section.js";

import { renderEntry } from "./render-bus.js";

export function makeBleSnapshotCap(schema) {
  const { name } = schema;
  const chars = schema.chars || UUIDS_BY_CAP[name];
  const reqChar  = chars.request;
  const dataChar = chars.data;
  const reqField    = `${name}ReqChar`;
  const dataField   = `${name}DataChar`;
  const bufField    = `${name}Buf`;       // accumulator
  const totalField  = `${name}Total`;     // expected size from begin opcode
  const recvField   = `${name}Recv`;      // bytes received so far
  const urlField    = `${name}Url`;       // last successful data URL
  const errField    = `${name}Err`;
  const busyField   = `${name}Busy`;      // a transfer is in flight
  const watchdogField = `${name}Watchdog`; // timer id for stall detection
  const action      = `${name}-take`;
  // Firmware notify is fire-and-forget — if a chunk or commit drops, the
  // dashboard waits forever. Reset this watchdog on any progress; if it
  // fires, the transfer is dead. 4 s covers expected 25 ms × 50 chunks
  // for a typical JPEG, with margin for the connection-interval jitter.
  const STALL_MS = 4000;
  const label = name[0].toUpperCase() + name.slice(1);

  return {
    name,
    schema,
    initEntry: () => ({
      [reqField]: null, [dataField]: null,
      [bufField]: null, [totalField]: 0, [recvField]: 0,
      [urlField]: null, [errField]: null, [busyField]: false,
      [watchdogField]: null,
    }),

    async probe(entry, service) {
      const armWatchdog = () => {
        if (entry[watchdogField]) clearTimeout(entry[watchdogField]);
        entry[watchdogField] = setTimeout(() => {
          if (!entry[busyField]) return;
          entry[errField] = `stalled at ${entry[recvField]}/${entry[totalField]} B (chunks dropped — retry)`;
          entry[bufField] = null;
          entry[busyField] = false;
          entry[watchdogField] = null;
          logFor(entry, `snapshot: ${entry[errField]}`);
          renderEntry(entry);
        }, STALL_MS);
      };
      const clearWatchdog = () => {
        if (entry[watchdogField]) { clearTimeout(entry[watchdogField]); entry[watchdogField] = null; }
      };
      try {
        entry[reqField]  = await service.getCharacteristic(reqChar);
        entry[dataField] = await service.getCharacteristic(dataChar);
        await entry[dataField].startNotifications();
        entry[dataField].addEventListener("characteristicvaluechanged", (e) => {
          const data = new Uint8Array(e.target.value.buffer);
          if (data.length === 0) return;
          const op = data[0];
          if (op === 0x01 && data.length >= 5) {
            // begin: u32 BE total
            const total = (data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4];
            entry[bufField] = new Uint8Array(total);
            entry[totalField] = total;
            entry[recvField] = 0;
            entry[errField] = null;
            entry[busyField] = true;
            armWatchdog();
            renderEntry(entry);
          } else if (op === 0x02 && entry[bufField]) {
            const payload = data.subarray(1);
            const room = entry[totalField] - entry[recvField];
            const take = Math.min(payload.length, room);
            entry[bufField].set(payload.subarray(0, take), entry[recvField]);
            entry[recvField] += take;
            armWatchdog();
            // Patch progress text in place — full renderEntry per chunk
            // (every ~25 ms) destroys the camera <img> and forces the MJPEG
            // stream to reconnect on every byte. Surgical update keeps the
            // stream uninterrupted during a snapshot.
            const sec = entry.node?.querySelector(`.cap-section[data-cap-name="${name}"]`);
            const stateEl = sec?.querySelector(".cap-state");
            if (stateEl) {
              stateEl.textContent = `${entry[recvField]} / ${entry[totalField]} B`;
            } else {
              renderEntry(entry);
            }
          } else if (op === 0x03 && entry[bufField]) {
            // commit: turn the accumulated bytes into a data URL we can <img>.
            // The protocol is JPEG-only on the firmware side; assume it.
            clearWatchdog();
            const blob = new Blob([entry[bufField]], { type: "image/jpeg" });
            // Revoke prior url so we don't accumulate refs across snapshots.
            if (entry[urlField]) URL.revokeObjectURL(entry[urlField]);
            entry[urlField] = URL.createObjectURL(blob);
            entry[bufField] = null;
            entry[busyField] = false;
            logFor(entry, `snapshot: ${entry[recvField]} bytes`);
            // Auto-expand the snapshot section so the resulting <img> is
            // visible without an extra tap. Default-collapsed caps would
            // otherwise hide the photo behind the disclosure.
            setOpen(name, true);
            renderEntry(entry);
          } else if (op === 0xff) {
            clearWatchdog();
            const msg = new TextDecoder().decode(data.subarray(1));
            entry[errField] = msg || "snapshot failed";
            entry[bufField] = null;
            entry[busyField] = false;
            logFor(entry, `snapshot error: ${entry[errField]}`);
            renderEntry(entry);
          }
        });
      } catch {
        entry[reqField] = entry[dataField] = null;
      }
    },

    cleanup(entry) {
      if (entry[watchdogField]) { clearTimeout(entry[watchdogField]); entry[watchdogField] = null; }
      if (entry[urlField]) { URL.revokeObjectURL(entry[urlField]); entry[urlField] = null; }
      entry[reqField] = entry[dataField] = null;
      entry[bufField] = null;
      entry[busyField] = false;
    },

    renderSection(entry) {
      if (entry.status !== "connected" || !entry[reqField]) return "";
      const busy = entry[busyField];
      const url = entry[urlField];
      const err = entry[errField];
      const progress = busy && entry[totalField]
        ? `${entry[recvField]} / ${entry[totalField]} B`
        : "";
      // Drop the "BLE-only" label — implementation detail. State shows
      // empty when idle, "capturing N/M B" when busy. The button text
      // already conveys the action.
      const stateText = busy ? (progress || "capturing…") : "";
      const img = url
        ? `<img class="robot-camera" src="${escapeHtml(url)}" alt="snapshot">`
        : "";
      const errLine = err ? `<div class="meta" style="color:var(--danger);">${escapeHtml(err)}</div>` : "";
      return capSection({
        name,
        label,
        state: stateText,
        action: `<button class="secondary sm" data-action="${action}" ${busy ? "disabled" : ""}>${busy ? "Capturing…" : "Take photo"}</button>`,
        body: `${img}${errLine}`,
        transport: "ble",
      });
    },

    wireActions(entry, node) {
      const btn = node.querySelector(`[data-action="${action}"]`);
      if (!btn) return;
      btn.addEventListener("click", async () => {
        if (!entry[reqField] || entry[busyField]) return;
        entry[errField] = null;
        try {
          await entry[reqField].writeValueWithResponse(Uint8Array.of(0x01));
        } catch (err) {
          entry[errField] = err.message || String(err);
          renderEntry(entry);
        }
      });
    },
  };
}
