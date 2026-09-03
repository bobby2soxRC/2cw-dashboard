# 2CW Production App

Replaces the hand-written station paperwork — and the retyping into
spreadsheets that follows it — with tablet forms that total themselves,
autosave as someone works through their day, and can be picked back up on a
different tablet if the first one dies or a shift changes hands. Built into
the existing Operations Hub — same login, same Netlify deploy.

## What's here

| File | What it is |
|---|---|
| `production.html` | Station picker, grouped by department, with "continue" chips for your open drafts |
| `prod_form.html` | The form for every station, rendered from the schema, with autosave + resume |
| `buck_station.html` | Bucking's own 4-tab page (Today / Batches / Employee / Historical) — see below, doesn't use `prod_form.html` |
| `buck_data.js` | Bucking's data layer — submissions, boxes, batch close-out. Reuses `production_forms`, no schema changes |
| `production_today.html` | Live board — every form in progress or finished today, for anyone with view access |
| `production_dashboard.html` | Pipeline, yields, biomass, labor, requests, exceptions (finished forms only) |
| `production_stations.js` | **The schema.** Station and field definitions, EN + ES |
| `prod_common.js` | Language, reference-data loading, the legacy offline queue |
| `prod_data.js` | Supabase-backed drafts, autosave, live "Today" queries |
| `prod_analytics.js` | Lot tracking, yields, biomass ledger, labor, exceptions |
| `supabase/schema.sql` | Run once in a new Supabase project — see setup below |
| `config/supabase_config.js` | Your project's URL + anon key go here |
| `netlify/functions/upload-production-photo.js` | Photo storage (stays in GitHub, alongside the field-form photos) |
| `netlify/functions/submit-production.js` | The old single-shot submit path — kept as the fallback when Supabase isn't configured |
| `data/production/reference.json` | Farms, strains, dry rooms, machines, brands |
| `data/production/<station>.json` | Fallback data source when Supabase isn't configured; otherwise unused |
| `scripts/test_prod_analytics.js` | `node scripts/test_prod_analytics.js` |
| `scripts/seed_demo_production.js` | Demo data for the static-fallback dashboard; `--clear` to empty |

## Stations

**Cultivation** *(placeholder — see below)* — Plant Batch Log · IPM / Feed Log · Pre-Harvest Inspection
**Harvest** — Harvest · Fresh Frozen
**Drying** — Fresh Plant Intake · Post-Dry Check
**Processing** — Bucking · Machine Trim · Hand Trim / Hand Touch
**Manufacturing** — Biomass Request · Manufacturing Run

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
`production_stations.js` instead of `prod_form.html`), with four tabs:

- **Today** — a quick-entry bar (batch, employee #, box #, weight) team
  leads use all day, plus a live roster grid — employees × strains, exactly
  the paper "Miercoles" tally sheet — built automatically from every
  submission, not filled in by hand.
- **Batches** — pick a batch (a dried UID Post-Dry Check already produced;
  Bucking never creates one, just watches for `dry_check` "pass" records
  with no closing record yet) to see every submission against it, log
  starting weight / waste / stems / big leaf / A+ / A / B trim **per box**,
  and close it out when done.
- **Employee** — one person's production over a date range.
- **Historical** — everything, filterable by date / strain / UID.

**No new schema, no new Supabase project changes.** This reuses the same
`production_forms` table as everything else (see `buck_data.js`), just with
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

**Known gap:** quick-entry only works while online right now. Every other
station's autosave survives a dead connection by queuing locally; Bucking's
event log doesn't have that yet — a real thing to build if the floor's wifi
turns out to be unreliable at the buck tables specifically.

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
- **A live board for supervisors.** `production_today.html` shows every form
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

That link is what `prod_analytics.js`'s `crewLaborLog` / `crewLaborByEmployee`
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
   (`production_forms`) with the indexes and realtime subscription the app
   needs. Safe to re-run.
3. **Copy two values** from Project Settings → API: the **Project URL** and
   the **anon / public key** (not the `service_role` key — that one must
   never go in a browser file). Paste them into `config/supabase_config.js`:
   ```js
   const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
   const SUPABASE_ANON_KEY = 'eyJhbGci...';
   ```
4. **Commit and deploy.** That's it — `prod_form.html`, `production.html`,
   `production_today.html`, and `production_dashboard.html` all detect the
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
static `data/production/*.json` files. Nothing breaks on a fresh checkout.

## Before going live

1. **Fill in `data/production/reference.json`.** Seeded from your workbook, so
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
     `production_today.html` and see them on the dashboard, without being
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
   `node scripts/seed_demo_production.js --clear`

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

Everything is driven by `production_stations.js`. Adding a field to bucking is
one line in that station's `fields` array — the form, the dashboard, and the
stored record all pick it up. Field types: `text`, `number`, `date`, `select`
(with `ref` for a reference list, `opts` for inline options, `allowOther`),
`textarea`, `uid`, `photo`, `calc` (a function of the other values), and
`lineitems` (the repeating grid the weighing worksheet and Fresh Plant
Intake's container table both use — a `lineitems` column can itself be
`number`/`text` or `select` with inline `opts` and a `def` default). `headline`
names the one field worth showing on a card or the live board without
opening the form — the running total in the form's sticky footer follows it
too.

**A record that represents more than one batch** (Fresh Plant Intake: one
truck, several UIDs) declares `flow.perLine: { arrayField, uidCol, strainCol,
weightCol, category }` alongside its normal `flow.outputs`. `outputs` still
feeds the dashboard's stage-total and biomass numbers off one flat top-level
field on the record (`totalWetLb`, a `calc` summing the lines); `perLine` is
what `findUpstream` (live-form prefill) and `buildLots` (the Pipeline tab)
read to walk into the individual lines instead, so a UID typed into a
downstream form — or a lot on the dashboard — resolves to its own line's
weight and strain, not the whole truck's total.

To make a new station appear, add an entry to `PROD_STATIONS` and add its key
to `KNOWN_STATIONS` in both `netlify/functions/submit-production.js` and
`netlify/functions/upload-production-photo.js`. Create an empty
`data/production/<key>.json` containing `[]` for the static fallback.

Run `node scripts/test_prod_analytics.js` after touching `prod_analytics.js` or
any station's `flow` block.

## Not built yet

Deliberately out of this pass, roughly in the order I'd add them:

- **Discarding a draft.** `prod_data.js` has `deleteDraft()` but nothing in
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
- **Editing a submitted (finalized) form.** Drafts are fully editable up to
  Submit; after that, a correction still needs a new record rather than a fix
  in place, the same as before. Straightforward to add now that everything
  lives in one Supabase table — mainly a question of who should be allowed to.
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
`production_forms` Row Level Security policy is left deliberately open
rather than pretending to restrict access it has no real identity to
restrict by (`app_users` itself is locked down further — writes require the
separate admin PIN — see `docs/USER_ADMIN.md`). Whichever SSO route you
pick, replacing the PIN directory and tightening RLS to match should go
with it.

### About the storage model

Live state (drafts, autosave, the Today board) lives in Supabase — a real
database, needed for the write-heavy, read-heavy pattern autosave and live
viewing create. The static `data/production/*.json` files are only a
fallback for a fresh install with no Supabase project yet; once one is
configured, they stop being read. GitHub still holds the photos, same as the
field forms, since that storage never needed to be "live."
