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

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      reg.update();
      const recheck = () => { if (document.visibilityState === 'visible') reg.update(); };
      document.addEventListener('visibilitychange', recheck);
      window.addEventListener('pageshow', recheck);
    }).catch(err => console.warn(err));
  });
}
