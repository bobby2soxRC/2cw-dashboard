// 2CW Operations Hub - service worker
// Cache-first app shell; live data always goes to the network.
const CACHE_VERSION = 'v22';
const CACHE_NAME = '2cw-shell-' + CACHE_VERSION;

const APP_SHELL = [
  '/index.html',
  '/hub_config.js',
  '/sw_register.js',
  '/admin.html',
  '/2cw_portal.html',
  '/commission.html',
  '/executive.html',
  '/inventory.html',
  '/kss_dashboard.html',
  '/mendo.html',
  '/pipeline.html',
  '/production.html',
  '/sales.html',
  '/twocw_dashboard.html',
  '/menu_health.html',
  '/staff_hours.html',
  '/field_forms.html',
  '/form_budtender_training.html',
  '/form_buyer_meeting.html',
  '/form_staff_sample.html',
  '/form_store_visit.html',
  '/forms_common.js',
  '/operations.html',
  '/ops_form.html',
  '/operations_dashboard.html',
  '/operations_today.html',
  '/buck_station.html',
  '/operations_stations.js',
  '/ops_common.js',
  '/ops_analytics.js',
  '/ops_data.js',
  '/buck_data.js',
  '/config/supabase_config.js',
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
  // Menu imagery is swapped in place by marketing/design under fixed filenames —
  // cache-first would keep serving a stale photo indefinitely after a swap.
  if (url.origin === self.location.origin && url.pathname.startsWith('/img/menu/')) {
    return true;
  }
  return false;
}

// Operations data is live like everything under /data/, but the station forms
// have to keep working in a dry room with no signal — so these get the fresh
// copy when there is a network and the last good copy when there isn't.
function isOperationsData(url) {
  return url.origin === self.location.origin && url.pathname.startsWith('/data/operations/');
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

  if (isOperationsData(url)) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request, { ignoreSearch: true }))
    );
    return;
  }

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
