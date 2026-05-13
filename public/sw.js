// Service worker — offline-first dashboard.
//
// Strategy: stale-while-revalidate for everything same-origin. After the
// first visit, the dashboard runs offline; cached assets refresh on next
// fetch when network is back. The user pays the network cost once.
//
// What's NOT cached:
// - /firmware/* — OTA bundles, big and per-device. Always fetched fresh.
// - cross-origin (Claude API via the bridge, esp-web-tools CDN, etc.) —
//   these have their own freshness needs and we'd be wrong to gatekeep.
//
// Update flow:
// - VERSION is auto-stamped by the pre-commit hook on dashboard-asset
//   changes (.githooks/pre-commit hashes `git ls-files -s` for public/*
//   except firmware + sw.js itself). Hash-based, not raw commit SHA —
//   no-op commits (artifact pushes, doc edits) don't trigger the banner.
//   Install with `make install-hooks`.
// - Browser sees new SW → installs → waits.
// - App detects the waiting worker → shows the update banner.
// - User clicks "Reload" → SW skipWaiting + controllerchange + reload →
//   all assets re-fetched from network. Intentional, never silent.
// - Manual edits to VERSION are pointless — the hook overwrites on next
//   commit. For an intentional bump unrelated to assets (e.g. server-side
//   change in an API contract), edit any cached asset (a comment will do)
//   and the hook will pick up a new hash.
const VERSION = "ec96372c";
const CACHE = `dashboard-${VERSION}`;

// Cached at install time so the dashboard can cold-boot offline AND
// dynamically-imported dialogs (recovery, scripts) are ready before the
// user opens them. Relative paths because the dashboard deploys at a
// subpath (neves.cloud/better-robotics/); absolute "/" resolves to origin
// root, not SW scope.
const BOOTSTRAP = [
  "./", "./index.html", "./app.js", "./styles.css", "./icons.svg",
  // PWA install assets — home-screen icon + manifest must be cached for
  // an installed app to cold-boot offline.
  "./manifest.json", "./icon.svg",
  // Phone companion is installable too (iOS A2HS); phone.html is the
  // scope-root start_url when installed from /phone.html.
  "./phone.html", "./mobile.js",
  // Dynamic-imported by app.js. Precache so first open of Recovery /
  // Scripts / Pinout / ESP serial / SD prep loads from cache, and works
  // offline.
  "./recovery.js", "./prepare.js", "./scripts.js", "./pinout.js", "./esp-serial.js",
];

// Cross-origin URLs we DO cache. Default is pass-through (host owns
// freshness), but HuggingFace model files (50-200 MB, one-time) get
// evicted under browser storage pressure. SW cache is durable. Caching
// turns "Watch with Pip" / grounding from "needs network per session"
// into "needs network for first model download, ever."
function isCacheableCrossOrigin(url) {
  // HF model files (.onnx, .safetensors, tokenizer.json) from
  // from_pretrained() in transformers.js.
  if (url.hostname === "huggingface.co") return true;
  // transformers.js library + WebGPU / onnx-runtime assets.
  if (url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("@huggingface/")) return true;
  return false;
}

self.addEventListener("install", (e) => {
  // No skipWaiting — updates are intentional. Page detects the waiting
  // worker and surfaces a banner; user triggers the swap via message.
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll is atomic — fail one, install fails. Keeps cache from ending
    // up half-populated on a 404.
    try { await cache.addAll(BOOTSTRAP); } catch { /* network flaky; lazy cache will catch */ }
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // Drop old version caches.
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("dashboard-") && k !== CACHE).map(k => caches.delete(k)));
    // Take control of pages loaded under the previous SW. Paired with the
    // page's controllerchange→reload, gives the user-clicked Reload a
    // clean handoff.
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Cross-origin: pass through except allowlisted ML CDNs (durable cache
  // for big one-time downloads). Same-origin: cache everything except OTA
  // bundles (per-device freshness).
  if (url.origin !== location.origin) {
    if (!isCacheableCrossOrigin(url)) return;
  } else if (url.pathname.includes("/firmware/")) {
    return;
  }

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) {
      // Stale-while-revalidate: serve the cached copy immediately, fetch
      // fresh in the background to update the cache for next time. The
      // user never waits on the network when the cache has an answer.
      fetch(req).then((resp) => {
        if (resp.ok) cache.put(req, resp.clone()).catch(() => {});
      }).catch(() => { /* offline — that's fine, cached copy already served */ });
      return cached;
    }
    // Not cached yet — fetch + cache (lazy install).
    try {
      const resp = await fetch(req);
      // Only cache successful responses; opaque/error responses pollute.
      if (resp.ok) cache.put(req, resp.clone()).catch(() => {});
      return resp;
    } catch (err) {
      // Offline AND uncached — return a placeholder. Most requests we
      // care about will be cached after the first online visit.
      return new Response("Offline and resource not cached", {
        status: 503, statusText: "Offline",
      });
    }
  })());
});

// Page asks the waiting worker to take over. Triggered by the user
// clicking "Reload" on the update banner.
self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});
