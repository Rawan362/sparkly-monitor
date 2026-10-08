// Minimal service worker — required for "Add to Home Screen" installability.
// Caches the app shell so it opens instantly even on a flaky connection;
// live data (conversations, messages) always comes fresh from Supabase,
// this only caches the static shell itself.
const CACHE_NAME = 'sparkly-shell-v10';
// The phone's own copy of photos, videos, voice notes and call audio (WhatsApp style). Never cleared by app updates.
const MEDIA_CACHE = 'sparkly-media-v1';
const MEDIA_MARK = '/storage/v1/object/public/chat-media/';
const SHELL_FILES = ['/', '/index.html', '/manifest.json'];


// Plays a file from the phone's own copy when it has one (including the partial "Range" requests that
// audio and video players make); otherwise it just goes to the server as before.
async function serveMedia(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const hit = await cache.match(request.url);
  if (!hit) return fetch(request);
  const range = request.headers.get('range');
  if (!range) return hit;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return hit;
  const buf = await hit.clone().arrayBuffer();
  const total = buf.byteLength;
  let start, end;
  if (m[1] === '') { start = Math.max(0, total - Number(m[2])); end = total - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1); }
  if (start > end || start >= total) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + total } });
  return new Response(buf.slice(start, end + 1), { status: 206, headers: {
    'Content-Type': hit.headers.get('Content-Type') || 'application/octet-stream',
    'Content-Length': String(end - start + 1),
    'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
    'Accept-Ranges': 'bytes' } });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== MEDIA_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const reqUrl = new URL(event.request.url);

  // Seller media (photos, videos, voice notes, call audio): use the phone's own copy first.
  if (event.request.method === 'GET' && reqUrl.href.indexOf(MEDIA_MARK) !== -1) {
    event.respondWith(serveMedia(event.request));
    return;
  }

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
