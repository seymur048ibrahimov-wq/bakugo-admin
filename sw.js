/* BakuGo Admin — Service Worker
   1) Offline dəstəyi (PWABuilder və Play/TWA yoxlaması üçün)
   2) Firebase Cloud Messaging — tətbiq bağlı olanda push bildirişləri
   Bu fayl index.html ilə EYNİ qovluqda olmalıdır. */

const CACHE = 'bakugo-admin-v2';
const PRECACHE = [
  './',
  './index.html',
  './offline.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => null))))
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Yalnız öz saytımızın fayllarını idarə edirik. Firebase, xəritə, OSRM və s. birbaşa şəbəkədən gedir.
  if (url.origin !== self.location.origin) return;

  // Səhifə açılışı: əvvəl şəbəkə (həmişə ən son versiya), internet yoxdursa keş, o da yoxdursa offline.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req)
            .then((r) => r || caches.match('./index.html'))
            .then((r) => r || caches.match('./offline.html'))
        )
    );
    return;
  }

  // İkon, manifest və digər statik fayllar: keş, sonra şəbəkə
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }))
  );
});

/* ---------- FIREBASE PUSH (FCM) ---------- */
// importScripts xəta versə belə (zəif internet), SW-nin offline hissəsi işləməyə davam edir.
try {
  importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

  firebase.initializeApp({
    apiKey: "AIzaSyBQIDfObXpxNa1hVAYDmigSi9u49y_BJQc",
    authDomain: "bkaugo.firebaseapp.com",
    projectId: "bkaugo",
    storageBucket: "bkaugo.firebasestorage.app",
    messagingSenderId: "568740538737",
    appId: "1:568740538737:web:9b2ab40d0b728789a1aed0"
  });

  const messaging = firebase.messaging();

  // Mesajda "notification" hissəsi varsa, Firebase onu özü göstərir (ikiqat bildiriş olmasın deyə burada göstərmirik).
  // Yalnız "data" mesajlarını özümüz göstəririk.
  messaging.onBackgroundMessage((payload) => {
    if (payload && payload.notification) return;
    const d = (payload && payload.data) || {};
    self.registration.showNotification(d.title || '🔔 BakuGo Admin', {
      body: d.body || 'Yeni hadisə var — baxmaq üçün toxunun.',
      icon: './icon-192.png',
      badge: './icon-96.png',
      tag: d.orderId || 'bakugo-order',
      renotify: true,
      requireInteraction: true,
      vibrate: [400, 150, 400, 150, 400],
      data: { url: d.url || './' }
    });
  });
} catch (e) {
  console.warn('Firebase Messaging SW-də yüklənmədi:', e);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
