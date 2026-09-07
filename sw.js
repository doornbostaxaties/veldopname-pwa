// sw.js — cachet alleen de app-shell (HTML/CSS/JS/iconen), zodat de app ook zonder verbinding
// opstart. Data (taxaties, foto's) leeft in IndexedDB (db.js/app.js), niet hier.
//
// LET OP (bug gevonden 07-09-2026): CACHE_NAAM stond hier hardcoded op 'v1' en werd nooit
// opgehoogd bij een deploy. Chrome/Safari controleert een service worker alleen op updates als de
// BYTES van dit bestand zelf wijzigen — wijzigde alleen app.js/style.css (zoals bij bijna elke
// vorige fix), dan bleef de oude worker gewoon actief en werd de nieuwe app.js/style.css NOOIT
// opnieuw gecachet. Reden dat eerdere fixes (scroll, macro's-dropdown) op een al geïnstalleerde
// PWA soms niet aankwamen. Twee fixes ineen: (1) stale-while-revalidate i.p.v. puur cache-first,
// zodat een nieuwe deploy zichzelf binnen één herlaadbeurt bijwerkt zonder dat ik een versienummer
// hoef op te hogen; (2) dit bestand wijzigt hierbij zelf ook van inhoud, wat de browser nu wél als
// een echte SW-update herkent en deze fix meteen laat landen.
const CACHE_NAAM = 'veldopname-shell-v2';
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

// App-shell: stale-while-revalidate — antwoord meteen met de gecachete versie (snel, werkt
// offline), maar haalt er ONDERTUSSEN altijd een verse versie bij en werkt de cache daarmee bij
// voor de VOLGENDE keer laden. Zo hoeft een nieuwe deploy niet meer op een handmatige
// cache-leging/versienummer te wachten — uiterlijk de tweede keer openen na een update draait de
// nieuwste code. Alle andere requests (Make-webhooks e.d.) gaan gewoon rechtstreeks het netwerk op.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE_NAAM).then(async (cache) => {
      const cached = await cache.match(event.request);
      // Let op: de achtergrond-fetch die de cache bijwerkt moet in event.waitUntil() — anders mag
      // de browser deze service worker meteen afsluiten zodra respondWith() hieronder klaar is
      // (met een cache-hit gebeurt dat vrijwel synchroon), en wordt cache.put() nooit voltooid. Dat
      // was de reden dat een nieuwe deploy tijdens het testen NOOIT doorkwam, ook niet ná een
      // herlaadbeurt: de bijwerk-belofte werd simpelweg gekild vóór hij klaar was.
      const ververs = fetch(event.request).then((resp) => {
        if (resp.ok) cache.put(event.request, resp.clone());
        return resp;
      }).catch(() => null);
      event.waitUntil(ververs);
      return cached || (await ververs) || Response.error();
    })
  );
});
