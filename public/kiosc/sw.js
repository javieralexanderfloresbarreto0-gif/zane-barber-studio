/* Kiosco · shell con actualización automática.
   El HTML/CSS/JS se sirve desde caché al instante y se revalida en segundo
   plano (stale-while-revalidate): un cambio de código aparece en la 2ª carga,
   sin tener que tocar este archivo. Sube CACHE solo para forzar un borrón. */
var CACHE = 'zane-kiosc-v5';
var SHELL = [
  '/kiosc/',
  '/kiosc/index.html',
  '/kiosc/kiosc.css',
  '/kiosc/kiosc.js',
  '/kiosc/manifest.webmanifest',
  '/img/logo.png',
  '/vendor/fonts/fonts.css',
  '/vendor/fontawesome/all.min.css'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return Promise.all(SHELL.map(function (u) {
        return fetch(u, { cache: 'reload' }).then(function (r) { if (r.ok) return c.put(u, r); }).catch(function () {});
      })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  // La API siempre a la red (nunca se cachea el estado de una orden).
  if (url.pathname.indexOf('/api/') === 0) return;

  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(e.request).then(function (hit) {
        var fromNet = fetch(e.request).then(function (res) {
          if (res && res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(function () {
          return hit || cache.match('/kiosc/index.html');
        });
        return hit || fromNet;   // sirve caché ya; actualiza para la próxima
      });
    })
  );
});
