# 2CW Dashboard — notes for Claude

Static site on Netlify (`netlify/functions/` for server code), Supabase for
live data. Docs live in `docs/` — `OPERATIONS_APP.md` (station forms,
`operations_stations.js`), `USER_ADMIN.md` (users, admin panel) and
`REPORTS.md` (emailed Intake & Drying report, `/intake-drying-report` skill).
Netlify function dependencies are in `package.json` (no build step).

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
