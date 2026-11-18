/* SatPass service worker. App shell is cached for offline launch.
   CelesTrak and Open-Meteo are not cached here; the page keeps those in localStorage. */
const CACHE = 'satpass-shell-v2';
const SHELL = [
  '/',
  '/css/style.css',
  '/js/app.js',
  '/js/core.js',
  '/js/push-location.js',
  '/vendor/satellite.min.js',
  '/data/fallback-tle.js',
  '/data/land-110m.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(event.request);
      if (fresh.ok) cache.put(event.request, fresh.clone()).catch(() => {});
      return fresh;
    } catch {
      return (await cache.match(event.request)) || (await cache.match('/')) || Response.error();
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'SatPass';
  const body = data.body || '';
  event.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'satpass',
      data: { url: data.url || '/' }
    });
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) client.postMessage({ type: 'push', title, body, url: data.url || '/' });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (client.url.startsWith(self.location.origin) && 'navigate' in client) {
        await client.focus();
        return client.navigate(target);
      }
    }
    return self.clients.openWindow(target);
  })());
});
