// Schema: { name: "flash", char: "…da3", type: "level", range: [0, 100] }
// 1-byte payload [0..100]; firmware applies as PWM duty. Today: ESP32
// white flash LED; generic enough for any single-axis brightness cap.
//
// Drop-intermediate-values matches signed-pair: slider drag fires faster
// than BLE writes complete, so we keep the latest pending and flush after
// each in-flight write resolves. Without it, dragging stalls with
// "GATT operation already in progress".

import { UUIDS_BY_CAP } from "../../ble.js";
import { logFor } from "../../log.js";
import { capSection } from "./cap-section.js";

import { renderEntry } from "./render-bus.js";

export async function setLevelValue(entry, capName, value) {
  const ch = entry[`${capName}Char`];
  if (!ch) return;
  const range = entry.capSchema?.find(s => s.name === capName)?.range || [0, 100];
  const [mn, mx] = range;
  const v = Math.max(mn, Math.min(mx, Math.round(Number(value) || 0)));
  entry[`${capName}Pending`] = v;
  if (entry[`${capName}Sending`]) return;
  entry[`${capName}Sending`] = true;
  try {
    while (entry[`${capName}Pending`] != null) {
      const next = entry[`${capName}Pending`];
      entry[`${capName}Pending`] = null;
      try {
        await ch.writeValueWithResponse(Uint8Array.of(next & 0xff));
      } catch (err) {
        logFor(entry, `${capName} write failed: ${err.message}`);
        break;
      }
    }
  } finally {
    entry[`${capName}Sending`] = false;
  }
}

export function makeLevelCap(schema) {
  const { name } = schema;
  const char = schema.char || UUIDS_BY_CAP[name];
  const charField = `${name}Char`;
  const valueField = `${name}Level`;
  const action = `level-${name}`;
  const range = schema.range || [0, 100];
  const label = name.length <= 3 ? name.toUpperCase()
    : name[0].toUpperCase() + name.slice(1);

  return {
    name,
    schema,
    initEntry: () => ({
      [charField]: null,
      [valueField]: 0,
      [`${name}Sending`]: false,
      [`${name}Pending`]: null,
    }),

    async probe(entry, service) {
      try {
        const ch = await service.getCharacteristic(char);
        entry[charField] = ch;
        const v = await ch.readValue();
        entry[valueField] = v.getUint8(0);
        await ch.startNotifications();
        ch.addEventListener("characteristicvaluechanged", (e) => {
          entry[valueField] = e.target.value.getUint8(0);
          // Surgical patch — slider echoes back on every confirm; full
          // re-render would jump the thumb mid-drag.
          const sec = entry.node?.querySelector(`.cap-section[data-cap-name="${name}"]`);
          if (sec) {
            const stateEl = sec.querySelector(".cap-state");
            if (stateEl) stateEl.textContent = `${entry[valueField]}%`;
            const sl = sec.querySelector(`input[data-action="${action}"]`);
            // Only move the thumb when the user isn't dragging.
            if (sl && document.activeElement !== sl) sl.value = entry[valueField];
          } else {
            renderEntry(entry);
          }
        });
      } catch {
        entry[charField] = null;
      }
    },

    cleanup(entry) {
      entry[charField] = null;
      entry[`${name}Sending`] = false;
      entry[`${name}Pending`] = null;
    },

    renderSection(entry) {
      if (entry.status !== "connected" || !entry[charField]) return "";
      const v = entry[valueField] || 0;
      return capSection({
        name,
        label,
        state: `${v}%`,
        action: `<input type="range" class="level-slider" data-action="${action}"
                   min="${range[0]}" max="${range[1]}" value="${v}">`,
        transport: "ble",
      });
    },

    wireActions(entry, node) {
      const sl = node.querySelector(`input[data-action="${action}"]`);
      if (!sl) return;
      sl.addEventListener("input", () => setLevelValue(entry, name, sl.value));
    },
  };
}
