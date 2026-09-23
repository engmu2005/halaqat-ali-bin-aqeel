/* Service Worker – يتيح عمل التطبيق بدون إنترنت بعد أول زيارة.
   عند تعديل ملفات التطبيق ارفع رقم الإصدار في CACHE ليتم تحديث النسخة المخزنة. */
const CACHE = 'bulugh-app-v2.1.0';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/vendor/xlsx.mini.min.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/majma-logo.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putInCache(request, response) {
  if (!response || (response.status !== 200 && response.type !== 'opaque')) return;
  const copy = response.clone();
  caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // بيانات النظام (/api) لا تُخزَّن في الكاش أبداً — أمان بيانات المستخدمين
  if (url.pathname.startsWith('/api/')) return;

  if (url.origin === self.location.origin) {
    // ملفات التطبيق: الشبكة أولاً (لضمان أحدث نسخة) ثم الكاش عند انقطاع الإنترنت
    event.respondWith(
      fetch(request)
        .then((response) => { putInCache(request, response); return response; })
        .catch(() => caches.match(request).then((cached) => cached || (request.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
    );
    return;
  }

  // موارد خارجية (الخطوط): الكاش أولاً مع تحديث في الخلفية
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => { putInCache(request, response); return response; })
        .catch(() => cached || Response.error());
      return cached || network;
    })
  );
});
