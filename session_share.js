// Shares the PIN login between tabs.
//
// The login lives in sessionStorage ('2cw_pin', '2cw_user_name', the access
// keys index.html's buildHub writes), which is per tab: a page opened in a new
// tab used to start with none of it and bounce to the PIN screen. Loaded first
// in <head> on every page that checks '2cw_pin', this copies the 2cw_* keys of
// a logged-in tab into localStorage ('2cw_session') and, in a tab that has no
// login yet, copies them back before the page's own check runs.
//
// The copy only counts while a logged-in tab was in use recently (FRESH):
// it's refreshed every minute while a tab is visible and whenever one is
// hidden or closed, so closing every tab still logs you out after a while.
// Logging out (TwoCWSession.logout(), from index.html) drops the copy and
// sends every other open tab to the PIN screen.
(function () {
  var KEY = '2cw_session', BYE = '2cw_logout', FRESH = 15 * 60 * 1000;
  var ss, ls;
  try { ss = window.sessionStorage; ls = window.localStorage; ss.getItem('x'); ls.getItem('x'); } catch (e) { return; }

  function ours(k) { return k && k.indexOf('2cw_') === 0 && k !== '2cw_return'; }
  function save() {
    try {
      if (!ss.getItem('2cw_pin')) return;
      var data = {};
      for (var i = 0; i < ss.length; i++) { var k = ss.key(i); if (ours(k)) data[k] = ss.getItem(k); }
      ls.setItem(KEY, JSON.stringify({ at: Date.now(), data: data }));
    } catch (e) { /* storage full or blocked: the tab still works on its own */ }
  }
  function clearTab() {
    var ks = [];
    for (var i = 0; i < ss.length; i++) { var k = ss.key(i); if (ours(k)) ks.push(k); }
    ks.forEach(function (k) { ss.removeItem(k); });
  }

  // A new tab: take the login from the shared copy, if it's fresh.
  if (!ss.getItem('2cw_pin')) {
    try {
      var m = JSON.parse(ls.getItem(KEY) || 'null');
      if (m && m.data && m.data['2cw_pin'] && Date.now() - m.at < FRESH) {
        Object.keys(m.data).forEach(function (k) { if (ours(k)) ss.setItem(k, m.data[k]); });
      } else if (m) {
        ls.removeItem(KEY);
      }
    } catch (e) { /* a bad copy: log in as before */ }
  }

  save();
  setInterval(function () { if (document.visibilityState === 'visible') save(); }, 60 * 1000);
  document.addEventListener('visibilitychange', save);
  window.addEventListener('pagehide', save);

  // Logged out in another tab: this one goes too.
  window.addEventListener('storage', function (e) {
    if (e.key !== BYE || !e.newValue) return;
    clearTab();
    if (!/^\/(index\.html)?$/.test(location.pathname)) location.replace('/index.html');
    else location.reload();
  });

  window.TwoCWSession = {
    save: save,
    logout: function () {
      try { ls.removeItem(KEY); ls.setItem(BYE, String(Date.now())); } catch (e) { /* nothing shared to drop */ }
    }
  };
})();
