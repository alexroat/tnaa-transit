// Service worker: app e orari sempre disponibili, tile salvati man mano, dati live mai in cache.
const VERSION = 'v2';
const SHELL = `tn-shell-${VERSION}`;
const TILES = `tn-tiles-${VERSION}`;
const MAX_TILES = 4000;
const SHELL_FILES = [
  './', 'index.html', 'come-funziona.html', 'style.css', 'manifest.webmanifest', 'js/main.js', 'js/schedule.js', 'js/rt.js', 'data/net.json',
  'vendor/maplibre/maplibre-gl.mjs', 'vendor/maplibre/maplibre-gl-shared.mjs', 'vendor/maplibre/maplibre-gl-worker.mjs',
  'vendor/maplibre/maplibre-gl.css', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];
const MAP_HOSTS = ['tiles.openfreemap.org', 's3.amazonaws.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== TILES) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Prima la rete, cosi app e orari restano aggiornati; se c'e una copia locale non si aspetta oltre 4 secondi.
async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(req, { ignoreSearch: true });
  try {
    const res = await fetch(req, cached ? { signal: AbortSignal.timeout(4000) } : {});
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await cache.delete(k);
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin) e.respondWith(networkFirst(e.request));
  else if (MAP_HOSTS.includes(url.hostname)) e.respondWith(cacheFirst(e.request));
  // Tutto il resto, compresi i feed BusOne, passa direttamente dalla rete.
});
