// Service worker: приложение открывается и работает без интернета.
// Стратегия: сеть в приоритете (всегда свежая версия), при отсутствии сети — кэш.
const CACHE = 'sunclub-v1';
const PRECACHE = [
  './',
  './apps-script/Code.gs',
  './css/app.css',
  './img/bg.jpg',
  './img/icon-192.png',
  './img/icon-512.png',
  './img/icon.svg',
  './index.html',
  './js/api.js',
  './js/backup.js',
  './js/core/api.js',
  './js/core/auth.js',
  './js/core/billing.js',
  './js/core/db.js',
  './js/core/lamps.js',
  './js/core/sqljs-db.js',
  './js/core/sync.js',
  './js/core/util.js',
  './js/local-backend.js',
  './js/main.js',
  './js/store.js',
  './js/ui.js',
  './js/views/admin.js',
  './js/views/bar.js',
  './js/views/checks.js',
  './js/views/cloud.js',
  './js/views/login.js',
  './js/views/menu.js',
  './js/views/pay.js',
  './js/views/reports.js',
  './js/views/shift.js',
  './js/views/tables.js',
  './manifest.webmanifest',
  './vendor/sql-wasm.js',
  './vendor/sql-wasm.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./'))),
  );
});
