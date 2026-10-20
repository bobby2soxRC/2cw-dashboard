# 2CW Dashboard — notes for Claude

Static site on Netlify (`netlify/functions/` for server code), Supabase for
live data. Docs live in `docs/` — `OPERATIONS_APP.md` (station forms,
`operations_stations.js`), `USER_ADMIN.md` (users, admin panel) and
`EMAIL_REPORTS.md` (outgoing email, scheduled reports).

- All email goes out as 2cw.reports@gmail.com via `netlify/lib/mailer.js`
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
Code is done; it sends nothing until the Gmail app password and the
`OPS_REPORT_*_TO` recipient env vars are set in Netlify. Setup and how to
add more reports: `docs/EMAIL_REPORTS.md`.

### Metrc Queue (started 2026-10-16)

`metrc.html` (hub card under Operations): submitted Wet Intake, Take Down,
Bucking, Hand Trim and Pre-Roll forms with a Metrc status per form, saved
through `netlify/functions/metrc-queue.js`. Needs the `metrc_queue` table
from `supabase/schema.sql` run first. Details: "Metrc Queue" in
`docs/OPERATIONS_APP.md`.

### Wet Intake details from Canix (started 2026-10-17)

The Wet Intake form no longer asks for farm license, CID, manifest # or
driver: scan the UID and weigh. `scripts/canix_sync.py`
(`fill_intakes_from_canix`) fills them in on submitted intakes through the
Supabase function `fill_intake_from_canix`; until then the intake shows
"Waiting for Metrc sync". When Canix's strain for the package isn't the
intake's (allowing Strain Library aliases), Harvest Intakes and the Today
board show "Check strain". Details: "Wet Intake: Metrc details come from the
Canix sync" in `docs/OPERATIONS_APP.md`.

### Crew Check-In (started 2026-10-18)

`crew_checkin.html` (Workforce card, for anyone with Master Schedule or Labor
Log): leads check in their Master Schedule crews once a shift (Here / Not
here / add) and **Move** people to another project at a time, or home. It
saves on the project's day (`overrides[date].here` / `.times`), and
`personSpans` in `operations_stations.js` turns that into each person's
hours, used by Master Schedule (conflicts, timeline, CSV) and the Labor Log's
Auto-assign, which splits clocked time at the move. Checked-in people's
clocked time is also logged automatically every hour
(`scripts/labor_autoassign.js`, last step of the Connecteam Hourly Sync;
shared logic in `labor_auto.js`). No SQL. Details: "Crew Check-In" in
`docs/OPERATIONS_APP.md`.

### Master Schedule: import day plan (started 2026-10-19)

The crew lead plans the day in `templates/Plan_Proyectos_Template.xlsx`
(one block per project, a responsibility beside each name); **⇪ Import day
plan** on Master Schedule's Projects tab reads it (`day_plan.js`), matches
names to the Connecteam roster, previews, and creates that day's projects.
Rebuild the template with `scripts/make_day_plan_template.py`; tests:
`node scripts/test_day_plan.js`. Details: "Import day plan" in
`docs/OPERATIONS_APP.md`.

### Raw Materials Inventory (started 2026-10-19)

`raw_inventory.html` (Operations card, admin column `raw inventory`): on-hand
material by stage from the station forms — All / Drying / On-Stem / Bucked /
Flower / Smalls / Trim / Fresh Frozen — with search and CSV export. Finished
stock that leaves without a form is marked Used up (shared
`operations_forms` row `raw_inventory_marks`). No SQL. Details: "Raw
Materials Inventory" in `docs/OPERATIONS_APP.md`.

### Hourly people not in Connecteam (started 2026-10-19)

Admin → Labor Rates → **+ Add person**: name, badge #, phone, for hourly
workers (e.g. trimmers) who aren't in Connecteam. They get ID X1, X2, … in
place of a Connecteam id, so rates, badges and the Labor Log work for them.
Needs the `labor_people` table from `supabase/schema.sql` run first.
Details: "Labor rates" in `docs/USER_ADMIN.md`.

### Harvest form: license tables, plate & driver dropdowns (started 2026-10-19)

Harvest (`operations_stations.js`) lost farm site / license / round /
harvest style / destination; it has a Fresh Frozen checkbox, a License Plate
dropdown (the `trucks` table + plates used on past Harvest forms + Other —
Canix transfers carry no plates) and a Driver dropdown from the `drivers`
table (`netlify/functions/drivers.js`; add a driver with name, ID # and ID
photo). The worksheet is license → strain box (scan a plant tag; strain from
Canix plant batches; location, Transfer UID) → bins (weight, plant count) —
`buildLotSheet` in `ops_form.html`. After submit it offers a picture + CSV
of the load to send on WhatsApp (`openShare`). Admin → Drivers and Trucks
adds and edits both and shows the ID photos. The `drivers` and `trucks`
tables are already created in Supabase. Details: "Harvest" in
`docs/OPERATIONS_APP.md`, "Drivers and Trucks" in `docs/USER_ADMIN.md`.

