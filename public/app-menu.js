// Shared app-menu chrome for index.html + phone.html. Owns Install /
// Check for updates / Hard refresh + the SW update latch + PWA install
// handlers. Per-page positioning + surface-specific items stay in each
// page's own wiring.

// ── PWA install ────────────────────────────────────────────────────────

let _deferredInstallPrompt = null;

export function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches
      || window.navigator.standalone === true;
}
export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

// Module-top listener: beforeinstallprompt fires once, before
// DOMContentLoaded in Chrome. Lost if not caught here.
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

// Caller passes button id + optional iOS popover id (shown when iOS
// Safari users tap; Chrome/Android use the deferred prompt).
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

// Auto-applies any update found via the explicit-click path; falls
// through to "Up to date" if nothing's new.
export function wireCheckUpdatesMenuItem({ btnId }) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  // Swap the label-span's text, not the button's: setting btn.textContent
  // wipes the icon SVG along with the label, and the icon never comes back
  // (we only capture the original *text*, not the original DOM).
  const label = btn.querySelector(".menu-item-label") || btn;
  btn.addEventListener("click", async () => {
    const original = label.textContent;
    btn.disabled = true;
    label.textContent = "Checking…";
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (!reg) throw new Error("no-sw");
      // Already-waiting worker: apply directly. Happens when an earlier
      // page load installed it and the user dismissed the banner.
      if (reg.waiting) {
        label.textContent = "Updating…";
        reg.waiting.postMessage("skip-waiting");
        return;  // controllerchange reloads
      }
      _autoApplyOnNextSwInstall = true;
      await reg.update();
      if (reg.installing || reg.waiting) {
        label.textContent = "Updating…";  // reload follows shortly
        return;
      }
      _autoApplyOnNextSwInstall = false;
      label.textContent = "Up to date";
    } catch {
      _autoApplyOnNextSwInstall = false;
      label.textContent = "Up to date";
    }
    setTimeout(() => { label.textContent = original; btn.disabled = false; }, 2000);
  });
}

// ── Hard refresh ───────────────────────────────────────────────────────

// Single owner of the destructive sequence. Dialog body (which items get
// cleared) stays per-page in HTML since phone + dashboard storage profiles
// differ; surrounding chrome ids are shared.
export function wireHardRefresh({ onBeforeOpen } = {}) {
  const dialog = document.getElementById("hard-refresh-dialog");
  const open = document.getElementById("menu-hard-refresh");
  const close = document.getElementById("hard-refresh-close");
  const cancel = document.getElementById("hard-refresh-cancel");
  const confirm = document.getElementById("hard-refresh-confirm");
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
      // don't survive — a hard refresh that lands you back on stale URL
      // flags isn't fully clean. pathname is preserved so phone.html
      // stays on phone.html and the dashboard stays on the dashboard.
      location.replace(location.pathname);
    }
  });
}

// ── Report-issue diagnostic body ───────────────────────────────────────

// Build a GitHub issue URL prefilled with version + UA + URL + recent
// console errors. Errors are read at click time (mousedown/pointerdown/
// focus) so anything captured between page-load and the click lands in
// the body. The body includes a review notice — GitHub issues are public,
// so the user can edit before submitting.
export function setReportIssueLink(anchor, version) {
  if (!anchor) return;
  // ~4KB cap on the error block keeps the URL well under GitHub's ~8KB
  // limit. Keep the most recent (likely related to the bug); drop older.
  const ERROR_CHARS_MAX = 4000;
  function buildErrorBlock() {
    let entries = [];
    try {
      entries = (typeof window.__getCapturedErrors === "function" && window.__getCapturedErrors()) || [];
    } catch { /* capture is best-effort */ }
    if (!entries.length) return "";
    let formatted = entries.map(e =>
      `[${e.t}] ${e.level}${e.source ? ` (${e.source})` : ""}: ${e.message}`
    ).join("\n\n");
    if (formatted.length > ERROR_CHARS_MAX) {
      formatted = "…(older entries truncated)…\n\n" + formatted.slice(formatted.length - ERROR_CHARS_MAX);
    }
    return [
      "",
      "#### Recent console errors",
      "",
      "```",
      formatted,
      "```",
      "",
    ].join("\n");
  }
  function buildBody() {
    return [
      "<!-- Describe what happened, what you expected, and how to reproduce. -->",
      "",
      "",
      "---",
      "> **Please review the diagnostic info below before submitting.** GitHub issues are public — remove any URLs, error messages, or browser details you don't want to share.",
      "",
      "<details><summary>Diagnostic info</summary>",
      "",
      `- Version: \`${version}\``,
      `- URL: \`${window.location.href}\``,
      `- User-Agent: \`${navigator.userAgent}\``,
      buildErrorBlock(),
      "</details>",
    ].join("\n");
  }
  function refresh() {
    anchor.href = `https://github.com/jonasneves/better-robotics/issues/new?body=${encodeURIComponent(buildBody())}`;
  }
  refresh();
  // Refresh just-in-time so any errors that happened between page load
  // and the click land in the body. pointerdown covers mouse + touch +
  // pen; focus covers keyboard activation. Both fire before the actual
  // navigation, so middle-click / right-click "open in new tab" still
  // gets a fresh URL.
  anchor.addEventListener("pointerdown", refresh);
  anchor.addEventListener("focus", refresh);
}

