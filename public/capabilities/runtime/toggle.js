// Schema: { name: "led", char: "…d92", type: "toggle" }
// State on entry[<name>Char] (BLE handle) + entry[<name>On] (bool); back-
// compat with the prior hand-written LED module's entry.ledOn.
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
          // Surgical patch — toggles fire on click + firmware confirm;
          // full re-render flashes the card. Update only the button label.
          const sec = entry.node?.querySelector(`.cap-section[data-cap-name="${name}"]`);
          if (sec) {
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

    renderSection(entry) {
      if (entry.status !== "connected" || !entry[charField]) return "";
      const on = entry[onField];
      return capSection({
        name,
        label,
        action: `<button class="secondary sm" data-action="${action}">${on ? "Turn off" : "Turn on"}</button>`,
        transport: "ble",
      });
    },

    wireActions(entry, node) {
      const btn = node.querySelector(`[data-action="${action}"]`);
      if (btn) btn.addEventListener("click", () => toggleCapValue(entry, name));
    },
  };
}
