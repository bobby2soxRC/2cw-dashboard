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
**Processing** — Bucking · Machine Trim · Hand Trim / Hand Touch
**Manufacturing** — Biomass Request · Pre-Roll Production · Manufacturing Run

Wet Intake and Take Down are the two halves of the paper "Harvest Intake &
Take Down Log", 5–10 days apart: Wet Intake is one form per truck, with the
farm package UID and strain on each bin weigh-in row (bins weighed net of
tare). On submit it's split into one record per UID (`splitBy: 'lines'` on
the station; `splitRecords` in `ops_form.html`), each holding only its own
rows and totals, so everything downstream still sees one package per
record. With more than one UID on the form the Metrc-adjustment fields hide;
they're filled in per intake afterwards from Harvest Intakes. Take Down (station key `dry_check`)
boxes the dried material under a new on-stem package UID. Take Down's
`incomingUid` pulls strain/farm license/CID/wet weight from the intake record, and
`ops_analytics` aliases the on-stem UID back to the farm UID so it stays one
lot. Bucking opens a batch for every Take Down released to bucking.

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
   - `dryRooms`, `trimMachines`, `freezers` — guesses. Replace with your real
     rooms, your Mobius units, and your freezers.
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
