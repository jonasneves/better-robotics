// Per-hostname sudo-password store. Populated during Customize-card when
// the user leaves the password field blank — dashboard generates a random
// one and keeps a copy so it's recoverable later (SSH uses the key, but
// sudo / su still needs a password).
import { $, escapeHtml } from "./dom.js";

const KEY = "better-robotics:passwords";

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); }
  catch { return {}; }
}
function write(obj) {
  try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch {}
}

export function listPasswords() {
  return Object.entries(read())
    .map(([hostname, v]) => ({
      hostname,
      password: typeof v === "string" ? v : v.password,
      createdAt: (typeof v === "object" ? v.createdAt : 0) || 0,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function removePassword(hostname) {
  const all = read();
  delete all[hostname];
  write(all);
  window.dispatchEvent(new CustomEvent("br:password-change"));
}

// 96 bits of entropy as 24 hex chars. Readable, typable, same across all
// platforms / locales. Plenty of room against brute-force even online.
function generatePassword() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function ensurePassword(hostname) {
  const all = read();
  const existing = all[hostname];
  if (existing) return typeof existing === "string" ? existing : existing.password;
  const password = generatePassword();
  all[hostname] = { password, createdAt: Date.now() };
  write(all);
  window.dispatchEvent(new CustomEvent("br:password-change"));
  return password;
}

export function initPasswordsUI() {
  const host = $("passwords-list");
  if (!host) return;
  const render = () => {
    const items = listPasswords();
    if (items.length === 0) {
      host.innerHTML = `<div class="meta">None yet — generated when you leave the password blank in Customize card.</div>`;
      return;
    }
    host.innerHTML = items.map(i => `
      <div class="pwd-entry">
        <div class="pwd-info">
          <div class="pwd-host">${escapeHtml(i.hostname)}</div>
          <div class="meta pwd-value">${escapeHtml(i.password)}</div>
        </div>
        <div class="pwd-actions">
          <button class="secondary sm" data-host="${escapeHtml(i.hostname)}" data-action="copy">Copy</button>
          <button class="secondary sm" data-host="${escapeHtml(i.hostname)}" data-action="delete">Forget</button>
        </div>
      </div>
    `).join("");
    host.querySelectorAll('[data-action="copy"]').forEach(btn => {
      btn.addEventListener("click", async () => {
        const entry = listPasswords().find(i => i.hostname === btn.dataset.host);
        if (!entry) return;
        try {
          await navigator.clipboard.writeText(entry.password);
          const prev = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(() => { btn.textContent = prev; }, 1500);
        } catch {}
      });
    });
    host.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener("click", () => {
        const hostname = btn.dataset.host;
        if (!confirm(`Forget the sudo password for ${hostname}?`)) return;
        removePassword(hostname);
      });
    });
  };
  render();
  window.addEventListener("br:password-change", render);
}
