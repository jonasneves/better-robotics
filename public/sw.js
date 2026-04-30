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
// - VERSION is auto-stamped by CI on every dashboard-asset change
//   (.github/workflows/stamp-sw-version.yml computes the content hash of
//   all public/*.{js,css,html,svg,json} files except firmware + sw.js
//   itself). Hash-based, not raw commit SHA — no-op commits (artifact
//   pushes, doc edits) don't trigger the banner.
// - Browser sees new SW → installs → waits.
// - App detects the waiting worker → shows the update banner.
// - User clicks "Reload" → SW skipWaiting + controllerchange + reload →
//   all assets re-fetched from network. Intentional, never silent.
// - Manual edits to VERSION are pointless — CI overwrites on next deploy.
//   For an intentional bump unrelated to assets (e.g. server-side change
//   in an API contract), edit any cached asset (a comment will do) and
//   CI will pick up a new hash.
const VERSION = "d6a9a502";
const CACHE = `dashboard-${VERSION}`;

// Bootstrap files cached at install time so the dashboard can cold-boot
// offline AND so dynamically-imported dialogs (recovery, scripts, etc.)
// are ready even before the user opens them. Relative paths because the
// dashboard deploys at a subpath (neevs.io/better-robotics/) — absolute
// "/" would resolve to the origin root, not the SW scope.
const BOOTSTRAP = [
  "./", "./index.html", "./app.js", "./styles.css", "./icons.svg",
  // PWA install assets — home-screen icon + manifest must be cached for
  // an installed app to cold-boot offline.
  "./manifest.json", "./icon.svg",
  // Phone companion is installable too (iOS A2HS target); phone.html is
  // the scope-root start_url when installed from /phone.html.
  "./phone.html", "./phone.js",
  // Dynamic-imported by app.js. Precaching them means the first time the
  // user opens Recovery / Scripts / Pinout / ESP serial / SD prep, the
  // module loads from cache instead of doing a network round-trip — and
  // it works offline.
  "./recovery.js", "./prepare.js", "./scripts.js", "./pinout.js", "./esp-serial.js",
];

// Cross-origin URLs we deliberately DO cache. Default for cross-origin is
// to pass through (their hosts own freshness), but ML models from HuggingFace
// are large (50-200 MB) one-time downloads — vulnerable to browser cache
// eviction under storage pressure. SW cache is durable. Caching them turns
// "Watch with Pip" / grounding from "needs network for first session" into
// "needs network for first model download, ever."
function isCacheableCrossOrigin(url) {
  // HuggingFace model files (.onnx, .safetensors, tokenizer.json, etc.).
  // These come from the transformers.js client when from_pretrained() runs.
  if (url.hostname === "huggingface.co") return true;
  // The transformers.js library + its WebGPU/onnx-runtime assets.
  if (url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("@huggingface/")) return true;
  return false;
}

self.addEventListener("install", (e) => {
  // Don't skipWaiting here — we want updates to be intentional. The page
  // detects the waiting worker and surfaces a banner; user triggers the
  // swap via a message below.
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll is atomic — fail one, install fails. Keeps the cache from
    // ending up half-populated if a bootstrap file 404s.
    try { await cache.addAll(BOOTSTRAP); } catch { /* network may be flaky; lazy cache will catch */ }
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // Drop old version caches so disk doesn't accumulate forever.
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("dashboard-") && k !== CACHE).map(k => caches.delete(k)));
    // Take control of pages that loaded under the previous SW (or none).
    // Combined with the page's controllerchange→reload, this gives the
    // user-clicked Reload a clean handoff.
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Decide whether this request is one we manage. Cross-origin defaults to
  // pass-through (their hosts own freshness); allowlist the ML model + lib
  // CDNs so they get the persistence benefit. Same-origin: cache everything
  // except OTA bundles (per-device freshness story).
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
