# 2CW Operations App

Replaces the hand-written station paperwork — and the retyping into
spreadsheets that follows it — with tablet forms that total themselves,
autosave as someone works through their day, and can be picked back up on a
different tablet if the first one dies or a shift changes hands. Built into
the existing Operations Hub — same login, same Netlify deploy.

## What's here

| File | What it is |
|---|---|
| `operations.html` | Station picker, grouped by department, with "continue" chips for your open drafts |
| `ops_form.html` | The form for every station, rendered from the schema, with autosave + resume |
| `buck_station.html` | Bucking's own 4-tab page (Today / Batches / Employee / Historical) — see below, doesn't use `ops_form.html` |
| `buck_data.js` | Bucking's data layer — submissions, boxes, batch close-out. Reuses `operations_forms`, no schema changes |
| `labor_log.html` | Labor Log — people's hours (Connecteam roster) against UIDs, split across several UIDs when needed — see below |
| `master_schedule.html` | Master Schedule — projects, their responsibilities and people, UIDs, and the day/week work schedule (replaced `schedule.html`) — see below |
| `operations_today.html` | Live board — every form in progress or finished today, for anyone with view access |
| `operations_dashboard.html` | Pipeline, yields, biomass, labor, requests, exceptions (finished forms only) |
| `operations_stations.js` | **The schema.** Station and field definitions, EN + ES |
| `ops_common.js` | Language, reference-data loading, the legacy offline queue |
| `ops_data.js` | Supabase-backed drafts, autosave, live "Today" queries |
| `ops_analytics.js` | Lot tracking, yields, biomass ledger, labor, exceptions |
| `supabase/schema.sql` | Run once in a new Supabase project — see setup below |
| `config/supabase_config.js` | Your project's URL + anon key go here |
| `netlify/functions/upload-operations-photo.js` | Photo storage (stays in GitHub, alongside the field-form photos) |
| `netlify/functions/submit-operations.js` | The old single-shot submit path — kept as the fallback when Supabase isn't configured |
| `data/operations/reference.json` | Farms, dry rooms, machines, brands; fallback strain list (the live one is the Strain Library) |
| `data/operations/<station>.json` | Fallback data source when Supabase isn't configured; otherwise unused |
| `scripts/test_ops_analytics.js` | `node scripts/test_ops_analytics.js` |
| `scripts/seed_demo_operations.js` | Demo data for the static-fallback dashboard; `--clear` to empty |

## Stations

**Cultivation** *(placeholder — see below)* — Plant Batch Log · IPM / Feed Log · Pre-Harvest Inspection
**Harvest** — Harvest · Fresh Frozen
**Drying** — Harvest Intake — Wet · Take Down — Dry
**Processing** — Bucking · Machine Trim · Hand Trim / Hand Touch · Smalls Hand Trim
**Manufacturing** — Biomass Request · Pre-Roll Production · Manufacturing Run

Wet Intake and Take Down are the two halves of the paper "Harvest Intake &
Take Down Log", 5–10 days apart: Wet Intake is one form per truck, with the
farm package UID and strain on each bin weigh-in row (bins weighed net of
tare). On submit it's split into one record per UID (`splitBy: 'lines'` on
the station; `splitRecords` in `ops_form.html`), each holding only its own
rows and totals, so everything downstream still sees one package per
record. With more than one UID on the form the Metrc-adjustment fields hide;
they're filled in per intake afterwards from Harvest Intakes. Take Down (station key `dry_check`)
boxes the dried material under a new on-stem package UID. The form starts
with the drying room, then the package from a dropdown of what's still
drying in that room ("Strain - last 4 of UID"; "Not listed" falls back to
typing the UID); the room dropdown shows how many are drying in each. Picking
it pulls strain/farm license/CID/wet weight from the intake record (picking
another replaces those), and
`ops_analytics` aliases the on-stem UID back to the farm UID so it stays one
lot. Bucking opens a batch for every Take Down released to bucking.

**Currently drying** means a submitted Wet Intake with no submitted Take Down
for its farm UID (`currentlyDrying` / `matchTakeDowns` in `ops_common.js`;
UIDs match when one ends with the other, 4+ characters). Fresh-frozen intakes
never count as drying. Any submitted Take Down counts, whatever its Release.
Release is **Release to bucking** (`pass`, the default — the only one Bucking
opens a batch for), **Hold — quality issue** (`rework`) or **Hold — until
needed for an order** (`hold_order`). Material that needs more dry time just
isn't taken down yet; the old `hold` value only appears on older records. The same rule drives the Take Down picker, Harvest
Intakes' **Currently drying** / **Historical** filters (Currently drying is
the default; drafts count as drying; Historical is taken-down and
fresh-frozen intakes), and Canix Inventory → Processing → Currently Drying,
which leaves out Canix packages that already have a Take Down until Metrc and
the next sync catch up.

