/* Service worker: makes Cash Flow installable and fully usable offline.
   Bump VERSION whenever any app file changes so phones pick up the update. */
const VERSION = 'cashflow-v3.8.1';
const SHELL = [
  './', 'index.html', 'privacy.html', 'styles.css', 'app.js', 'parser.js', 'gdrive.js', 'sync.js', 'analytics.js', 'manifest.webmanifest',
  'vendor/chart.umd.min.js', 'vendor/xlsx.full.min.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/jspdf.umd.min.js', 'vendor/jspdf.plugin.autotable.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-192.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];
const FONT_CACHE = 'cashflow-fonts';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== FONT_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts: serve from cache, refresh in the background
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONT_CACHE).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // config.js (generated settings): network first so a changed setting arrives at once; cached copy when offline
  if (url.pathname.endsWith('/config.js')) {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(VERSION).then(k => k.put(req, c)); } return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || new Response('window.CF_CONFIG={};', { headers: { 'Content-Type': 'text/javascript' } }))));
    return;
  }

  // App files: cache first (works offline); page navigations fall back to the cached shell
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).catch(() =>
    req.mode === 'navigate' ? caches.match('index.html') : Response.error())));
});
