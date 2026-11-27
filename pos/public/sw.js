// Bookr POS offline (27 Nov 2026): keeps the counter's own pages on this PC so they open with no internet. Always asks the
// server first, so a new version is used as soon as it is out; the saved copy is used only when the server cannot be
// reached. The POS's data (/api) is never kept here: the page itself decides what it saves.
const CACHE = 'bookr-pos-v2';
const PAGES = ['/', '/app.js', '/app.css', '/offline.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

// A page kept as itself: the server sends /index.html as a redirect to /, and a kept redirect cannot open a page.
const plain = async (res) => (res.redirected ? new Response(await res.blob(), { status: res.status, headers: res.headers }) : res);
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    for (const p of PAGES) { const res = await fetch(p, { cache: 'no-cache' }); if (res.ok) await c.put(p, await plain(res)); }
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const page = e.request.mode === 'navigate';
  if (!page && !PAGES.includes(url.pathname)) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const res = await fetch(e.request);
      if (res.ok && (!page || url.pathname === '/' || url.pathname === '/index.html')) await c.put(page ? '/' : url.pathname, await plain(res.clone()));
      return res;
    } catch {
      return (await c.match(page ? '/' : url.pathname)) ?? Response.error();
    }
  })());
});