Harvest (`harvest`) is the step before Wet Intake and is built the same
way: one form per truck load, a worksheet row per group of bins/bags with
its Metrc UID, strain, harvest/batch name, the block and row the plants
came from, plant count, bins/bags and wet weight (all required; block
carries down to the next row, row doesn't), split into one record per UID on submit. The batch
name column has `lift: true`, so it's copied onto each UID's record like
the UID and strain. Header fields required: farm license, harvest style,
destination, license plate and photo of the driver's ID; truck # is
optional. There are no crew/labor fields — harvest labor goes in the
Labor Log. Photos aren't
autosaved, so a resumed draft needs the driver ID photo retaken before it
can be submitted.

Pre-Roll Production (`preroll_production`) follows the paper pre-roll sheet
and is the one form that stays open across days: its station entry sets
`multiDay: true`, so the form's switcher lists every open draft on that
station (anyone's, any start date) instead of just your own from today.
People add rows to its Workforce Log (employee ID, date, start, end; hours
are worked out per row) each day they work the batch, and it's submitted
once QC and the secondary verification are done. The log is the station's
`crew` field, so `crewLaborLog` reports each shift on the day it was worked.
Two people editing the same open batch at the same moment can overwrite each
other's rows (last save wins), so one tablet per batch is safest.

**Smalls Hand Trim** (`smalls_trim`) is the paper "Work Order Form (Smalls |
By the Hourly)": one page per flavor per day — package UID, strain, starting
lbs, then the weighing worksheet (employee #, grams, one row per bag), with
grams → lbs worked out (÷ 453.592, not the form's "× 454"), shake, waste and
variance, and the back-of-form initials (waste adjusted, processor inventory)
plus manager notes. No farm license, CID or grade — those come from the UID.
A page is filled in over the whole day and autosaves; someone who closes it
and reopens the station gets a blank page with a note pointing at the open
flavor pages in the switcher. Two station
options drive it, both handled in `ops_form.html`:
- `sharedDay: true` — the switcher at the top ("Flavors open") lists every
  open smalls page from anyone, not just your own, plus "+ New flavor", so
  the room can jump between the flavors running that day. Older pages still
  open show their date.
- `dailySummary: { lines, empCol, valueCol }` — a panel under the form that
  replaces the notebook tally: employee # down the side, each flavor page
  across the top, grams in each cell, totals both ways and lbs per person.
  Built from every form on the station for the picked date (drafts and
  submitted), with the page you're on using its live values.
Its flow is smalls in → finished smalls + shake + waste, and
its worksheet rows feed the Labor tab the same way Hand Trim's do.

**Pre-Roll Dashboard** (`preroll_dashboard.html`, hub card `preroll_dashboard`
under Manufacturing) is the pre-roll team's queue. It reads the Production
Requests Sheet live (same published CSV as `production.html`) and keeps only
pre-roll products: the BSKU's 2-digit category code is `02` (no BSKU → the
product name says pre-roll). The Sheet's Crew column is ignored, because flower
packouts can be crewed by the pre-roll team. For each request the team saves a
plan in the `preroll_plans` Supabase table (keyed by PR#): strain, optional
source UID, estimated start/completion, lead, on-hold, notes. "Start batch"
opens Pre-Roll Production with `?set_prNum=…&set_strain=…` (any form accepts
`set_<fieldKey>` starting values on a brand-new form), and the dashboard
reads those forms back by `prNum`: an open draft means in production, a
submitted one means done, and the total pre-rolls made shows as progress.
A request is late if its plan finishes after the Sheet's Ready Date, or the
Ready Date has passed. English/Spanish via the shared `2cw_lang` toggle.

**Harvest Intakes** (`harvest_intakes.html`, hub card `harvest_intakes` under
Processing) lists every Wet Intake, drafts and submitted, newest first, with
a "Metrc not adjusted" filter. Clicking one shows the whole record. Access is
two checkboxes in the admin user editor: View (`harvest_intakes` column) and
Edit (`harvest intakes edit`, implies view), turned into `2cw_intake_access`
at hub login. Edit reopens a submitted intake in `ops_form.html?edit=<id>`:
no autosave, and Save goes through `updateSubmitted()` in `ops_data.js`,
which only touches rows still `submitted`. The original submitter and
`submitted_at` stay; `updated_by` and `fields.lastEditedBy/lastEditedAt`
record who changed it. This is how a second person records the Metrc
adjustment (`metrcAdjusted` + `metrcAdjustedLb`) after someone else did
the intake.

Two more checkboxes there, each implying View: **Delete** (`harvest intakes
delete`) and **See edit history** (`harvest intakes history`), turned into
`2cw_intake_delete` / `2cw_intake_history` at login. Both only show the
buttons; the work goes through `netlify/functions/operations-records.js`,
which looks the person up in `app_users` from their PIN and re-checks the
permission with the service role key. Delete requires a reason and calls the
`delete_operations_form()` database function; anon has no DELETE on
`operations_forms`.

Edit history lives in `operations_forms_history`, written by a trigger on
`operations_forms` (so it catches changes from any page or direct API call,
and nothing in the browser can write to or erase it). Logged: the record as
first submitted, every change after that (field, before, after, who, when —
weigh-in rows by row number), and deletions with a full copy of the record,
who, and why. Draft autosaves aren't logged; tracking starts at submit.
Records submitted before the history existed have no baseline. With See
edit history, each intake shows its history at the bottom, edited intakes get
an "Edited" tag, and a "Deleted" filter lists deleted intakes. Who made an
edit is the app's logged-in name (`updated_by`), which the browser supplies —
the same trust level as everything else on `operations_forms` (see the RLS
note in `supabase/schema.sql`); for deletes it's verified from the PIN.

**Information Hub** (`information_hub.html`, hub card `information_hub`
under Operations) holds the reference lists the rest of the app runs on, one
tab each: Strain Library, Canix Facilities, Yield Forecasts, Farm Licenses,
Customer IDs. The last four used to be admin-panel tabs. `INFO_HUB_SECTIONS`
in `hub_config.js` lists the sections and their `app_users.columns` View/Edit
pair (edit implies view); the admin user editor draws its "Information Hub"
checkboxes from it, and hub login turns them into `2cw_info_access`
(`{ strains: 'edit', canix: 'view', … }`). The card shows if any section is
viewable; each tab is read-only or editable to match. Strains, licenses and
CIDs read/write Supabase directly (open anon policies). Canix facilities and
yield forecasts are read directly but saved through `canix-facilities.js` /
`canix-forecast.js`, which accept either the admin token or a hub user's
login PIN — the PIN is looked up in `app_users` server-side and the
section's edit column checked there. `strain_library.html` just redirects to
`information_hub.html#strains`.

**Strain Library** (Information Hub tab) is the list every Strain dropdown
offers. It lives in the Supabase table `strains` (name, abbreviation,
sources = Genetics ID, dominance, aliases, notes, active), seeded from
`reference.json`; `loadReference()` swaps it in for the file's `strains`
list, which is only the fallback when Supabase can't be reached. Access
columns are `strain_library` / `strain library edit` (kept from when it was
its own card). Edit can add, rename and retire strains (retired = off the
dropdowns, kept in the library); there's no delete. Renaming doesn't rewrite
records already submitted under the old name, so the old name goes in
`aliases`. Edit also gets Download CSV / Upload CSV: the upload matches rows
by `id` (or name, for new rows), is previewed (new / changed / problems)
before saving, and never deletes — strains missing from the file are left
alone.

**Customer documents** — each customer (CID) can have a signed MSA, any
number of licenses (with license # and expiry; expired ones show red), and a
W-9, attached from the Customer IDs tab's Documents column. Access is its own
Information Hub pair, `customer documents` / `customer documents edit` (key
`custdocs`, `tab: false` — it opens the Customer IDs tab read-only if the
person can't otherwise see it), kept apart from CIDs because a W-9 carries a
tax ID. Files are in the private Storage bucket `customer-docs`, metadata in
`customer_documents`; neither has an anon policy, so all of it goes through
`netlify/functions/customer-docs.js`, which checks the caller's PIN against
`app_users` first. Uploads go browser → Storage on a one-time signed upload
URL the function issues (Netlify's ~6 MB body cap), then `save` records the
row; downloads are signed URLs good for two minutes. A customer with
documents can't be deleted (FK `on delete restrict`) — remove the documents
or untick Active.

**Farm Licenses & CIDs** live in the Supabase table `ref_codes` (kind
`pid`/`cid`, code, name, notes, active), managed on the Information Hub's
Farm Licenses and Customer IDs tabs. Farm licenses replaced Property IDs (PIDs): they're
still stored as kind `pid`, and the form field is still `pid`, so records
from before the switch keep reading — only the labels changed. The code is
the license number and the name is the farm; dropdowns show "Farm: license".
`loadReference()` in `ops_common.js` swaps them in for the `properties` and
`customers` dropdown lists; `reference.json`'s `properties` is only the
fallback. Values typed via "Other" on a form are not added automatically —
the tab lists them so someone with edit access can add them with one click.

**Drying Schedule** (`drying_schedule.html`, hub card `drying_schedule` under
Processing) plans the outside client farms we dry for. Each row in the
`drying_intakes` Supabase table is one client's season: farm name, license #,
contact, farm size (sq ft / acres / plants), strains, status (tentative →
confirmed → receiving → complete, or cancelled), plus three lists:
- `harvests` — harvest windows as start date + days ("Oct 7 for 3 days"),
  each with optional wet lbs. `est_wet_lb` is the client's total; windows
  without their own lbs share whatever's left of it in proportion to days.
  The page keeps `est_start`/`est_end` set to the first and last harvest day.
- `services` — keys from the 2026 Post-Harvest Services pricing sheet
  (`SERVICES` in the page, with rates shown next to each checkbox). Add new
  keys freely but don't rename existing ones.
- `farm_support` — only when Farm labor is ticked: start date + days + how
  many people.

A returning farm gets a new row; picking its name copies its license, size,
contact and services from its last one. The Timeline view draws each harvest
window as a bar (tentative ones dashed) and farm support as a thin green bar
under it, with an "Est. wet lb / week" row and a "Farm crew (peak / day)" row
underneath; the Table view is sortable and there's a service filter.
Estimates only — actual weights still come in through Harvest Intake — Wet.
English only (office-facing). The service list itself lives in
`drying_services.js`, shared with the client form below.

**Client request form** (`drying_request.html`) is the public, no-PIN page
clients fill out to ask to get on the schedule — "Copy client form link" on
the Drying Schedule copies its URL. It asks for the same things as the
editor (farm, license, contact, size, harvest dates, services, farm-support
dates/crew) and posts to `netlify/functions/drying-request.js`, which
re-checks every field, keeps only known service keys, and inserts a row with
status `requested` and `created_by` "Client form" using the service-role key
(the page itself never touches Supabase). A hidden honeypot field and a cap of
30 form submissions an hour keep junk out. Requested rows don't count toward
totals or the weekly load; a banner on the schedule shows how many are
waiting, and setting one to Tentative or Confirmed puts it on the schedule.
If you add a service, add its key to `ALLOWED_SERVICES` in the function too.

The form also requires the legal business name, state incorporated, the
Service Agreement signer (first/last name, email) — columns on
`drying_intakes`, editable in the schedule editor — and two attachments: the
cultivation license and a W-9. Those go to the private `customer-docs` bucket
under `requests/` (the function hands out a one-time signed upload URL, the
page uploads straight to Storage, and the submit checks both files are there)
and are recorded in `drying_request_docs`, which has no anon policy. The
schedule editor lists them for users with `customer documents` access, via
`customer-docs.js` (`request_docs` / `request_doc_url`). Uploads are capped at
100 an hour; files from a form that's never submitted stay in `requests/`.

Each stage pulls its input weight forward from the stage before it: type the
last 4 of the Metrc tag and bucking fills in the dry weight the post-dry check
recorded. Every stage totals its own outputs and shows the variance against
what went in, live, while the operator is still standing at the scale.

## Bucking — a different shape from every other station

Every other station is one record per work order: fill out a form, submit
it, done. Bucking isn't, because the real floor doesn't work that way —
several strains get bucked at once by a rotating crew, a batch can span
several days, and the crew needs to log a scale reading the instant it
happens, not fill out a form at the end of a shift. So Bucking gets its own
page, `buck_station.html` (linked via `customHref` on the `buck` entry in
`operations_stations.js` instead of `ops_form.html`), with four tabs:

- **Today** — a quick-entry bar (batch, employee #, box #, weight) team
  leads use all day, plus a live roster grid — employees × strains, exactly
  the paper "Miercoles" tally sheet — built automatically from every
  submission, not filled in by hand.
- **Batches** — pick a batch (the on-stem UID a Take Down already produced;
  Bucking never creates one, just watches for `dry_check` "pass" records
  with no closing record yet) to see every submission against it, log
  starting weight / waste / stems / big leaf / A+ / A / B trim **per box**,
  and close it out when done.
- **Employee** — one person's production over a date range.
- **Historical** — everything, filterable by date / strain / UID.

**No new schema, no new Supabase project changes.** This reuses the same
`operations_forms` table as everything else (see `buck_data.js`), just with
station keys of its own instead of the one-record-per-form shape:

- `buck_submission` — insert-only. One row per scale trip: employee, batch,
  box, weight, timestamp. This is the log the roster and history read.
- `buck_box` — one row per (batch, box #), **patched, not replaced**, as
  different fields get filled in at different times by different people.
  Every save is read-merge-write client-side, so submitting just the waste
  weight later never blanks out the starting weight someone already logged.
- `buck_batch_close` — insert-only marker that a batch is done.

Closing a batch also writes a normal `station_key: 'buck'` record — the
rolled-up totals from every submission and box against it, in the exact
same field shape the OLD single-form Bucking used (`startingDryLb`,
`buckedFlowerLb`, `bigLeafLb`, `stemLb`, `wasteLb`, plus new `aPlusTrimLb` /
`aTrimLb` / `bTrimLb`). That's deliberate: Machine Trim's prefill, the
yield/variance calc, and the dashboard all keep reading `buck` exactly like
before — they have no idea the data came from many small submissions
instead of one big form. **Bucking does not mint a new UID when it
finishes** — the summary record stays tagged under the same UID Post-Dry
Check produced, and that's what an operator types in at Machine Trim.

**Works offline too.** Quick-entry, box saves, and closing a batch all queue
locally (`localStorage`, key `2cw_buck_queue`) on any write failure and
retry when the connection comes back — same idea as the rest of the app's
offline queue, just pointed at Supabase directly instead of the Netlify
function the old single-form queue uses. The tricky part was keeping the
box merge-safety guarantee across a dropped connection: a queued box save
doesn't store a pre-merged row, it stores "retry this exact call" — so
whenever it actually runs (now or after reconnecting), it re-reads
whatever's really on the server at that moment and merges into *that*,
never stale or guessed data. A submission made offline shows up on the
Today roster immediately too (merged in locally from the queue until its
real row lands), so an operator isn't left wondering whether it took.

## Things the forms do that the paper doesn't

- **Totals itself.** The hand-trim work order adds up every trimmer's grams,
  converts to pounds, and shows the variance against the starting bucked weight
  before anyone signs it.
- **Autosaves, and survives a device switch.** Every open form gets a stable
  id the moment someone starts it (it's in the URL — `?draft=<id>`) and saves
  itself roughly every 1.5 seconds. Open that same id from a different tablet
  and the current values are there — a tablet dying mid-shift, or the form
  getting handed to someone else, doesn't lose anything typed so far.
- **Switch strains without losing either one.** An operator running three
  strains through bucking at once sees "Continue —" chips for each open draft,
  both on the station hub and inside the form itself, and can jump between
  them freely. Each is its own row, autosaving independently.
- **A live board for supervisors.** `operations_today.html` shows every form
  in progress or finished today, updating within a second or two of an
  autosave landing on another tablet. Gated by its own *view* permission,
  separate from who can actually create or edit forms — a plant manager can
  watch bucking all day without being able to touch it.
- **Bilingual.** EN/ES toggle in the header, translation stored next to each
  field so a label and its translation cannot drift apart.
- **Works offline.** Autosave keeps a local copy on the tablet the moment
  Supabase is unreachable and retries in the background; Submit does the same
  — a form finished with no signal queues and finalizes itself the moment the
  tablet reconnects, no re-entry needed.
- **Flags what's off.** A weight that doesn't reconcile, an intake more than 2%
  off the farm's number, or a request nobody has actioned lands on the
  Exceptions tab instead of being discovered a month later in a spreadsheet.
- **Keeps one lot identity.** Bucking issues a new Metrc tag; the app follows
  the link so the lot stays one row from farm to finished flower.

## Cultivation stations — placeholder, not real yet

`cult_batch_log`, `cult_ipm_feed`, and `cult_preharvest` exist so the
Cultivation department shows up in the app and the app's shape (date, batch
tag, crew) is ready — not because their fields match your real process. Real
cultivation has more going on before harvest than three generic stubs: clone
or seed intake, a feed schedule, IPM applications, defoliation, field or stage
transitions, whatever else your SOPs actually call for. Once you have that
list, replace or add to these three — nothing downstream (the yield pipeline,
the biomass ledger) depends on their keys or fields, so they're free to
change shape without breaking anything past Harvest.

## Employee / crew tracking — the "who worked what batch" database

Every station that has a crew now carries an optional **Crew — Hours by
Employee** grid (same repeating-row control as the hand-trim weighing
worksheet): one row per person, their employee number, and their hours on
*this* batch. It sits alongside the existing crew-size/labor-hours totals —
skip it and the totals still cover the station-level number; fill it in and
you get a real link between a numeric employee ID and a specific batch/UID.

That link is what `ops_analytics.js`'s `crewLaborLog` / `crewLaborByEmployee`
read, and what the dashboard's Labor tab now shows first: every employee
number, their logged hours, how many distinct batches they touched, and
which stations. It's also on the hand-trim worksheet already (employee # per
bag), just without hours — those rows show up as a batch "touch" with no
hours until the worksheet captures time too.

**This is the seam for payroll, not payroll itself.** Nothing in this app
knows anyone's hourly rate. What it knows is *employee number × date ×
batch × hours*. Once you've confirmed which timeclock/payroll system you're
on, connecting it is a matching exercise, not a redesign: pull that system's
hours-worked-by-employee-by-date, join it to this table on employee number +
date, and you can allocate real labor cost down to a batch. I didn't build a
speculative importer for a system you haven't picked yet — tell me which one
once you know, and the join is a small, concrete piece of work.
(Connecteam it is: the Labor Log below keys its entries on the Connecteam
user id, which is the join key to Connecteam's time activities.)

## Workforce: Master Schedule and the Labor Log

Both cards sit in the hub's **Operations → Workforce** folder (`subdept:
'workforce'` in `hub_config.js`; `buildTree` in `index.html` adds the
folder, which only shows when someone has at least one of its cards).
Access is the admin panel's "Master Schedule" and "Labor Log" card
checkboxes. Master Schedule kept the old Scheduling card's key
(`scheduling`), so everyone who had Scheduling has it.

**Master Schedule** (`master_schedule.html`, card `scheduling`) replaces
Scheduling. It holds the bigger jobs ("Smalls Trimming" at Adobe, "Fresh
Frozen Harvest" at Comstock) and builds the daily/weekly work schedule
from them.
- **Projects tab.** Each project has a name, location (`WORK_LOCATIONS`
  in `operations_stations.js`, shared with Scheduling), a **Project
  lead** (a dropdown of the Connecteam roster, just under Location), an
  optional process (fills in the Labor Log's process), start date,
  optional end date, the days of the week it runs (none = every day),
  start/end times, status (Active / Planned / Done) and notes.
  - Cards list the days only when some were picked, or when none were
    and there's no end date ("every day"); a dated project with no days
    picked shows just its dates ("Oct 6", "Oct 6 – Oct 9").
  - With overnight hours (end before start) the end date is the morning
    the last shift ends: Oct 6 – Oct 7, 10 PM–6 AM is one night, starting
    the 6th (`projectRunsOn`). An end date equal to the start is also one
    night. The Labor Log's right-click also offers the previous day's
    overnight projects for time after midnight.
- **Responsibilities** are the standing jobs on a project, like
  Trimmers, Weigh station or Driver. They're a table with columns Name,
  Process, Start and End, and each row's people listed under it (from
  the Connecteam roster, or typed in).
  - Start and End are only filled in when they differ from the
    project's hours. Either one can differ on its own (`projectHours`
    takes each one separately). On save, a time equal to the project's is
    stored blank.
  - They aren't one-time tasks: they apply every day the project runs.
  - The people picker shows which other projects someone is already on.
  - The lead counts as working the project: `projectRoles` lists the
    lead first, as a role with id `_lead`, for the schedule, conflicts,
    the image, and the Labor Log's right-click.
- **UIDs** are added as the work reaches the packages. You can scan or
  type the full tag, or type the last 4, matched against the last 60 days
  of station records and then active Canix packages. Several can be pasted
  at once. Each card shows the hours logged to the project (Labor Log
  entries with `project`) with links to **Log time** (opens
  `labor_log.html?project=<id>`) and **Labor entries**.
- **Farm labor contractors** sit under Responsibilities: crews counted
  by headcount, not named people. Each contractor (name, with the names
  already used on other projects offered) has one or more times — a
  number of workers with a start and end — so part of a crew can start
  or finish at a different time. Blank times use the project's hours
  (stored blank when equal, like a responsibility's). They show on the
  day cards, the week table, both images and the CSV, but aren't in
  `projectRoles`, so no conflicts and nothing in the Labor Log.
- **Cards / Timeline** switches the Projects tab between the cards and a
  project timeline: six weeks (‹ › move two weeks, Today goes back), a
  row per project grouped by location, with solid blocks on the days it
  works and a thin line across days off or marked not working. Green is
  Active, blue Planned, gray Done. Each row shows the dates, hours and
  headcount. The status filter and search apply, and tapping a row opens
  the editor above the timeline. The choice is remembered per device.
  - **1 day / 3 days / 7 days / 6 weeks** sets the span (remembered per
    device). The shorter spans use an hour axis across the days (2-hour
    ticks for 1 day, 6-hour for 3, noon for 7; midnight in bold) with a bar for each
    shift at the project's hours. Overnight shifts cross midnight, and
    the previous night's shift carries into the first morning. All-day
    projects fill the day, and days marked not working are left out.
    ‹ › move by the span.
  - **Save image** draws the timeline as shown (span, dates, status
    filter and search) as a PNG on white for texting, with the same
    share / download sheet as the schedule images. The page and the image
    are built from one model (`ptModel`), so they always match.
- **Duplicate** (on each project card and in the editor) opens a new,
  unsaved project copying the location, lead, process, days, hours,
  notes, responsibilities with their people, and contractors. It starts
  today with no end date, no UIDs and no day changes; the name gets
  "(copy)" and a Done status becomes Active. Nothing is written until Save.
- **Schedule tab — Day** shows every project running that day
  (`projectRunsOn`: Planned or Active, inside its dates, on one of its
  days), at its location and hours (`projectHours`), with each
  responsibility and its people. Someone on two projects whose hours
  overlap is flagged on both, and the summary counts them.
  - **Change this day** is for one day only: untick someone who's off,
    add someone just for that day, add a note, or mark the project as not
    working that day. It never changes the standing responsibilities.
  - It also sets each contractor crew's worker count for that day
    (0 = not coming). Only counts that differ from the usual are saved;
    the day card shows "usually N" next to a changed count.
- **Week** is a table with projects down the side and Mon–Sun across.
  Tap a day to open it. **Save image** draws the day or the week as a
  PNG for texting, the same way Scheduling did.
- **Timeline** is one day grouped by location: a row per person, with a
  bar for each project/responsibility they're on there (colored by
  project, double-bookings outlined in red), and a row per contractor
  crew (striped). The hour axis fits the day's earliest start and latest
  end. **Save image** draws it as a PNG.
- **Export CSV** (any view) writes the shown day or week: one line per
  person per responsibility and per contractor crew — date, location,
  project, type (Lead / Employee / Contractor), responsibility, name,
  workers, 24-hour start/end, hours, total hours (workers × hours),
  double-booked, day note.
- Each project is one `operations_forms` row, `station_key:
  'work_project'`, `work_date` = start date, `fields = { name, location,
  locationName, process, status, start, end, days: [0–6, Sun = 0],
  startTime, endTime, lead: {userId, name}, roles: [{id, name, process,
  startTime, endTime, people: [{userId, name}]}], contractors: [{id, name,
  shifts: [{id, count, startTime, endTime}]}], uids: [{uid, strain, addedAt,
  addedBy}], notes, overrides: { 'YYYY-MM-DD': { skip, note, out:
  [personKey], extra: [{roleId, userId, name}], flc: {shiftId: count} } }, createdBy, updatedBy
  }`. There's no SQL.
- Every save re-reads the row and writes only if `updated_at` hasn't
  changed since, retrying on top of the newer version. That way two leads
  editing different days don't undo each other. Remove sets
  `fields.voided`.

The old **Scheduling** page (`schedule.html`, `work_schedule` rows) is no
longer on the hub. It's still linked at the bottom of Master Schedule so
past day schedules can be looked up. What it did:

**Scheduling** (`schedule.html`) replaced the shared
daily sheet (a column per location, names under it, tasks in red):
- Each day starts empty. **+ Add schedule** creates one for a location
  (Adobe, Airway, Wildcat, Comstock, Lucerne, Sulphur Bank, Highland, or
  Other with a name). **Copy from <previous day>** brings yesterday's
  schedules over to edit.
- **Everyone starts at the same time** (on by default) takes one start and
  an optional end. Unticked, each person gets their own start/end.
- **People** come from the Connecteam roster (`data/connecteam_roster.json`)
  or can be typed in. Any of them can be marked **Lead**.
- **Notes / tasks** hold things like "riego" or "colgar 5 am".
- **Conflicts**: a person on two schedules whose times overlap that day is
  flagged in red on both ("also at Comstock 7:00 AM–3:30 PM"). The people
  list shows where someone is already scheduled before they're added, and
  saving with a conflict asks for confirmation.
  - A schedule with no end is treated as `DEFAULT_SHIFT_H` (8) hours, and
    an end earlier than the start runs past midnight (bomba 7 pm–7 am).
  - Conflicts are only checked within the same date.
- **Day / 3 days / Week** switch (remembered per device):
  - **Day** is the editable view.
  - **3 days** (the date and the next two) and **Week** (Monday–Sunday)
    are a read-only table with locations down the side and days across,
    like the old sheet, with conflicts marked ⚠. Tap a day's header to
    open it in Day view and edit. The arrows step by the view's length.
- **Save image** draws the current view as a PNG on a white background,
  for texting:
  - Layout: a title with the dates, then each day as a section of location
    blocks (orange header with the location and time, notes in red, leads
    first in green).
  - It's drawn straight onto a canvas, with no screenshot library.
  - The preview offers **Share / text**, the phone's share sheet
    (`navigator.share` with the file, when the browser supports sharing
    files), and **Download**. On a phone you can also long-press the
    preview to save it to Photos.
- Each schedule is one `operations_forms` row, `station_key:
  'work_schedule'`, on that `work_date`, with `fields = { location,
  locationName, sameStart, start, end, people: [{userId, name, lead, start?,
  end?}], notes, createdBy, updatedBy }`. There's no SQL, as with the Labor
  Log. Remove sets `fields.voided` (anon can't DELETE), and the edit history
  trigger records edits and removals.

## Labor Log — hours against UIDs

`labor_log.html` (hub card `labor_log`, admin checkbox "Labor Log", column
`labor log`) is where a lead puts people's time against the UIDs they worked
on, without filling out a station form. **Log time:** pick a process (every
station except Biomass Request, plus Transportation and "Other / general",
the non-station processes in `LABOR_PROCESSES` in `operations_stations.js`;
those two split multi-UID time by each lot's wet lb), a date, start/end
or just hours, one or more people, and zero or more UIDs, then Save.

- **People** come from Connecteam. `scripts/connecteam_sync.py` (the hourly
  Staff Hours sync) also writes `data/connecteam_roster.json`, every active,
  non-archived user (Connecteam user id + name). Anyone clocked in shows
  first with a green dot, and "Add everyone clocked in" adds the whole crew
  at once. Someone not in Connecteam can be typed in and saved with no id.
  Until the roster file has been written once, the page uses the names from
  `connecteam_hours.json` instead.
- **UIDs** can be picked from a list or found by typing the last 4. The list
  is built from the last 60 days of `operations_forms`. UIDs whose latest
  record is at the stage feeding the chosen process come first ("At this
  stage"). For example, Wet Intake UIDs come first for Take Down, and Take
  Down's new on-stem UIDs come first for Bucking. `FEEDS` in the page sets
  this. If the records don't have a UID, the search also checks active Canix
  packages (`data/canix_inventory.json`, only fetched once someone types 4+
  characters). A full tag that's in neither can still be added as typed.
- **Several UIDs on one entry** is for intake, take-down and any other work
  that's too fast-moving to track per package. The hours are split **by the
  pounds each UID had at that process** (`laborAllocations` /
  `lotLbForProcess` in `ops_analytics.js`). That's the stage's own input
  weight (Take Down's wet intake lb, Bucking's starting dry lb, Trim's
  bucked lb), or for Harvest and Wet Intake what they weighed in, or else
  what the stage before put out. So bucking labor logged before the batch
  closes still splits by dry weight. For example, 16 hours of intake over a
  500 lb and a 1,500 lb package is 4 h and 12 h. If any UID on the entry has
  no weight anywhere yet, that entry splits evenly and is marked ≈. It
  re-splits by weight on its own once the weights are recorded, because
  nothing is frozen at save time. The form previews the split before
  saving.
- **A farm (general work)**: "Applies to" switches the entry from UIDs to
  a farm, for work at a farm that isn't tied to particular packages. The
  entry stores `farms`, the Farm License codes it covers (the same codes
  Harvest and Wet Intake record as `pid`, so lots carry one as
  `lot.pid`), plus `farm` (the first, for older readers) and `farmName`,
  with no UIDs.
  - One farm can hold several licenses. The picker groups licenses by
    farm, using the name before ": " in each license's label
    (Information Hub → Farm Licenses). Tapping the farm takes all of its
    licenses, or you can tap single ones. Give all of a farm's licenses
    the same name there.
  - `laborAllocations` spreads the hours over every lot that came in under
    any of those licenses in the same calendar year, by wet lb (Wet
    Intake, else Harvest).
  - Entries saved before this have a single `farm` and still work
    (`entryFarms`). While the farm has no pounds that year, the hours
  sit in the farm's pool (basis `farm-pending`, shown at the bottom of By
  lot). The split is worked out when a report is opened, so it settles on
  its own once the harvest is in. A season is the calendar year, so farms
  with several rounds a year would need explicit harvest periods.
- **A project**: "Applies to" can also be a Master Schedule project.
  Picking one fills in its process and lists its UIDs. The entry stores
  `project` (the `work_project` id) and `projectName`, with no UIDs.
  - `laborAllocations` splits the hours over the UIDs the project has
    when the report is opened, by pounds at the process (the same as a
    multi-UID entry), so UIDs added to the project later pick up their
    share.
  - Unlike farm-wide time, this counts as direct labor on those lots.
  - Until the project has UIDs, the hours wait as its pool (basis
    `project-pending`, lotId `project:<id>`, shown at the bottom of By
    lot).
  - Pages that allocate labor (Labor Log, Harvest Intakes, the
    dashboard) load the `work_project` rows into `stages.work_project`.
- **Costs** use each person's own loaded $/hr (wage + taxes + benefits),
  set in the admin panel's **Labor Rates** tab (see `docs/USER_ADMIN.md`).
  Rates live in the `labor_rates` table, one row per person per effective
  date (`'*'` is the default for anyone without their own). Each entry is
  costed at the rate in effect on its date (`rateFor` in `ops_analytics.js`),
  so a raise doesn't change the cost of earlier work. Rates are pay, so
  `labor_rates` has no anon access, and nothing about pay is stored on the
  entries. Only users with **Labor Log — see costs** (`labor log costs`
  column; implies the card) see $: at login that sets `2cw_labor_costs`, and
  the page then asks `netlify/functions/labor-rates.js` for the rates with
  the user's PIN. The function re-checks the column server-side. Everyone
  else sees hours only, with the $ columns hidden.

Saving writes **one row per person** to `operations_forms` with
`station_key: 'labor_entry'`, `status: 'submitted'`, `fields = { process,
employeeId, employeeName, uids: [{uid, strain}], start, end, hours, notes,
enteredBy }`. There's no new table or SQL, just like Bucking's submissions.
After a save the process, date, times and UIDs stay filled in so the next
person can be logged right away.
Under Save, **You logged for <date>** lists the entries this login saved for
the selected date (`owner_user`), each with **Delete**, so a mistake can be
fixed where it was made. Delete, like Remove on the Entries tab, sets
`fields.voided`. **Entries** lists a date range (with
Today / Last 30 days / All dates shortcuts) three ways: each entry (with
cost, for cost access), totals **by person**, and **By lot**. By lot has one row per lot,
keyed on its root UID (`laborCostByLot`), so Take Down's on-stem tag counts
toward its farm package. It shows hours (and cost) for each process, then the
total, wet lb in (and $/wet lb), and the lot's weight at its latest stage
(and $/lb there). Only entries in the date range count, so pick All dates to see
a lot's whole cost. General work with no UID is its own row.
When the range is just today, By person also shows Connecteam's clocked
hours and how much of that time has no entry yet. "Remove" can't delete (anon
has no DELETE on `operations_forms`), so it sets `fields.voided` and stamps
who and when. The edit history trigger records the change, and voided
entries count for nothing.

**Timeline** (third tab) is a day-at-a-glance check that every clocked hour
is logged. Each person who clocked in that day, or has an entry, gets a row:
- Their Connecteam clock-ins are drawn as a gray track. They come from
  `data/connecteam_shifts.json`, which the hourly sync writes with every
  shift's start and end for the last 14 days (`SHIFT_DAYS`).
- Entries that have a start/end are drawn on the track as blue blocks.
- Clocked time with no entry covering it is hatched gold. Tapping a hatched
  stretch opens Log time with that person, the date and those times filled
  in.
  - **Right-clicking** a hatched stretch (or long-pressing it, where the
    browser supports that) opens a menu of the Master Schedule projects
    running at that time. The person's own responsibilities come first
    ("✓ Trimmers"), then other projects whose hours overlap. Picking one
    saves an entry for the whole stretch right away. It takes the person,
    the gap's start/end, the project, the responsibility (`role`,
    `roleName`), and the responsibility's process, else the project's,
    else Other / general.
  - **Something else…** opens Log time, the same as a tap.
- Entries logged while the person wasn't clocked in get a red outline.

Each person's row shows **where they clocked in**: the Connecteam job they
punched into (`job` in `connecteam_shifts.json`, names from
`/jobs/v1/jobs`), or else the time clock's name (`clock`). Each shift's
tooltip says the same, and the search matches places as well as names.
The clock-in GPS address Connecteam also sends is deliberately left out of
the file, because the repo's data files are public and an address can be
someone's home.

Totals per row and for the team: clocked, logged, not logged
(clocked − logged), and % allocated. There's also an "only people with time
not logged" filter. Entries saved with hours only count toward Logged but
can't be placed on the line. Times are shown in the viewer's local time.
The hourly sync means the most recent hour can be missing, and someone still
on the clock is drawn up to now. An unpaid break shows as not-logged time
unless people clock out for it.

**Labor on a package.** Each intake's detail on Harvest Intakes has a
"Labor on this package" section. It shows hours by process, people, cost
(with "see costs"), and labor per wet lb, for that intake's lot: the
lot's own UIDs, farm-wide time spread over it, and later stages via Take
Down's on-stem UID. The numbers are the same as By lot. The section's **Open
in Labor Log** link opens `labor_log.html?tab=list&seg=lot&all=1&q=<UID>`.
By lot applies its search to the lots after allocation, so farm-wide time
still shows on a searched-for lot.

**Direct vs. farm-wide.** A lot's Hours, Cost and $/lb (in By lot and on
the intake's Labor section) count **direct labor only**: time logged on
its own UIDs. Its share of farm-wide work is shown on its own as
**Farm-wide (est.)**, with its own "+ farm $/wet lb (est.)". That share is
re-divided every time another lot from the farm comes in, so it's an
estimate until all of the farm's harvests are done. `laborCostByLot`
returns `hours/cost/costPerWetLb/costPerCurrentLb` for direct labor and
`farmHours/farmCost/farmCostPerWetLb` for the share.

**Cost carried forward (Labor Log → Entries → Cost / lb, cost access
only).** Each lot's labor cost per lb at every stage, over all dates. The
math is `carryCost` in `ops_analytics.js`:
- **Wet**: everything up to intake (harvest, intake, farm-wide, other) ÷
  wet lb.
- **Dry**: + Take Down labor ÷ dry lb. Water lost carries no cost.
- **Bucked**: + Bucking labor ÷ bucked flower lb. Big leaf, stems and waste
  carry none.
- **Trim**:
  1. The bucked cost of the pounds that went into trim runs, plus
     machine and hand trim labor, is divided between **A flower /
     Smalls / Trim** by the **trim cost split** %. Shake, sugar trim and
     A+/A/B trim count as Trim, and waste carries none.
  2. Each category's share ÷ its own lb is its $/lb.
  3. A category the lot didn't produce is dropped and the rest are
     re-scaled. Bucked flower not trimmed yet keeps its share ("Not
     trimmed yet").
- The split is one shared setting, edited at the top of Cost / lb (must
  total 100, default 70/20/10). It's stored in an `operations_forms` row
  (`station_key: 'cost_settings'`, fixed id
  `636f7374-7370-4000-8000-000000000001`, `fields.trimSplit`), read and
  saved by `getTrimSplit` / `saveTrimSplit` in `ops_data.js`. It's a
  ratio, not pay, so it's not in the private table.
- The farm-wide estimate is carried the same way and shown as gold "+"
  lines.
- The intake's Labor section shows the same carried-forward $/lb once the
  lot has reached Take Down.
- Labor only: no material, packaging or overhead.

Weights for a process with nothing recorded at or before it (Harvest labor
on a lot that only has a Wet Intake) come from the first stage after it
that has a weight, rather than falling back to an even split.

The dashboard's Labor tab loads `labor_entry` alongside the stations, and
`crewLaborLog` turns each entry into one row per UID. Entries show there by
name, keyed on the Connecteam user id. The Today board ignores them because
it only shows station keys.

## Setting up Supabase (do this before going live)

Drafts, autosave, cross-device resume, and the live Today board all need a
real database — a git commit per keystroke doesn't work, and a supervisor's
live view needs to query across everyone's tablets at once. I can't create
the project myself (it needs your account), but everything is built and
tested against it — this is genuinely a five-minute setup, not a development
task:

1. **Create a project** at [supabase.com](https://supabase.com) (free tier is
   plenty for this — a few hundred rows a day).
2. **Run the schema.** Project → SQL Editor → New query → paste in the
   contents of `supabase/schema.sql` → Run. Creates one table
   (`operations_forms`) with the indexes and realtime subscription the app
   needs. Safe to re-run.
3. **Copy two values** from Project Settings → API: the **Project URL** and
   the **anon / public key** (not the `service_role` key — that one must
   never go in a browser file). Paste them into `config/supabase_config.js`:
   ```js
   const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
   const SUPABASE_ANON_KEY = 'eyJhbGci...';
   ```
4. **Commit and deploy.** That's it — `ops_form.html`, `operations.html`,
   `operations_today.html`, and `operations_dashboard.html` all detect the
   config automatically and switch from single-shot/static-file mode into
   live drafts + Supabase-backed history.

**Read the RLS note at the top of `supabase/schema.sql` before you consider
this "secured."** This app has no real login yet — PINs live in a Google
Sheet published to the web (see the SSO section below) — so the anon key's
access policy is deliberately as open as the rest of the app already is, not
a locked door. Real per-user row security is one of the things proper SSO
would unlock.

**Until you do this**, the app still works exactly as it did before: forms
submit in one shot (no autosave, no resume, no live board — those pages show
a short "not connected yet" message instead), and the dashboard reads the
static `data/operations/*.json` files. Nothing breaks on a fresh checkout.

## Before going live

1. **Fill in `data/operations/reference.json`.** Seeded from your workbook, so
   the codes are real but the labels are placeholders:
   - `sites` — `AF`, `BG`, `HSR`, `AHD`, `WC` came out of the batch names.
     Rename `label` to the actual farm names.
   - `properties` — PIDs `071`, `073`, `075`, `309`, `310`, `540`.
   - `dryRooms` — the drying rooms (Room 1A … Room 4B; room 2 is split into 2A–2D,
     unlike the Drying Room Capacity table in `canix_inventory.html`). The old
     placeholder "Dry Area 1/2" entries are kept `active: false` so past
     records still show a label.
   - `trimMachines`, `freezers` — guesses. Replace with your Mobius units and
     your freezers.
   - `employees` — empty. Not required (the forms take an employee number
     directly), but filling it lets the dashboard show names instead of numbers.
   - `strains` — 39 canonical names, with the workbook's spelling variants kept
     as `aliases`. See the note below.

2. **Add the access columns to the directory sheet.** Two independent lists,
   both comma-separated station keys (`buck,machine_trim,hand_trim`), `all`,
   or blank:
   - `production edit stations` — can create, autosave, and submit forms for
     these stations. Drives the station hub and the dashboard. (The old
     column name `production stations` still works, read as edit access, if
     a sheet was already set up under that name.)
   - `production view stations` — can watch these stations live on
     `operations_today.html` and see them on the dashboard, without being
     able to touch them. A plant manager watching a department they don't
     personally run belongs here. Edit access already implies view access,
     so you only need this column for someone who should see a station but
     not submit to it.

   There's no separate on/off switch for the hub or the dashboard cards
   anymore — having anything in either list is what makes them appear, the
   same way `field_forms` already works off the per-form columns.

3. **Set up Supabase** — see above.

4. **Clear the demo data** if you seeded any (only matters for the static
   fallback):
   `node scripts/seed_demo_operations.js --clear`

5. `GITHUB_TOKEN` is already set in Netlify for the field forms; the
   photo-upload function uses the same one. Nothing new to configure there.

## Three things worth knowing about the current paperwork

- **The trimming work order has a maths error printed on it.** It says
  *"Total Finished Flower in Pounds (total trimmed grams × 454)"*. It should be
  **÷ 453.592**. Multiplying by 454 overstates the pounds by roughly 206,000×,
  so presumably everyone on the floor ignores the instruction and divides — but
  it's on Version 4 of a printed form and worth correcting at the source. The
  app divides.
- **Strain names are drifting.** The workbook has `Blue Nerds` / `Blue Nerdz`,
  `Itz Pluto` / `It'z Pluto` / `It'z Pluto - AF`, and `Super Bluff Cherry` /
  `Super Buff Cherry` — the same strain reported as two or three different ones,
  which quietly splits every yield number you'd want to compare. The app uses a
  picker off `reference.json` so this stops; the old spellings are recorded as
  `aliases` for mapping historical rows.
- **The workbook's stage sheets link by row position, not by tag.**
  `02_Buck_Deleaf!B5` is `='01_Intake_Wet'!B5` — so inserting or sorting a row
  in the intake sheet silently re-points every downstream row at a different
  lot. Rows 8–11 of the buck sheet already point at intake rows 8, 9, 8, 9. The
  app matches on the UID instead.

## Adding a field or a station

Everything is driven by `operations_stations.js`. Adding a field to bucking is
one line in that station's `fields` array — the form, the dashboard, and the
stored record all pick it up. Field types: `text`, `number`, `date`, `select`
(with `ref` for a reference list, `opts` for inline options, `allowOther`),
`textarea`, `uid`, `photo`, `calc` (a function of the other values), and
`lineitems` (the repeating grid the weighing worksheet and Fresh Plant
Intake's bin weigh-in and Take Down's box table use — a `lineitems` column can itself be
`number`/`text`/`uid` or `select` with inline `opts` or a `ref` list (plus
`allowOther`) and a `def` default; `carry: true` copies a column down from the
row above on "+ Add row", and `req: true` makes it required on any filled-in
row). `headline`
names the one field worth showing on a card or the live board without
opening the form — the running total in the form's sticky footer follows it
too.

**A record that represents more than one batch** (none today — Wet Intake
takes several UIDs per form but splits into one record per UID on submit) declares `flow.perLine: { arrayField, uidCol, strainCol,
weightCol, category }` alongside its normal `flow.outputs`. `outputs` still
feeds the dashboard's stage-total and biomass numbers off one flat top-level
field on the record (`totalWetLb`, a `calc` summing the lines); `perLine` is
what `findUpstream` (live-form prefill) and `buildLots` (the Pipeline tab)
read to walk into the individual lines instead, so a UID typed into a
downstream form — or a lot on the dashboard — resolves to its own line's
weight and strain, not the whole truck's total.

To make a new station appear, add an entry to `OPERATIONS_STATIONS` and add its key
to `KNOWN_STATIONS` in both `netlify/functions/submit-operations.js` and
`netlify/functions/upload-operations-photo.js`. Create an empty
`data/operations/<key>.json` containing `[]` for the static fallback.

Run `node scripts/test_ops_analytics.js` after touching `ops_analytics.js` or
any station's `flow` block.

## Not built yet

Deliberately out of this pass, roughly in the order I'd add them:

- **Discarding a draft.** `ops_data.js` has `deleteDraft()` but nothing in
  the UI calls it yet — an abandoned draft (wrong strain, started by mistake)
  just sits there until someone submits or ignores it. A "discard" button on
  the strain switcher is a small addition.
- **Photos don't follow a draft across devices yet.** They upload at final
  Submit, same as before; a photo taken mid-day on tablet A isn't visible if
  the draft is resumed on tablet B before submitting. Fixing this means
  Supabase Storage instead of (or alongside) the GitHub upload — worth doing
  together if photos-mid-draft turns out to matter in practice.
- **Metrc API integration.** Right now tags are typed in. Metrc's API could pull
  package weights and strains directly and push package adjustments back, which
  would remove most of the typing and all of the transcription risk.
- **Barcode / tag scanning.** The UID fields accept the last 4 by hand; a camera
  scan on the tablet would be faster and eliminate mis-keys.
- **Editing other submitted forms.** Only Wet Intake can be corrected after
  Submit (see Harvest Intakes above). Another station opts in with one entry
  in `EDITABLE_SUBMITTED` in `ops_form.html` plus its own access flag.
- **Payroll/timeclock cost join.** The data model is ready (see Employee /
  Crew tracking above) but nothing pulls in a $/hour to turn hours into cost
  — waiting on which system you're actually on.
- **Bulk biomass sales.** Sales to outside distributors and manufacturers aren't
  modelled yet, so biomass that leaves that way will sit on the ledger as
  on-hand.
- **Storage locations.** The ledger tracks *processing* vs *manufacturing*, not
  which room or rack. Fine for reconciliation, not enough for a physical count.

## SSO — short answer: yes, and multiple domains is not the problem

Multiple domains is the easy part. Three ways, cheapest first:

1. **Cloudflare Access in front of the site.** Sits ahead of Netlify, no app
   changes. You allow-list identity providers (Google, Microsoft, one-time
   email codes) and list every domain you operate under, plus individual
   contractors. This is the lowest-effort route by a wide margin and it covers
   all the domains at once.
2. **One IdP tenant with several verified domains.** Google Workspace and
   Microsoft Entra ID both let one tenant own multiple verified domains. Pick
   whichever tenant already has the most staff, add the other domains to it,
   and everyone has one identity regardless of which address they use. Best if
   you want one directory to manage long term.
3. **An identity broker** (WorkOS, Auth0, Clerk, Okta). One app with several SSO
   connections, each mapped to a domain. Worth it only if the domains are
   genuinely separate legal entities with separate IT that won't merge.

**The catch is not the domains — it's the floor.** SSO is a bad fit for shared
tablets in a processing facility. Trimmers with gloves on, wet hands, and often
no company email address are not going to type an email, a password, and an MFA
code before every work order. Recommended split:

- **Office and management** — SSO (option 1 or 2) for the dashboards.
- **The floor** — the tablet stays signed in as a *station*, not a person, and
  the employee number on the form is the identity that actually matters for
  productivity tracking. That's how the hand-trim worksheet already works on
  paper, and it's what the app does today.

One security note while we're here: the PIN directory (now `app_users` in
Supabase, managed at `/admin.html` — see `docs/USER_ADMIN.md` — with the old
published Google Sheet kept only as a fallback) is still just a 4-digit PIN
with no real identity behind it, readable by anyone who reaches the login
page. It's fine for a dashboard behind an unguessable link; it is not
something to build production authority on top of — and it's the reason the
`operations_forms` Row Level Security policy is left deliberately open
rather than pretending to restrict access it has no real identity to
restrict by (`app_users` itself is locked down further — writes require the
separate admin PIN — see `docs/USER_ADMIN.md`). Whichever SSO route you
pick, replacing the PIN directory and tightening RLS to match should go
with it.

### About the storage model

Live state (drafts, autosave, the Today board) lives in Supabase — a real
database, needed for the write-heavy, read-heavy pattern autosave and live
viewing create. The static `data/operations/*.json` files are only a
fallback for a fresh install with no Supabase project yet; once one is
configured, they stop being read. GitHub still holds the photos, same as the
field forms, since that storage never needed to be "live."
