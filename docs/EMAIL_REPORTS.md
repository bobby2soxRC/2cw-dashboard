# Email & reports

All outgoing email (reports, PIN reset links) is sent as
**2cw.reports@gmail.com** through Gmail's SMTP server (`smtp.gmail.com`),
by `netlify/lib/mailer.js`. Recipients see "2CW Productions
<2cw.reports@gmail.com>". Sent mail shows up in that account's Sent folder.
A personal Gmail account can send about 500 messages a day.

Why not services@somarosafarms.com: Gmail rejected its app password (535
BadCredentials) on 2026-10-15, and fixing that needs the company's Workspace
admin. Switching to it later only means changing `GMAIL_USER` and
`GMAIL_APP_PASSWORD` in Netlify.

## One-time setup

1. **Signed in as 2cw.reports@gmail.com**: Google Account → Security → turn
   on 2-Step Verification, then go to myaccount.google.com/apppasswords and
   create one named "2CW dashboard". Copy the 16-character password.
2. **Check it** before touching Netlify:
   `node scripts/test_gmail_login.js 2cw.reports@gmail.com` (paste the
   password; it signs in to Gmail without sending anything).
3. **Netlify** → Site configuration → Environment variables:
   | Variable | Value |
   |---|---|
   | `GMAIL_USER` | `2cw.reports@gmail.com` |
   | `GMAIL_APP_PASSWORD` | the app password (spaces are fine), marked secret |
   | `MAIL_FROM_NAME` | optional display name, default `2CW Productions` |
   | `OPS_REPORT_DAILY_TO` | comma-separated recipients for the daily report |
   | `OPS_REPORT_WEEKLY_TO` | comma-separated recipients for the weekly report |
4. Redeploy (Deploys → Trigger deploy → Deploy site). Functions only pick up
   env var changes on a new deploy.

If the account's password changes or 2-Step Verification is turned off, the
app password stops working; make a new one and update `GMAIL_APP_PASSWORD`.

## Operations & Staff Hours report

Built in `netlify/lib/ops_report.js`:
- **Staff hours** from Connecteam shifts (`data/connecteam_shifts.json`):
  totals, by site, by activity, by person, overtime flags (daily: over 8 / 12
  hrs; weekly: over 40 hrs or any day over 8), and missing clock-outs.
- **Labor $**: each shift's hours × the person's rate on that day from
  `labor_rates` (admin → Labor Rates; Connecteam user id, `*` default), the
  same lookup as the Labor Log (`rateFor`). Straight time only, no overtime
  premium; hours with no rate are listed as uncosted. Scheduled reports
  always include it; the on-demand button only for users with
  `labor log costs`.
- **Operations** from `operations_forms` in Supabase, per station: for
  Bucking, Hand Trim and Smalls (stations with a `dailySummary`), the pounds
  weighed in the period on every page, open ones included, counted by each
  row's own `day` (the forms' Daily Summary numbers) plus people. Other
  stations: lbs out on submitted forms (`dailyOutput`, as the operations
  dashboard). Also forms submitted and pages open right now.
- **Labor cost** box at the top: hourly staff (Connecteam hours × rate)
  and **trimmer piece pay** (each Hand Trim bag weighed in the period × its
  lot's Trimmer Rate $/lb; trimmers aren't in Connecteam) on separate lines,
  then the total. The overtime premium (½ rate past 8 hrs a day, 1× past 12;
  weekly also past 40) is shown on its own line, not in the total.
- **Cost per pound by process**: each clock-in's hours put on a station by
  its Connecteam activity (`PROCESS_RULES`: Hanging → Wet intake, Take down,
  Bucking, Trimming → Hand trim, Smalls, Twister → Machine trim, Pre-rolls);
  any hours at a farm site (not Adobe / Airway / Customer, not Packaging) are
  **Harvest**, since crews often clock in there as Maintenance. Hourly $ (+
  piece pay on Hand trim) ÷ the station's pounds; Harvest uses Wet Intake
  pounds when there's no Harvest form. Maintenance, Deleafing, Packaging etc.
  at Adobe aren't in a process. Without cost access it shows lbs / hr.
- **Trimming & bucking**: finished flower trimmed and trimmers weighed in,
  trimming $/lb, unfinished smalls pulled (end-of-run `smallsLb` on Hand Trim
  lots submitted in the period), bucked flower produced.
- **Overtime**: count and OT hours; the daily report names everyone over 10
  hrs with OT hrs, their week so far (Mon on) and OT premium, and lists
  everyone already at 32+ hrs this week (**Heading past 40**).

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
