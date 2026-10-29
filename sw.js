'use strict';
// Service worker: deixa o app abrir sem sinal. Rede primeiro (para uma versão nova chegar
// assim que houver sinal) e cache como reserva. Caminhos relativos: o app pode morar numa
// subpasta (GitHub Pages). Chamadas ao Apps Script são de outra origem e nunca passam por aqui.
const CACHE = 'vistorias-v2';
const CASCA = ['./', 'index.html', 'app.js', 'api.js', 'relatorio.js', 'config.js', 'manifest.webmanifest', 'unidades.json',
  'girollar-logo-reduzido.svg', 'girollar-logo.svg', 'icons/icone-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CASCA)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/api/') || url.pathname.includes('/r/')) return;
  e.respondWith(
    fetch(req)
      .then((r) => {
        if (r.ok) {
          const copia = r.clone();
          caches.open(CACHE).then((c) => c.put(req, copia));
        }
        return r;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./')))
  );
});
