// APEX GRAND PRIX service worker (generated at build time from src/pwa/sw-template.js).
// Strategy: precache the whole build, serve it cache-first, and let the page decide when to
// switch to a new version (the user taps "Reload" on the update prompt).
const VERSION = __APEX_VERSION__;
const PRECACHE = __APEX_PRECACHE__;
const CACHE_PREFIX = 'apex-gp-';
const CACHE_NAME = CACHE_PREFIX + VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // `cache: 'reload'` bypasses the HTTP cache so a new version never precaches stale files.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Any navigation inside our scope (including ?renderer=webgl etc.) gets the cached app shell.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const shell =
          (await cache.match('./index.html', { ignoreVary: true })) ||
          (await cache.match('./', { ignoreVary: true }));
        return shell || fetch(request);
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Module scripts are requested with an Origin header; servers that answer with
      // `Vary: Origin` would make the precached copy miss. File names are content-hashed, so
      // ignoring Vary is safe.
      const cached = await cache.match(request, { ignoreVary: true });
      return cached || fetch(request);
    })(),
  );
});
