// Expected schema shape:
//   { name: "led", char: "…d92", type: "toggle" }
// State lives on `entry[<name>Char]` (BLE handle) and `entry[<name>On]` (bool);
// anything reading `entry.ledOn` from the previous hand-written LED module keeps working.
import { UUIDS_BY_CAP } from "../../ble.js";
import { logFor } from "../../log.js";
import { capSection } from "./cap-section.js";

import { renderEntry } from "./render-bus.js";

export async function setToggleValue(entry, capName, value) {
  const ch = entry[`${capName}Char`];
  if (!ch) return;
  try {
    await ch.writeValueWithResponse(Uint8Array.of(value ? 1 : 0));
    entry[`${capName}On`] = !!value;
    renderEntry(entry);
  } catch (err) {
    logFor(entry, `${capName} write failed: ${err.message}`);
  }
}

export async function toggleCapValue(entry, capName) {
  return setToggleValue(entry, capName, !entry[`${capName}On`]);
}

export function makeToggleCap(schema) {
  const { name } = schema;
  const char = schema.char || UUIDS_BY_CAP[name];
  const charField = `${name}Char`;
  const onField = `${name}On`;
  const action = `toggle-${name}`;
  const label = name.length <= 3 ? name.toUpperCase()
    : name[0].toUpperCase() + name.slice(1);

  return {
    name,
    schema,
    initEntry: () => ({ [charField]: null, [onField]: false }),

    async probe(entry, service) {
      try {
        const ch = await service.getCharacteristic(char);
        entry[charField] = ch;
        const v = await ch.readValue();
        entry[onField] = v.getUint8(0) !== 0;
        await ch.startNotifications();
        ch.addEventListener("characteristicvaluechanged", (e) => {
          entry[onField] = e.target.value.getUint8(0) !== 0;
          // Surgical patch instead of renderEntry — toggles fire on every
          // user click + on firmware confirm; full re-render flashes the
          // card. Update only the cap-state text + button label in place.
          const sec = entry.node?.querySelector(`.cap-section[data-cap-name="${name}"]`);
          if (sec) {
            const stateEl = sec.querySelector(".cap-state");
            if (stateEl) stateEl.textContent = entry[onField] ? "on" : "off";
            const btn = sec.querySelector(`[data-action="${action}"]`);
            if (btn) btn.textContent = entry[onField] ? "Turn off" : "Turn on";
          } else {
            renderEntry(entry);  // section not in DOM yet — full render
          }
          logFor(entry, `${name} → ${entry[onField] ? "on" : "off"}`);
        });
      } catch {
        entry[charField] = null;
      }
    },

    cleanup(entry) { entry[charField] = null; },

    renderSection(entry, { sourceMember = null, alternativeMemberIds = [] } = {}) {
      if (entry.status !== "connected" || !entry[charField]) return "";
      const on = entry[onField];
      return capSection({
        name,
        label,
        state: on ? "on" : "off",
        action: `<button class="secondary sm" data-action="${action}">${on ? "Turn off" : "Turn on"}</button>`,
        sourceMember, alternativeMemberIds,
      });
    },

    wireActions(entry, node) {
      const btn = node.querySelector(`[data-action="${action}"]`);
      if (btn) btn.addEventListener("click", () => toggleCapValue(entry, name));
    },
  };
}
