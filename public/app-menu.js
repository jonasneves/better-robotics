// Shared chrome wiring for the BetterRobotics app menu. Both index.html
// (dashboard) and phone.html host the same dropdown — Install / Check for
// updates / Hard refresh — and each had grown its own near-identical copy
// of the destructive flow + SW update latch + PWA install handlers. This
// module is the single owner.
//
// Per-page differences (positioning, surface-specific items) stay in
// each page's own wiring; shared destructive / update / install logic
// lives here.

// ── PWA install ────────────────────────────────────────────────────────

let _deferredInstallPrompt = null;

export function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches
      || window.navigator.standalone === true;
}
export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

// Module-top listeners: beforeinstallprompt fires once, very early
// (before DOMContentLoaded in Chrome). Lost if not caught here.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  _refreshInstallVisibility();
});
window.addEventListener("appinstalled", () => {
  _deferredInstallPrompt = null;
  _refreshInstallVisibility();
});

let _installBtnId = null;
function _refreshInstallVisibility() {
  if (!_installBtnId) return;
  const btn = document.getElementById(_installBtnId);
  if (!btn) return;
  if (isStandalone()) { btn.hidden = true; return; }
  btn.hidden = !(_deferredInstallPrompt || isIOS());
}

// Wire the "Install on this device" menu item. Caller specifies the
// button id and (optionally) the iOS popover id to show when iOS Safari
// users tap it (Chrome/Android use the deferred prompt).
export function wireInstallMenuItem({ btnId, iosPopoverId, onClick }) {
  _installBtnId = btnId;
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    onClick?.();
    if (_deferredInstallPrompt) {
      _deferredInstallPrompt.prompt();
      try { await _deferredInstallPrompt.userChoice; } catch {}
      _deferredInstallPrompt = null;
      _refreshInstallVisibility();
      return;
    }
    if (isIOS() && iosPopoverId) {
      const pop = document.getElementById(iosPopoverId);
      if (pop?.showPopover) pop.showPopover();
    }
  });
  _refreshInstallVisibility();
}

// ── Service worker + Check-for-updates ─────────────────────────────────

// Set when the user clicks "Check for updates" — the explicit click is
// already an opt-in to apply, so the next install skipWaiting + reloads
// instead of asking again via a deferred banner. Cleared after handling.
let _autoApplyOnNextSwInstall = false;
let _swReloading = false;

// Register the service worker + wire the two paths a new SW can land:
//   - explicit user "Check for updates" → auto-apply (caller sets the latch)
//   - background detection → optional callback (caller may show a banner)
//
// Returns nothing — caller doesn't need a handle. Idempotent across
// repeated calls but only one registration sticks.
export function setupServiceWorker({ swPath = "sw.js", onUnsolicitedUpdate } = {}) {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register(swPath).then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) {
      onUnsolicitedUpdate?.(reg.waiting);
    }
    reg.addEventListener("updatefound", () => {
      const next = reg.installing;
      next?.addEventListener("statechange", () => {
        if (next.state === "installed" && navigator.serviceWorker.controller) {
          if (_autoApplyOnNextSwInstall) {
            _autoApplyOnNextSwInstall = false;
            next.postMessage("skip-waiting");  // controllerchange reloads
          } else {
            onUnsolicitedUpdate?.(next);
          }
        }
      });
    });
  }).catch((err) => console.warn("[sw] register failed:", err.message));
  // controllerchange → reload so all in-memory state matches the active
  // version. Guard prevents double-reload if the listener fires twice.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (_swReloading) return;
    _swReloading = true;
    window.location.reload();
  });
}

// Wire the Check-for-updates menu item. Auto-applies any update found via
// the explicit-click path; falls through to "Up to date" if nothing's new.
export function wireCheckUpdatesMenuItem({ btnId }) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (!reg) throw new Error("no-sw");
      // Already-waiting worker: apply directly. Happens when an earlier
      // page load installed it and the user dismissed the banner.
      if (reg.waiting) {
        btn.textContent = "Updating…";
        reg.waiting.postMessage("skip-waiting");
        return;  // controllerchange reloads
      }
      _autoApplyOnNextSwInstall = true;
      await reg.update();
      if (reg.installing || reg.waiting) {
        btn.textContent = "Updating…";  // reload follows shortly
        return;
      }
      _autoApplyOnNextSwInstall = false;
      btn.textContent = "Up to date";
    } catch {
      _autoApplyOnNextSwInstall = false;
      btn.textContent = "Up to date";
    }
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2000);
  });
}