// One capture combines a STUN probe, the last pair attempt's snapshot
// (lastPairDiagnostic + getStats), and connected-robot telemetry into one
// object. Refresh re-runs; Copy puts JSON on clipboard. Same dialog HTML
// on desktop and phone, so element ids are shared chrome.
export function wireDiagnosticsMenuItem({ getTelemetrySources, onBeforeOpen } = {}) {
  const dialog  = document.getElementById("diagnostics-dialog");
  const open    = document.getElementById("menu-diagnostics");
  const close   = document.getElementById("diagnostics-close");
  const refresh = document.getElementById("diagnostics-refresh");
  const copy    = document.getElementById("diagnostics-copy");
  const out     = document.getElementById("diagnostics-output");
  if (!dialog || !open || !out) return;

  // One capture combines STUN probe + last pair attempt + connected-robot
  // telemetry into a single object the user can copy-paste in one shot.
  // Each section is best-effort; failures are recorded so the structure
  // stays predictable.
  async function capture() {
    out.textContent = "Capturing…";
    const result = { capturedAt: new Date().toISOString(), userAgent: navigator.userAgent };

    if (typeof window.probeNetwork === "function") {
      try { result.netProbe = await window.probeNetwork({ timeoutMs: 4000 }); }
      catch (err) { result.netProbe = { error: err.message || String(err) }; }
    } else {
      result.netProbe = { error: "probeNetwork() not loaded" };
    }

    // Web Bluetooth surface — answers "can this browser/profile do BLE at
    // all" before a Scan click. Safari has no Web BLE; Chromium-on-Linux
    // sometimes reports unavailable; permission can be denied at the OS
    // level on macOS without the page knowing.
    result.ble = await (async () => {
      if (!navigator.bluetooth) {
        return { supported: false, available: false, permission: null };
      }
      let available = null, permission = null;
      try { available = await navigator.bluetooth.getAvailability(); } catch {}
      try {
        const p = await navigator.permissions.query({ name: "bluetooth" });
        permission = p.state;
      } catch {}
      return { supported: true, available, permission };
    })();

    // Per-server ICE reachability — the TURN-enabled config a real pair
    // would use, broken out per server with first-hit latency. Reveals
    // "STUN works but TURN unreachable" (the WhiteSky-class fallback gap)
    // distinct from "all blocked" (full ICE failure).
    try {
      const { fetchIceServers } = await import("./pairing.js");
      const iceServers = await fetchIceServers();
      result.iceReachability = typeof window.probeIceReachability === "function"
        ? await window.probeIceReachability(iceServers, { timeoutMs: 2500 })
        : { error: "probeIceReachability() not loaded" };
    } catch (err) {
      result.iceReachability = { error: err.message || String(err) };
    }

    // Robot /health reachability — answers "robot is on the LAN" cleanly
    // separate from "WebRTC data path works." A robot whose /health responds
    // but whose camera/pair never completes points at WebRTC/ICE, not the
    // LAN.
    {
      const sources = (typeof getTelemetrySources === "function" ? getTelemetrySources() : []) || [];
      const targets = sources.filter((s) => s && s.wifiStatus?.ip);
      if (targets.length === 0) {
        result.robotHealth = { note: "no robots with WiFi IP — connect over BLE first" };
      } else {
        result.robotHealth = await Promise.all(targets.map(async (s) => {
          const ip = s.wifiStatus.ip;
          const ts = performance.now();
          try {
            const r = await fetch(`http://${ip}:81/health`, { signal: AbortSignal.timeout(2000) });
            const body = r.ok ? await r.json() : null;
            return { name: s.name || s.id, ip, ok: r.ok, status: r.status, latencyMs: Math.round(performance.now() - ts), body };
          } catch (err) {
            return { name: s.name || s.id, ip, ok: false, error: err.name === "TimeoutError" ? "timeout" : (err.message || String(err)) };
          }
        }));
      }
    }

    if (typeof window.lastPairDiagnostic === "function") {
      try {
        const snap = await window.lastPairDiagnostic();
        result.phonePair = snap.role ? snap : { note: "no phone-pair attempt yet this session" };
      } catch (err) { result.phonePair = { error: err.message || String(err) }; }
    } else {
      result.phonePair = { error: "lastPairDiagnostic() not loaded" };
    }

    if (typeof window.lastRobotWebRTCDiagnostic === "function") {
      try {
        const peers = await window.lastRobotWebRTCDiagnostic();
        result.robotWebRTC = peers.length
          ? peers
          : { note: "no robot WebRTC peer open — start camera first" };
      } catch (err) { result.robotWebRTC = { error: err.message || String(err) }; }
    } else {
      result.robotWebRTC = { error: "lastRobotWebRTCDiagnostic() not loaded" };
    }

    const sources = (typeof getTelemetrySources === "function" ? getTelemetrySources() : []) || [];
    const populated = sources.filter((s) => s && s.telemetry);
    result.robots = populated.length === 0
      ? { note: "no connected robot has telemetry — connect first, then wait ~10s" }
      : populated.map((s) => ({ name: s.name || s.id || "?", telemetry: s.telemetry }));

    out.textContent = JSON.stringify(result, null, 2);
  }

  open.addEventListener("click", () => { onBeforeOpen?.(); dialog.showModal(); capture(); });
  close?.addEventListener("click", () => dialog.close());
  refresh?.addEventListener("click", capture);

  copy?.addEventListener("click", async () => {
    if (!out.textContent) return;
    try {
      await navigator.clipboard.writeText(out.textContent);
      const original = copy.textContent;
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = original; }, 1500);
    } catch {
      copy.textContent = "Copy failed";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    }
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
