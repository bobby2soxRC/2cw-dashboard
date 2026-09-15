// Shared service-worker registration + auto-update, loaded by every page.
//
// iOS/iPadOS home-screen shortcuts rarely get a fresh sw.js check when the
// app is resumed from the background — there's no real navigation/fetch on
// resume, so a stale cached shell can stick around until someone deletes and
// re-adds the shortcut. This forces a check whenever the page becomes
// visible again, and reloads once automatically the moment a new service
// worker actually takes control (not on first install, so new visitors
// don't get an unnecessary reload).
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;

  // Re-caching the app shell (~40 files) on install takes a few seconds —
  // a silent wait during that window is exactly what pushes people to
  // hard-refresh instead of trusting the page will update on its own. This
  // shows something's happening from the moment a new version starts
  // installing, not just in the instant before the reload fires.
  function showUpdatingToast() {
    if (document.getElementById('sw-update-toast')) return;
    const el = document.createElement('div');
    el.id = 'sw-update-toast';
    el.textContent = 'Updating…';
    el.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;' +
      'background:#13151a;color:#e8eaf0;border:1px solid #1e2129;border-radius:10px;' +
      'padding:.6rem 1rem;font:12px/1.4 "DM Mono",monospace,monospace;letter-spacing:.05em;' +
      'text-transform:uppercase;box-shadow:0 4px 16px rgba(0,0,0,.4);pointer-events:none;';
    document.body.appendChild(el);
  }
  function removeUpdatingToast() {
    const el = document.getElementById('sw-update-toast');
    if (el) el.remove();
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    showUpdatingToast();
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      reg.update();
      const recheck = () => { if (document.visibilityState === 'visible') reg.update(); };
      document.addEventListener('visibilitychange', recheck);
      window.addEventListener('pageshow', recheck);

      reg.addEventListener('updatefound', () => {
        if (!hadController) return; // first-ever install for this browser, nothing to announce
        const installing = reg.installing;
        if (!installing) return;
        showUpdatingToast();
        installing.addEventListener('statechange', () => {
          // Install failed (e.g. a shell file didn't fetch) — don't leave
          // "Updating…" on screen forever for an update that isn't coming.
          if (installing.state === 'redundant') removeUpdatingToast();
        });
      });
    }).catch(err => console.warn(err));
  });
}