### Hand Trim output tags from the Metrc Queue (started 2026-10-19)

Hand Trim's outputs (finished flower, smalls, Normal / A+ trim) each get a new
Metrc tag, which only exists once the package is made in Metrc — so they're
entered in the Metrc Queue's opened form ("New Metrc tags"), not on the floor
form, and saved onto the record by `netlify/functions/metrc-queue.js`. Waste
stays on the source tag. The list is `metrcTags` on the station in
`operations_stations.js`. No SQL. Details: "New Metrc tags" in
`docs/OPERATIONS_APP.md`.

### Run Canix Sync from Admin (started 2026-10-19)

Admin → **Data Syncs**: **Run Canix Sync now** starts the
`canix_sync.yml` GitHub workflow and lists its last runs, through
`netlify/functions/canix-sync.js`. Needs a `GITHUB_TOKEN` (fine-grained,
Actions read/write on this repo) in Netlify. Details: "Data Syncs" in
`docs/USER_ADMIN.md`.

### Incoming transfers deadline (started 2026-10-20)

Metrc Queue (`metrc.html`) has an **Incoming transfers to accept** section:
transfers to our licenses not yet accepted, from the Canix sync, with the
24-hour accept deadline (4 CCR § 15049(b), counted from departure) — Urgent
at ≤ 8 h left, Overdue past it. Logic in `metrc_transfers.js`; tests:
`node scripts/test_metrc_transfers.js`. Outside farms' transfers aren't in
Canix until accepted, so those come from Wet Intakes whose package isn't in
our Canix inventory yet (clock from the intake). No SQL. Details: "Incoming transfers to accept" in
`docs/OPERATIONS_APP.md`.

### Bucked tags only when held; mixed trim; outgoing transfers (started 2026-10-20)

From a process talk with Kevin and Alonzo. Bucking makes no new Metrc tag
unless the lot is ticked **Holding as bucked flower** (`holdBucked`; the
Metrc Queue then asks for `newBuckedUid`). Hand Trim's trim outputs no
longer get per-strain tags (`when: () => false` in its `metrcTags`); a new
**Mixed Trim Package** form (`trim_package`) lists the trim packaged
together and gets one tag. New **Product Transfer — Outgoing** form
(`transfer_out`, from the paper v7 form; product codes `TRANSFER_TYPES`).
Both new forms are in the Metrc Queue and take stock off Raw Inventory. No
SQL. Users need the new stations ticked in Admin to see them. Details in
`docs/OPERATIONS_APP.md` ("Holding as bucked flower", "Mixed Trim Package",
"Product Transfer — Outgoing").

### Ground Flower Pouches (started 2026-10-20)

New Manufacturing form `pouch_production` (`operations_stations.js`), a copy
of Pre-Roll Production for pouches of ground flower (Howie Roll 14 g for
now): Pouch Output log, `totalPouches`, `newPouchUid`. Its work orders share
the pre-roll queue so the team ranks both in one list — `QUEUE_LINES` /
`queueLine` in `preroll_queue.js`: a product or Sheet request whose name says
"Ground" is pouches. Needs a "Ground" product added in the Pre-Roll
Dashboard's Products (with the Sheet's BSKU) to queue pouches by hand. No
SQL. Users need the station ticked in Admin. Details: "Ground Flower
Pouches" in `docs/OPERATIONS_APP.md`.

### Hand Trim — Past Records (started 2026-10-20)

New Processing form `hand_trim_history` for typing in old paper hand trim
sheets: a copy of Hand Trim in `STANDALONE_STATIONS` (`operations_stations.js`),
kept out of `OPERATIONS_STATIONS` / `STATION_BY_KEY` so no inventory, Metrc,
labor, dashboard or report code sees it (only the hub, admin access and
`ops_form.html` use `ALL_STATIONS`). Report: `hand_trim_history.html` (by lot,
by trimmer, CSV, print). No SQL. Users need the station ticked in Admin.
Details: "Hand Trim — Past Records" in `docs/OPERATIONS_APP.md`.

## Parked work

### PIN reset by email (on hold since 2026-10-01)

Built and deployed, but not linked from anywhere:
- `reset_pin.html` — request-a-link page, and the choose-a-new-PIN page the
  emailed link opens.
- `netlify/functions/pin-reset.js` — sends the link (shared mailer, as
  2cw.reports@gmail.com), verifies it, sets the new PIN.
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
