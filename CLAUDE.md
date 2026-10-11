# 2CW Dashboard — notes for Claude

Static site on Netlify (`netlify/functions/` for server code), Supabase for
live data. Docs live in `docs/` — `OPERATIONS_APP.md` (station forms,
`operations_stations.js`) and `USER_ADMIN.md` (users, admin panel).

- `sw.js` serves the app shell cache-first: bump `CACHE_VERSION` whenever a
  shell file changes (HTML pages, `operations_stations.js`, `ops_*.js`, …)
  or devices keep running the old version.
- Schema changes go in `supabase/schema.sql` (idempotent) and must be run in
  the Supabase SQL editor **before** pushing code that reads/writes the new
  columns.

## Parked work

### PIN reset by email (on hold since 2026-10-01)

Built and deployed, but not linked from anywhere:
- `reset_pin.html` — request-a-link page, and the choose-a-new-PIN page the
  emailed link opens.
- `netlify/functions/pin-reset.js` — sends the link via Resend, verifies it,
  sets the new PIN.
- `app_users.email` and `app_users.pin_reset_sent_at` columns already exist.

On hold because there's no sending address yet. Resend needs a domain we
own with DNS access; a plain Gmail account won't work with Resend. If there's
no domain, the alternative is switching `pin-reset.js` to send via Gmail
(nodemailer + an app password; env vars `GMAIL_USER`, `GMAIL_APP_PASSWORD`).

To finish: get a sender working (Resend: `RESEND_API_KEY` and `RESEND_FROM`
env vars in Netlify), make sure users have emails in `admin.html`, then add
`<a class="forgot-link" href="/reset_pin.html">Forgot your PIN?</a>` under the
login button in `index.html` (the style already exists) and bump
`CACHE_VERSION` in `sw.js`. Full details: "PIN reset by email" in
`docs/USER_ADMIN.md`.

Related, also deferred: `app_users` is anon-readable, so PINs, emails and
phones are visible from the browser. Moving the PIN check server-side would
fix that.

### Harvest status report for Ned (requested 2026-10-11)

A recurring report to show at a glance that harvest is going well, emailed
out once a sender exists (see the PIN reset entry — same blocker). Ned
agreed these are "an amazing start":
- Pounds harvested each day, last 7 days (`intake_wet` forms, `totalWetLb`
  by `work_date`; fresh frozen = lines/forms with `freshFrozen` ticked).
- Labor spent, last 7 days: Connecteam hours (`data/connecteam_shifts.json`)
  × a blended $/hr (Robert OK'd blended; rate still to be given — the real
  per-person rates in `labor_rates` are service-role only).
- That labor as $ per wet lb, and estimated $ per lb of dried flower
  (needs a wet→dry yield; see "Stage yields" in `ops_analytics.js`).
- % of each farm left to harvest (expected `drying_intakes.est_wet_lb` /
  `harvests[].lb` vs wet lb received so far).

Blocked in Claude cloud sessions until the environment's network access
allows `ugtxmyciyuelxxzqmrdx.supabase.co`.
