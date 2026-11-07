// Service worker: makes the app installable and lets the shell open instantly.
// API calls always go to the network (never cached).
const VERSION = 'mc-v1';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Network first so updates roll out immediately; cache keeps it working offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() =>
        caches.match(event.request).then((hit) => hit || (event.request.mode === 'navigate' ? caches.match('/index.html') : undefined)),
      ),
  );
});
