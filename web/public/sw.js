const CACHE_NAME = 'cv-shell-v3';
const PRECACHE_URLS = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_URLS);
      // Discover the content-hashed shell assets (script/modulepreload/stylesheet)
      // from index.html and precache them too, so the first visit's full shell is
      // cached immediately — going offline right after loading still reloads the app
      // (M3 airplane-mode exit criterion). Individual addAll so one failure doesn't
      // void the rest.
      try {
        const res = await fetch('/index.html');
        if (res.ok) {
          const html = await res.text();
          const urls = new Set();
          for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|mjs|css))"/g)) {
            urls.add(new URL(m[1], self.location.href).toString());
          }
          await Promise.allSettled([...urls].map((u) => cache.addAll([u])));
        }
      } catch {
        // offline during install: keep the base shell precache only
      }
    })()
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  const cachePut = (response) => {
    if (response && response.ok && response.type === 'basic' && !response.redirected) {
      const copy = response.clone();
      // waitUntil keeps the SW alive for the put; catch prevents unhandled rejections (quota).
      event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {})
      );
    }
    return response;
  };

  // HTML/navigations: network-first so a deploy's new shell is picked up on the
  // next online load; offline falls back to the cached shell (M3 airplane-mode demo).
  // Everything else (content-hashed assets, sample docs): cache-first.
  if (request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(request)
        .then(cachePut)
        .catch(() =>
          caches
            .match(request)
            .then(
              (cached) =>
                cached ||
                caches.match('/').then((root) => root || caches.match('/index.html'))
            )
        )
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(request).then(cachePut).catch(() =>
        new Response('Offline', { status: 503, statusText: 'Service Unavailable' })
      );
    })
  );
});
