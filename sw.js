const CACHE = 'healthvault-v2';
const FILES = [
  '/Health-App/',
  '/Health-App/index.html',
  '/Health-App/manifest.json',
  '/Health-App/icon-192.png',
  '/Health-App/icon-512.png',
  '/Health-App/favicon.ico'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
