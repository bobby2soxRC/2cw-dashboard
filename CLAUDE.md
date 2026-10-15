# 2CW Dashboard — notes for Claude

Static site on Netlify (`netlify/functions/` for server code), Supabase for
live data. Docs live in `docs/` — `OPERATIONS_APP.md` (station forms,
`operations_stations.js`), `USER_ADMIN.md` (users, admin panel) and
`EMAIL_REPORTS.md` (outgoing email, scheduled reports).

- All email goes out as services@somarosafarms.com via `netlify/lib/mailer.js`
  (Gmail SMTP + app password). Shared function code lives in `netlify/lib/`;
  `package.json` holds function deps (nodemailer).

- `sw.js` serves the app shell cache-first: bump `CACHE_VERSION` whenever a
  shell file changes (HTML pages, `operations_stations.js`, `ops_*.js`, …)
  or devices keep running the old version.
- Schema changes go in `supabase/schema.sql` (idempotent) and must be run in
  the Supabase SQL editor **before** pushing code that reads/writes the new
  columns.

## In progress

### Google sign-in (started 2026-10-10)

Moving everyone from PINs to Google over a few weeks. Step 1 is built: a
"Sign in with Google" button on `index.html` and
`netlify/functions/google-login.js`, which turns a linked Google login into
the user's PIN session (`app_users.auth_user_id`). Still to do: self-serve
linking, server functions accepting the Google login instead of `2cw_pin`,
then cutover. Plan and setup: "Google sign-in" in `docs/USER_ADMIN.md`.

### Emailed reports (started 2026-10-15)

Operations & Staff Hours report: daily, weekly (Mondays) and on demand
(✉ button on `staff_hours.html`), built in `netlify/lib/ops_report.js`.
Code is done; it sends nothing until the services@ app password and the
`OPS_REPORT_*_TO` recipient env vars are set in Netlify. Setup and how to
add more reports: `docs/EMAIL_REPORTS.md`.

## Parked work

### PIN reset by email (on hold since 2026-10-01)

Built and deployed, but not linked from anywhere:
- `reset_pin.html` — request-a-link page, and the choose-a-new-PIN page the
  emailed link opens.
- `netlify/functions/pin-reset.js` — sends the link (shared mailer, as
  services@), verifies it, sets the new PIN.
- `app_users.email` and `app_users.pin_reset_sent_at` columns already exist.

The sender was the blocker; as of 2026-10-15 it uses the shared Gmail mailer,
so it works once `GMAIL_USER` / `GMAIL_APP_PASSWORD` are set in Netlify.

To finish: make sure users have emails in `admin.html`, then add
`<a class="forgot-link" href="/reset_pin.html">Forgot your PIN?</a>` under the
login button in `index.html` (the style already exists) and bump
`CACHE_VERSION` in `sw.js`. Full details: "PIN reset by email" in
`docs/USER_ADMIN.md`.

Related, also deferred: `app_users` is anon-readable, so PINs, emails and
phones are visible from the browser. Moving the PIN check server-side would
fix that.
