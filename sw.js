// Service worker: makes the app installable and usable offline.
// Network-first for app files so updates arrive promptly; cache fallback offline.
const VERSION = 'v1.5.0';
const CACHE = `vwr-shell-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './worker.js',
  './js/app.js',
  './js/db.js',
  './js/crypto.js',
  './js/recorder.js',
  './js/transcriber.js',
  './js/summarize.js',
  './js/report.js',
  './js/reminder.js',
  './js/editor.js',
  './js/ai.js',
  './js/coach.js',
  './js/extract.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('vwr-shell-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // Transformers.js library files from the CDN: cache first (versioned URLs).
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(
      caches.open('vwr-cdn').then(async c => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      })
    );
  }
});
