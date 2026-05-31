/*
 * adherence.ml service worker
 *
 * Strategy:
 *   - precache: app shell (/, /offline) + a couple of icons so the installed
 *     PWA opens instantly and keeps working when the network is down.
 *   - navigations: network-first, fall back to the cached /offline page so
 *     users never see the browser's dino.
 *   - same-origin static assets (/_next/static, /icon-*, /manifest...):
 *     stale-while-revalidate.
 *   - everything else, including /api and /v1: pass through, never cache.
 *
 * Bump CACHE_VERSION on each shell change so old clients drop the stale
 * bundle on activate. The accompanying SwRegister component listens for
 * `controllerchange` and surfaces an "update ready" toast.
 */

const CACHE_VERSION = "adh-v3";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;

const SHELL_URLS = [
  "/offline",
  "/manifest.webmanifest",
  "/icon-192.svg",
  "/icon-512.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll is atomic; if any entry 404s the whole install fails. Use
      // individual adds so a missing icon does not brick the worker.
      await Promise.all(
        SHELL_URLS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: "reload" });
            if (res.ok) await cache.put(url, res.clone());
          } catch {
            /* offline at install time, that is fine */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => !n.startsWith(CACHE_VERSION))
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/");
}

function isStaticAsset(url) {
  if (url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname.startsWith("/icon-")) return true;
  if (url.pathname === "/manifest.webmanifest") return true;
  return false;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isApiRequest(url)) return; // never cache API or v1

  // Navigations: network-first, /offline fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          const offline = await cache.match("/offline");
          if (offline) return offline;
          return new Response("offline", {
            status: 503,
            headers: { "content-type": "text/plain" },
          });
        }
      })(),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })(),
    );
  }
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
