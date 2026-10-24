/* Offline support: the shell and menu data are network-first (prices change),
   photos and fonts are cache-first (their file names never change). */
const VERSION = 'mezza-v1';
const SHELL = [
  './', 'index.html', 'data/menu.js', 'assets/js/i18n.js', 'assets/js/app.js',
  'assets/css/fonts.css', 'assets/css/main.css', 'assets/img/logo.webp',
  'assets/img/hero-mobile.webp', 'manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const immutable = /\/(photos|assets\/fonts|assets\/img)\//.test(url.pathname);
  if (immutable) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html')))
  );
});
