// 2CW Operations Hub - service worker
// Cache-first app shell; live data always goes to the network.
const CACHE_VERSION = 'v4';
const CACHE_NAME = '2cw-shell-' + CACHE_VERSION;

const APP_SHELL = [
  '/index.html',
  '/2cw_portal.html',
  '/commission.html',
  '/executive.html',
  '/inventory.html',
  '/kss_dashboard.html',
  '/mendo.html',
  '/pipeline.html',
  '/sales.html',
  '/twocw_dashboard.html',
  '/field_forms.html',
  '/form_budtender_training.html',
  '/form_buyer_meeting.html',
  '/form_staff_sample.html',
  '/form_store_visit.html',
  '/forms_common.js',
  '/manifest.json',
  '/favicon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png'
];

// Domains/paths that serve live data and must never be served from cache.
const NEVER_CACHE_HOSTS = [
  'raw.githubusercontent.com',
  'api.github.com',
  'github.io',
  'docs.google.com'
];

function isLiveData(url) {
  if (NEVER_CACHE_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    return true;
  }
  // Same-origin data files are synced nightly and must stay live too.
  if (url.origin === self.location.origin && url.pathname.startsWith('/data/')) {
    return true;
  }
  return false;
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;

  if (isLiveData(url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