// ── Hard refresh ───────────────────────────────────────────────────────

// Wire the hard-refresh dialog + confirm flow. Both surfaces had
// byte-for-byte the same destructive sequence; this is the single owner.
// The body of the dialog (which items get cleared) stays per-page in HTML
// since the phone storage profile differs from the dashboard's.
export function wireHardRefresh({
  openBtnId, dialogId, closeBtnId, cancelBtnId, confirmBtnId,
  onBeforeOpen,
}) {
  const dialog = document.getElementById(dialogId);
  const open  = document.getElementById(openBtnId);
  const close = document.getElementById(closeBtnId);
  const cancel = document.getElementById(cancelBtnId);
  const confirm = document.getElementById(confirmBtnId);
  if (!dialog || !open || !confirm) return;
  open.addEventListener("click", () => { onBeforeOpen?.(); dialog.showModal(); });
  close?.addEventListener("click", () => dialog.close());
  cancel?.addEventListener("click", () => dialog.close());
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    confirm.textContent = "Clearing…";
    try {
      // Capture the SW's known asset URLs *before* nuking the cache. After
      // the destructive phase, we re-fetch each with cache: 'reload' to
      // bypass the browser's HTTP cache (the layer below the SW that
      // location.reload() doesn't flush) — that's the gap that made layout
      // changes survive a previous hard-refresh. Chrome's "Clear site
      // data" wipes both layers; this gets close.
      const sameOriginAssets = [];
      if (self.caches) {
        try {
          const names = await caches.keys();
          for (const n of names) {
            const c = await caches.open(n);
            const reqs = await c.keys();
            for (const r of reqs) {
              if (new URL(r.url).origin === location.origin) sameOriginAssets.push(r.url);
            }
          }
        } catch {}
      }
      // Best-effort: run each step independently so one failure doesn't
      // block the others. Order is intentional — kill the SW first so the
      // reload below can't be intercepted by a stale worker.
      const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
      await Promise.allSettled(regs.map(r => r.unregister()));
      if (self.caches) {
        const names = await caches.keys();
        await Promise.allSettled(names.map(n => caches.delete(n)));
      }
      if (indexedDB.databases) {
        const dbs = await indexedDB.databases();
        await Promise.allSettled(dbs.map(d => new Promise((res) => {
          if (!d.name) return res();
          const req = indexedDB.deleteDatabase(d.name);
          req.onsuccess = req.onerror = req.onblocked = () => res();
        })));
      }
      // Origin Private File System: not used by the app today (the SD-prep
      // flow uses File System Access on a user-picked directory, not OPFS),
      // but if anything ever lands here it would survive every other clear.
      try {
        if (navigator.storage?.getDirectory) {
          const root = await navigator.storage.getDirectory();
          const names = [];
          for await (const [name] of root.entries()) names.push(name);
          await Promise.allSettled(names.map(n => root.removeEntry(n, { recursive: true })));
        }
      } catch {}
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      // Cookies — best-effort. JS can't see HttpOnly cookies; for the rest,
      // expire each at root and current path.
      try {
        for (const c of document.cookie.split(";")) {
          const eq = c.indexOf("=");
          const name = (eq > -1 ? c.substr(0, eq) : c).trim();
          if (!name) continue;
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=${location.pathname}`;
        }
      } catch {}
      // Pre-warm the HTTP cache with fresh copies of every known asset.
      // cache: 'reload' is the only documented way to force a same-origin
      // fetch past the browser's HTTP disk cache without server cooperation.
      const pageUrl = new URL("./", location.href).toString();
      const all = new Set([pageUrl, location.href, ...sameOriginAssets]);
      confirm.textContent = "Refetching…";
      await Promise.allSettled(
        [...all].map(u => fetch(u, { cache: "reload" }).catch(() => {})),
      );
    } finally {
      // replace(pathname) instead of reload() so query params and hash
      // don't survive — a hard refresh that lands you back on the same
      // ?debug=1 isn't fully clean. pathname is preserved so phone.html
      // stays on phone.html and the dashboard stays on the dashboard.
      location.replace(location.pathname);
    }
  });
}

// ── Report-issue diagnostic body ───────────────────────────────────────

// Build a GitHub issue URL with the running version + UA + URL prefilled.
// Both surfaces benefit (the phone arguably more, since the user can't
// easily type their UA by hand). Caller passes the version (read from
// sw.js) and the anchor element to update.
export function setReportIssueLink(anchor, version) {
  if (!anchor) return;
  const body = [
    "<!-- Describe what happened, what you expected, and how to reproduce. -->",
    "",
    "",
    "---",
    "<details><summary>Diagnostic info</summary>",
    "",
    `- Version: \`${version}\``,
    `- URL: \`${window.location.href}\``,
    `- User-Agent: \`${navigator.userAgent}\``,
    "",
    "</details>",
  ].join("\n");
  anchor.href = `https://github.com/jonasneves/better-robotics/issues/new?body=${encodeURIComponent(body)}`;
}

// Wire the Diagnostics dialog. Three per-session actions: reload with
// ?debug, run a unilateral STUN probe, capture last-pair-diagnostic
// snapshot. Output renders inline in a <pre>. Nothing persists —
// debug logs come back via reload, the rest are read-only inspections.
// Same shape on both desktop and phone (DEV.md describes each handle).
export function wireDiagnosticsMenuItem({
  openBtnId, dialogId, closeBtnId,
  debugBtnId, probeBtnId, pairBtnId, outputId,
  onBeforeOpen,
}) {
  const dialog = document.getElementById(dialogId);
  const open  = document.getElementById(openBtnId);
  const close = document.getElementById(closeBtnId);
  const debug = document.getElementById(debugBtnId);
  const probe = document.getElementById(probeBtnId);
  const pair  = document.getElementById(pairBtnId);
  const out   = document.getElementById(outputId);
  if (!dialog || !open) return;
  open.addEventListener("click", () => { onBeforeOpen?.(); dialog.showModal(); });
  close?.addEventListener("click", () => dialog.close());

  const show = (obj) => {
    if (!out) return;
    out.style.display = "block";
    out.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  };

  debug?.addEventListener("click", () => {
    // Append ?debug if not already present, preserving existing query
    // and hash. Reload kicks pairing.js's URL-flag check, which surfaces
    // the floating log panel.
    const url = new URL(window.location.href);
    if (!/\bdebug\b/.test(url.search + url.hash)) {
      url.searchParams.set("debug", "1");
    }
    window.location.href = url.toString();
  });

  probe?.addEventListener("click", async () => {
    if (typeof window.probeNetwork !== "function") {
      show("probeNetwork() not loaded — pairing.js failed to import?");
      return;
    }
    show("Running STUN probe…");
    try { show(await window.probeNetwork({ timeoutMs: 4000 })); }
    catch (err) { show("probe failed: " + (err.message || err)); }
  });

  pair?.addEventListener("click", async () => {
    if (typeof window.lastPairDiagnostic !== "function") {
      show("lastPairDiagnostic() not loaded — pairing.js failed to import?");
      return;
    }
    show("Capturing pair diagnostic + getStats()…");
    try {
      const snap = await window.lastPairDiagnostic();
      if (!snap.role) { show("No pair attempt yet this session — open a robot card first."); return; }
      show(snap);
    } catch (err) { show("snapshot failed: " + (err.message || err)); }
  });
}

// Read VERSION from sw.js — CI stamps it on every dashboard-asset change.
// Used both for the menu-meta display and the issue-body diagnostic.
export async function readSwVersion() {
  try {
    const t = await fetch("sw.js").then(r => r.ok ? r.text() : "");
    const m = t.match(/VERSION\s*=\s*"([^"]+)"/);
    return m ? m[1] : "unknown";
  } catch { return "unknown"; }
}
