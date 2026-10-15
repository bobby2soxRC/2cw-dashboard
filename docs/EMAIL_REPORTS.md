# Email & reports

All outgoing email (reports, PIN reset links) is sent as
**services@somarosafarms.com** through Google Workspace's SMTP server
(`smtp.gmail.com`), by `netlify/lib/mailer.js`. Sent mail shows up in that
mailbox's Sent folder. Gmail allows a Workspace account about 2,000 messages
a day.

## One-time setup

1. **Allow app passwords** (Workspace admin, admin.google.com): Security →
   Authentication → 2-Step Verification → let users turn it on. App
   passwords only exist for accounts with 2-Step Verification on.
2. **Signed in as services@somarosafarms.com**: Google Account → Security →
   turn on 2-Step Verification, then Security → App passwords → create one
   named "2CW dashboard". Copy the 16-character password.
3. **Netlify** → Site configuration → Environment variables:
   | Variable | Value |
   |---|---|
   | `GMAIL_USER` | `services@somarosafarms.com` |
   | `GMAIL_APP_PASSWORD` | the app password (spaces are fine) |
   | `MAIL_FROM_NAME` | optional display name, default `2CW Productions` |
   | `OPS_REPORT_DAILY_TO` | comma-separated recipients for the daily report |
   | `OPS_REPORT_WEEKLY_TO` | comma-separated recipients for the weekly report |
4. Redeploy (functions only pick up env var changes on a new deploy).

If services@ ever changes its password or turns 2-Step Verification off, the
app password stops working; make a new one and update `GMAIL_APP_PASSWORD`.

Optional, for deliverability: somarosafarms.com has no SPF record. Adding a
TXT record `v=spf1 include:_spf.google.com ~all` (DNS is at
name-services.com) and turning on DKIM in the Workspace admin
(Apps → Google Workspace → Gmail → Authenticate email) keeps reports out of
spam folders.

## Operations & Staff Hours report

Built in `netlify/lib/ops_report.js`:
- **Staff hours** from Connecteam shifts (`data/connecteam_shifts.json`):
  totals, by site, by activity, by person, overtime flags (daily: over 8 / 12
  hrs; weekly: over 40 hrs or any day over 8), and missing clock-outs.
- **Operations** from submitted `operations_forms` in Supabase: forms and lbs
  out per station (same `dailyOutput` numbers as the operations dashboard),
  plus pages open right now.

| When | Function | Covers | Goes to |
|---|---|---|---|
| Daily, 14:00 UTC (7am PDT / 6am PST) | `ops-report-daily.js` | yesterday | `OPS_REPORT_DAILY_TO` |
| Mondays, 14:00 UTC | `ops-report-weekly.js` | last Mon–Sun | `OPS_REPORT_WEEKLY_TO` |
| On demand | `ops-report.js` | today so far, or the last 7 days | the person asking |

Schedules are in `netlify.toml`. A scheduled report with no recipients set
just logs and skips. Netlify → Functions → the function's page shows its logs
and has a "Run now" button for scheduled functions.

On demand: **✉ Email report** on `staff_hours.html`. It needs the person's
`staff hours` permission and an email address on their account in
`admin.html`.

## Adding another report

Write a builder next to `ops_report.js` that returns `{subject, html, text}`,
then a scheduled function like `ops-report-daily.js` and a `schedule` entry in
`netlify.toml`. Use `sendMail` from `netlify/lib/mailer.js`. Keep shared code
in `netlify/lib/`, not `netlify/functions/` (everything there is deployed as
a function).
