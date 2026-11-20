// Bookr on the phone (approved 20 Nov 2026): makes Bookr installable as an app. It keeps nothing of the business on
// the phone: every page and every figure still comes from the server, as in the browser. Only a small "You're offline"
// page is kept, shown when the phone has no network.
const OFFLINE = 'bookr-offline-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(OFFLINE).then((c) => c.add('/offline.html')).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== OFFLINE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  // Only opening a page is looked after; everything else goes to the network untouched.
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));
});
