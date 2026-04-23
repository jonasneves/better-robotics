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
const VERSION = "v1";
const CACHE = `dashboard-${VERSION}`;

// Bootstrap files cached at install time so the dashboard can cold-boot
// offline. Everything else caches lazily as the user navigates / uses it.
// Keep this list short — anything not here just gets cached on first fetch.
const BOOTSTRAP = [
  "/", "/index.html", "/app.js", "/styles.css", "/icons.svg",
];

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
  // Only handle same-origin GETs. Cross-origin (Claude bridge, CDN, etc.)
  // pass through untouched — they own their own caching/freshness story.
  if (url.origin !== location.origin) return;
  // OTA bundles are big + per-device + fetched-once-per-update. Caching
  // them risks serving stale firmware to a user who just OTA'd. Always
  // network for these.
  if (url.pathname.startsWith("/firmware/")) return;

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
