// Офлайн-оболочка: приложение открывается без сети, сохранённый маршрут и
// кнопки «Поехать» продолжают работать. Запросы к /api всегда идут в сеть.
const CACHE = 'courier-route-v1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/parser.js', 'js/optimizer.js', 'js/nav.js', 'js/direct.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];
const CDN = ['https://unpkg.com/leaflet@1.9.4/', 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/', 'https://fonts.'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;
  const sameOrigin = url.origin === location.origin;
  const cdn = CDN.some((p) => req.url.startsWith(p));
  if (!sameOrigin && !cdn) return; // плитки карты и прочее — без кеша
  // свои файлы: сначала сеть (чтобы получать обновления), при ошибке — кеш
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))),
  );
});
