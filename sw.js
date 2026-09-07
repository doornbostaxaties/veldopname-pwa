// sw.js — cachet alleen de app-shell (HTML/CSS/JS/iconen), zodat de app ook zonder verbinding
// opstart. Data (taxaties, foto's) leeft in IndexedDB (db.js/app.js), niet hier.

const CACHE_NAAM = 'veldopname-shell-v1';
const SHELL_BESTANDEN = [
  './', './index.html', './style.css', './app.js', './db.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAAM).then((cache) => cache.addAll(SHELL_BESTANDEN)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((namen) => Promise.all(
      namen.filter((n) => n !== CACHE_NAAM).map((n) => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

// App-shell: cache-first (snel, werkt offline). Alle andere requests (Make-webhooks, foto's
// ophalen e.d.) gaan gewoon rechtstreeks het netwerk op — die cachen we bewust niet.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
