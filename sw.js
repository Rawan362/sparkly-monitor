// Minimal service worker — required for "Add to Home Screen" installability.
// Caches the app shell so it opens instantly even on a flaky connection;
// live data (conversations, messages) always comes fresh from Supabase,
// this only caches the static shell itself.
const CACHE_NAME = 'sparkly-shell-v6';
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
  const reqUrl = new URL(event.request.url);

  // Only ever handle GET requests to our own site. Everything else — API
  // calls to Supabase, webhook calls to n8n, POST requests like sending a
  // photo — must pass through completely untouched. Intercepting those
  // served no purpose here and could break them if our fallback had
  // nothing to return (which is exactly what caused the "Returned response
  // is null" error on photo uploads).
  if (event.request.method !== 'GET' || reqUrl.origin !== self.location.origin) {
    return;
  }

  // Network-first for our own pages — always prefer fresh content and only
  // fall back to cache if genuinely offline. For navigations, also defeat
  // the browser's own HTTP cache AND any CDN edge cache (GitHub Pages
  // caches responses for a few minutes by default) via cache-busting.
  if (event.request.mode === 'navigate') {
    const navUrl = new URL(event.request.url);
    navUrl.searchParams.set('_v', Date.now());
    event.respondWith(
      fetch(navUrl.toString(), { cache: 'no-store' })
        .catch(() => caches.match(event.request))
        .then((resp) => resp || fetch(event.request))
    );
    return;
  }
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .catch(() => caches.match(event.request))
      .then((resp) => resp || fetch(event.request))
  );
});
