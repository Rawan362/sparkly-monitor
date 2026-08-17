// Minimal service worker — required for "Add to Home Screen" installability.
// Caches the app shell so it opens instantly even on a flaky connection;
// live data (conversations, messages) always comes fresh from Supabase,
// this only caches the static shell itself.
const CACHE_NAME = 'sparkly-shell-v5';
const SHELL_FILES = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Network-first for everything — this is a live dashboard, not a static
  // site, so always prefer fresh data and only fall back to cache if offline.
  // For page navigations specifically, also defeat the browser's own HTTP
  // cache AND any CDN edge cache (GitHub Pages caches responses for a few
  // minutes by default) by cache-busting the URL — without this, "network
  // first" could still silently serve a stale cached copy.
  if (event.request.mode === 'navigate') {
    const url = new URL(event.request.url);
    url.searchParams.set('_v', Date.now());
    event.respondWith(
      fetch(url.toString(), { cache: 'no-store' }).catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request))
  );
});
