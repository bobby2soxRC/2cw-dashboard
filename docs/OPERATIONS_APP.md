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
| `buck_hold.html` | On-Stem Flower: the bucking queue (managers set the order) and Take Downs on hold, with the Release to bucking buttons (all, or part under a new tag) |
| `labor_log.html` | Labor Log — people's hours (Connecteam roster) against UIDs, split across several UIDs when needed — see below |
| `master_schedule.html` | Master Schedule — projects, their responsibilities and people, UIDs, and the day/week work schedule (replaced `schedule.html`) — see below |
| `crew_checkin.html` | Crew Check-In — a lead checks in the people on their Master Schedule projects once a shift and moves people between stations during the day — see "Crew Check-In" below |
| `metrc.html` | Metrc Queue — every submitted Wet Intake, Take Down, Bucking, Hand Trim, Mixed Trim Package, Pre-Roll and Outgoing Transfer form, with its Metrc status — see below |
| `raw_inventory.html` | Raw Materials Inventory — what's on hand at each stage from the station forms, tabbed, searchable, CSV export — see below |
| `operations_today.html` | Live board — every form in progress or finished today, for anyone with view access; the date picker (or `?date=YYYY-MM-DD`) shows any earlier day the same way; **Range** shows several days at once (`?date=FROM&to=TO`; it starts as the day before through the day showing, for overnight work like a green harvest, and ◀ ▶ step the whole range), with the Daily Summary table hidden. With Wet Intakes showing, a **Wet Intake by farm** table sits above the forms (and in the PDF): net wet lbs per farm (a license's name, so a farm's licenses add up), split into dry rooms vs freezers — freezer when Fresh Frozen is ticked or the Drying / Freezer Location is one of `reference.json`'s `freezers` — and each intake card shows farm → location (❄ for freezer). 📄 Share PDF prints the day or range as a report. People with `labor log costs` also get a **Labor $** box next to it (off each time the page opens): ticked, the PDF adds a Labor section — Labor Log hours and $ by station (only the picked station's with a filter), and, for all stations, Connecteam clocked hours and $ by activity (the shifts file holds the last 14 days) — at each person's rate from Labor Rates via `labor-rates.js`. A page with day tabs (Bucking, Hand Trim, Pre-Roll) is on every day something was logged on it, not only its start date, with that day's amount (the headline calc on that day's rows; label from `dayTabs.headline`, else "— that day") |
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
**Processing** — Bucking · Machine Trim · Hand Trim / Hand Touch · Smalls Hand Trim · Mixed Trim Package
**Manufacturing** — Biomass Request · Pre-Roll Production · Manufacturing Run
**Shipping** — Product Transfer — Outgoing (directly under Operations on the hub)

Wet Intake and Take Down are the two halves of the paper "Harvest Intake &
Take Down Log", 5–10 days apart: Wet Intake is one form per truck, with the
farm package UID and strain on each bin weigh-in row (bins weighed net of
tare). On submit it's split into one record per UID (`splitBy: 'lines'` on
the station; `splitRecords` in `ops_form.html`), each holding only its own
rows and totals, so everything downstream still sees one package per
record. With more than one UID on the form the Metrc-adjustment fields hide;
they're filled in per intake afterwards from Harvest Intakes.

**Wet Intake: Metrc details come from the Canix sync.** The form doesn't ask
for the farm license, CID, manifest # or driver (fields marked `fromCanix` in
`operations_stations.js`, hidden by `ops_form.html` except on Edit) — the
crew scans the package UID and weighs. Scanning a UID Canix knows also picks
the row's strain (`canixStrainForUid` in `ops_common.js`, from
`data/canix_inventory.json`; only when that strain is in the Strain Library,
by name or alias). Every Canix sync (`scripts/canix_sync.py`,
`fill_intakes_from_canix`, every 3 hours) takes each submitted intake from the
last 45 days with no manifest # and no `canixSyncedAt`, finds its package —
the full tag, or a tail that only one package fits (shipped up to 10 days
before the intake date or the day after, then the same strain) — and calls
the Supabase function `fill_intake_from_canix` with the service role key,
which fills only blank fields:

- `manifestNo` — the transfer's manifest number
- `pid` — the shipping license as its Farm License code (`027` for
  CCL26-0000027, from `ref_codes`), or the full license when none matches
- `cid` — the CID last used for that license, else the Metrc harvest name's
  prefix when it's a CID code (`AGP0027-…` → AGP)
- `canixSync` (full tag, transfer id, Metrc weight, harvest name) and
  `canixSyncedAt`

A farm we have no Canix key for (AutoCanna, Freedom Flora…) has no transfer we
can list; its package is found once it's received at our facility in Metrc,
which gives the license and CID but no manifest #. Until a sync fills an
intake, Harvest Intakes and the Metrc Queue show **Waiting for Metrc sync**
(`awaitingCanix`); filled without a manifest # they show **Manifest #
needed** (`canixNoManifest`) — type it in with Edit from the manifest photo.
Canix has no driver name; it's on the manifest photo.

**Check strain.** Scanning fills the strain only when the package was already
in the last sync; otherwise the crew picks it (or types a new one under
Other). The sync saves Canix's strain for the package (`canixSync.strain`),
and Harvest Intakes (with a **Check strain** filter) and the Today board show
**Check strain** when it isn't the intake's strain (`canixStrainMismatch` in
`ops_common.js`). Canix names often differ from the library's, so they count
as the same when Canix's name is the intake strain's library name or one of
its aliases. It's worked out on the page, not stored: fixing the strain with
Edit, or adding Canix's name as an alias in the Strain Library, clears it. The edit history
records the fill as "Canix sync", and it doesn't count toward the Edited
pill. Intakes from before this change already have a manifest # typed in, so
the sync leaves them alone.

Take Down (station key `dry_check`)
boxes the dried material under a new package UID (**New Dry UID**, field
`sourceUid`). The form starts
with the drying room, then the package from a dropdown of what's still
drying in that room ("Strain - last 4 of UID"; "Not listed" falls back to
typing the UID); the room dropdown shows how many are drying in each. Picking
it shows its full **Intake UID** (`incomingUid`) under the dropdown and
pulls strain/farm license/CID/wet weight from the intake record; picking
another package replaces those, and
`ops_analytics` aliases the on-stem UID back to the farm UID so it stays one
lot. Bucking's page for a lot starts from that on-stem UID.
Its Boxes worksheet numbers the boxes itself (Box # is a `rownum` column:
1, 2, 3… down the rows, renumbered when a row is removed, and on submit
counted over the filled-in rows only, so there are no gaps).

**Currently drying** means a submitted Wet Intake with no submitted Take Down
for its farm UID (`currentlyDrying` / `matchTakeDowns` in `ops_common.js`;
UIDs match when one ends with the other, 4+ characters). Fresh-frozen intakes
never count as drying — Fresh Frozen ticked, or a Drying / Freezer Location
that's a freezer (`isFreshFrozen`: FRZ-…, "freezer"), the same rule as the
Today board's Wet Intake by farm. A package logged as several intakes under
one full tag (two loads, or a row per strain) is taken down by one Take Down.
Any submitted Take Down counts, whatever its Release.
Release is **Release to bucking** (`pass`, the default; Bucking warns on
anything else), **Hold — quality issue** (`rework`) or **Hold — until
needed for an order** (`hold_order`). Material that needs more dry time just
isn't taken down yet; the old `hold` value only appears on older records.
Held Take Downs wait on the **On-Stem Flower** page (`buck_hold.html`, the
hub's "On-Stem Flower" card, also linked from the top of the Bucking
page; newest Take Down per on-stem UID) until a manager taps **Release to
bucking** — only users with the `buck release` checkbox (see
`USER_ADMIN.md`); the Bucking crew sees the list read-only — and picks:
- **All of it** — sets the record's `result` to `pass` and adds `heldFor`
  (the old result), `releasedBy` and `releasedAt`, so its on-stem UID can be
  bucked with whatever is left on it.
- **Part** — for an order: split it off in Metrc under a new tag first, then
  enter the pounds and the new UID. That appends `{uid, lb, by, at}` to the
  record's `releases`; the new tag is bucked on a page of its own and the
  rest stays on hold showing what's left. The pounds must be less than
  what's left (for the rest, use All of it). The dry weight stays on the
  Take Down only — `buildAliasMap` aliases each release tag back to the
  on-stem tag — so lots and yields don't count it twice. `findUpstream`
  finds a release by its tag and gives Bucking its pounds (`unbuckedLb`);
  for the on-stem tag, `unbuckedLb` is the dry weight less any parts.

After a release the page links straight to a new Bucking page for that UID
(`?set_sourceUid=`).
Both re-read the record before writing (two tablets can't overwrite each
other), need a connection (not queued), and are logged by the edit history
trigger. The same rule drives the Take Down picker, Harvest
Intakes' **Currently drying** / **Historical** filters (Currently drying is
the default; drafts count as drying; Historical is taken-down and
fresh-frozen intakes), and Canix Inventory → Processing → Currently Drying,
which leaves out Canix packages that already have a Take Down until Metrc and
the next sync catch up.

Harvest (`harvest`) is the step before Wet Intake and is built the same
way: one form per truck load, split into one record per Source UID on
submit. Since 2026-10-19 the worksheet follows the crew's notebook (a column
per strain, a weight per bin, the plant count once): **license → strain →
bins** (lineitems `group` + `lots`, `buildLotSheet` in `ops_form.html`).

- It starts with one **Source License** dropdown (Farm Licenses, or Other);
  **+ Add another license** adds another for a load from more than one.
- Under a license, **scan a plant tag** in the scan box: a tag not on the
  load yet starts a **strain box** with it as Source UID, and the strain
  fills in from Canix (`canixStrainForUid(uid, true)` looks the tag up in
  `data/canix_plant_batches.json`, then the package inventory; only a Strain
  Library strain is filled in — otherwise the box says what Canix calls it).
  A tag already on the load jumps to its box's next empty bin. **+ Add
  strain** starts a blank box.
- A strain box: Source UID, Strain, Location (typed), **Transfer UID** (the
  package going on the truck — scan it), then 3 bin rows to start (**+ Add
  bin** for more), each with Wet Wt (required) and Plant Count. The plant
  count can be on every bin or once on any bin (like the notebook), but each
  strain needs one (`lots.plantsReq`). The box shows its bins, lbs and plants.
- `values.lines` is still one row per bin; every row carries its license
  (`pid`), its box's fields, `_lot` and `bin`, and each record gets the
  license, location and Transfer UID lifted to the top.
- Header: date, a **Fresh Frozen** checkbox (off by default), truck #
  (optional), **License Plate** and **Driver** (both required). No
  crew/labor fields — harvest labor goes in the Labor Log.
- **After submit** (`share: true` → `openShare`): a window with a picture of
  the load (a column per strain, its bins, totals; driver, plate) and **Send
  on WhatsApp**, which hands the picture and a CSV (a row per bin) to the
  phone's share sheet — pick WhatsApp and the chat. It has to be a tap, not
  automatic: phones only open the share sheet from one. A browser that can't
  share files (desktop) downloads both and opens WhatsApp with a text
  summary. It also opens for a submit saved offline. **New harvest form**
  starts the next one.

- **License Plate** (`platePicker`) lists the trucks set up in the admin
  panel's **Drivers and Trucks** tab ("PLATE — #truck · description", the
  `trucks` table, read through `drivers.js`), then any other plate already
  used on a submitted Harvest form, plus Other to type a new one. Picking a
  truck that has a Truck # fills the form's Truck # when it's blank. It
  can't come from the farms' Metrc transfers: Canix's transfer data has no
  vehicle or driver details (Comstock, Wildcat and Lucern's transfers only
  carry a route note like "follow GPS route").
- **Driver** (`driverPicker`) is the `drivers` table, shown "Name — ID #",
  read through `netlify/functions/drivers.js` (any logged-in PIN; no
  photos). **+ Add a new driver** asks for first name, last name, ID number
  and a photo of the ID, all required, and saves it right away (needs a
  connection; an ID number already on the list just picks that driver). The
  record keeps `driver` (the name), `driverIdNumber` and `driverId`. The ID
  photos are seen only in the admin panel's **Drivers and Trucks** tab
  (`docs/USER_ADMIN.md`). Needs the `drivers` table from
  `supabase/schema.sql` run first.

Records from before this change keep their farm site, farm license (at the
top), round, harvest style, destination, batch name, block/row and driver
ID photo; reopening one with Edit puts them in a strain box per UID, but
saving it then needs a Transfer UID.

Pre-Roll Production (`preroll_production`) follows the paper pre-roll sheet
and, since October 2026, runs like Hand Trim: one page per **run**
(`sharedDay`, with `switcher` labels "Runs open" / "+ New run"), so several
runs can be open at once and a new one started before the last is closed;
each stays open across days until QC and the secondary verification are done
and it's submitted. Delete this page (`canDelete`) is there for a run started
by mistake. Under the run tabs are **day tabs** (`dayTabs: { lines:
['output', 'attendance'] }` — several logs share the tabs; the chips total
the first): the Pre-Roll Output log and the Crew show the picked day and
stamp new rows with it, and the totals below cover the whole run. The Start
Date always has a tab, and a run with nothing logged yet opens on it (and
moves to it when the Start Date is changed — `goToStartDay`), so a backdated
run's crew, project and output land on the day it was done. **✎ Change
date** (next to + Add day) moves the picked tab and everything logged on
it to another date (`moveDay`): its rows are re-added under new ids with
the old ones in `_deleted` so other tablets follow, and that day's project,
its `runDays` entry and the Start Date (when it was that day) move too.
The tab it leaves behind goes away when nothing is left on it. **✕ Remove
day** takes off the picked tab when nothing is logged on it and it isn't the
Start Date — e.g. Today on a backdated run. Removed days are kept in
`hiddenDays` (merged across tablets like `runDays`) and stay off unless
something gets logged on them or the day is added again. A row in
the output log needs a pre-roll count or a waste weight. New UIDs, finish
date, QC and verification sit under "End of Run". Because both are running
logs (`entry: true`), two tablets on one run merge their rows.

**Crew** (`attendance`, field type `crewcheck`, `buildCrewCheck` in
`ops_form.html`) replaced the Workforce Log of hours in October 2026. It
lists who the Master Schedule has on the run that day: that day's
**Project** — its lead and its pre-roll responsibilities (a blank process
is the project's; a project with none of those shows everyone on it) — or,
with no Project picked, every project running that day for pre-rolls, with
that day's Change this day applied (people off left out, extras in). Each
person is marked **Here** or **Not here** ("Everyone else scheduled is
here" marks the rest), and anyone else working can be added from the
Connecteam roster or typed in (× takes them off again). Every tap is a row
`{key, userId, name, status: here | out | added | removed, day, at, by}`;
the latest per person per day counts (`crewLatest` in
`operations_stations.js`), so tablets merge. People on this Run
(`crewSize`) counts everyone here on any day.

The marks are also written to the Master Schedule, as that day's changes
on the project (`overrides[day]`, the same as Change this day there —
`syncCrewToSchedule`, after each autosave and on submit, through
`patchWorkProject` in `ops_data.js`): someone on the project marked Not
here goes in `out` (Here takes them back off it); someone added goes in
`extra` under the project's pre-roll responsibility (else its first), and
comes off when they're taken off or marked Not here. Only people the page
marked are touched, only on days the project runs, and with no Project
picked only when exactly one pre-roll project runs that day. A mark made
on the page wins over the schedule's day changes on the page itself, so
someone marked Not here stays listed that way. The hours, and so the cost, come from the Labor Log
through the run's Project (below). Runs from before keep their Workforce
Log (`crew`): the dashboard detail shows it, `crewLaborLog` still reads
it, and a run already open when it went carries it along (resumed pages
keep saved keys the form no longer shows). There's **one run per
request**: a Queue tab (`queueTab`) lists the pre-roll queue in the
dashboard's order (`loadPrerollQueue`, with each request's pre-rolls to make
and made so far — `made`, from its runs' `totalPrerolls`), with Start (a new
run, the same `set_…` link as the dashboard's Start batch) or Open (the run
already going); and the Production Request dropdown leaves out requests
already open on another run.

**Hand Trim / Hand Touch** (`hand_trim`) runs like Bucking: one page per
lot (`sharedDay` — every open page, anyone's, is in the "Lots open"
switcher; a lot open on another page drops out of the dropdown), autosaved
until submitted, with Delete this page (`canDelete`). The weighing worksheet
is a running log (`entry: true`) so two tablets on one lot merge their bags;
blank rows saved back when it was a grid are skipped on load. The entry bar
takes Bags × Grams each (454 stays filled in) plus a Partial (`multi` on the
field) and logs a row per bag. A lot is often trimmed over several days, so
the page has **day tabs** under the lot tabs (`dayTabs`): one per day with
bags logged, today, and any added with "+ Add day" (kept in `runDays`,
merged across tablets). The log shows the picked day's bags and stamps new
ones with that day (`day`); the totals below are the whole lot, and the
Daily Summary — Pounds by Person table follows the picked day. A bag's tab is
the day it's credited to, which the operator picks — bags trimmed one day are
often weighed the next: pick that day's tab before weighing, or tick the bags
in the log and **✎ Move N checked to…** (`moveChecked`) moves just those to
another day (Change date with nothing ticked moves the whole tab). A bag
credited to another day than it was weighed shows the weighing date in the
log. A page left open overnight that was on Today moves to the new Today
when the date turns over (`rollDay`), so new bags don't land on yesterday. On a
page with day tabs (Hand Trim, Bucking, Pre-Roll) the **Date** box at the
top just shows the picked tab's date, read-only (`syncDateBox`); dates are
changed on the tabs. The run's Start Date (`values.date`, the record's
`work_date`) is kept behind it and follows its tab, to the run's first day. Smalls, trim,
waste and the rest sit under an "End of Run" heading (`t: 'heading'`) and
are filled in on the last day before submitting. It starts from bucked flower. Its
Lot Number is a dropdown of every bucked lot (`picker: { list: 'bucked' }` —
`buckedLots` in `ops_common.js`, one per UID): submitted Bucking records,
plus lots still on an open Bucking page with some flower logged ("— bucking
in progress", `buckedFlowerLb` = bucked so far, and a warning to update the
starting weight if more comes over). The trimming queue's lots come first in
queue order, then the already-trimmed ones, newest first. Picking one fills
the package UID, strain, starting bucked weight (Bucking's `buckedFlowerLb`)
and the customer ID, traced back through Take Down to Wet Intake. A Queue tab
(`queueTab`) shows the trimming queue; Start opens a new page with
`set_sourceUid`, which is resolved against the lot list once it loads. "Other — not on the list" is for bucked
flower brought in from elsewhere: a popup (`otherPopup`) asks for the strain
and package UID, and the CID is entered by hand. Outputs: the weighing
worksheet's finished flower, smalls, Normal Trim (`normTrimLb`, category
`trim`), A+ Trim (`aPlusTrimLb`, `trim_a_plus`) and waste. Finished flower
and smalls each get their own new Metrc package tag, which doesn't exist
until the package is made in Metrc, so the tags aren't on this form: the
Metrc Queue fills them in after submit (station `metrcTags` — see Metrc
Queue below). Trim isn't tagged per strain (since 2026-10-20): it waits on
the lot's tag until a **Mixed Trim Package** (below) packages it with other
lots' trim. Waste stays on the source tag and is wasted out there. The Trimmer Rate
($ per lb, `trimRatePerLb`) is required to submit — trimmer pay is pounds ×
it. Work order #,
farm license, trim style and starting bins were dropped in October 2026;
`sugarTrimLb` is off the form but stays in the totals and flow for older
records.

**Mixed Trim Package** (`trim_package`, Processing) — every couple of days
the trim on hand is packaged together instead of one package per strain. The
form is the list: who made it (`requestedBy`), what the new package is
(`packageType`: Trim / A+ / Sugar / Shake, mixed), and a row per source
package going in (`lines`: UID — the strain fills in from Canix — trim type,
lbs), totalled in `totalLb`. In the Metrc Queue its one new tag is
`newMixedTrimUid` (`metrcTags`). Raw Inventory takes each row off its source
package's trim and lists the mixed package (strain "Mixed") under its new
tag. No SQL.

**Product Transfer — Outgoing** (`transfer_out`, dept Shipping — it sits
directly under Operations on the hub, as `index.html` puts any dept without
a folder there) is the paper "Product Transfer Form (OUTGOING)", version 7:
person completing it (`completedBy`), date of request, requestor, customer,
DCC license #, destination, customer order / sales order / invoice #, terms
(DF / MC), proposed and actual transfer dates, Driver and Vehicle Plate (the
same `driverPicker` / `platePicker` as Harvest), then a row per package
(`lines`: product type code 1–8 from `TRANSFER_TYPES` in
`operations_stations.js`, strain, PID, CID, source package UID, weight —
pieces for pre-rolls — transfer package UID, price per lb). Subtotal lbs
(pre-rolls left out), pre-roll pieces and total $ are worked out. The
office checklist is seven checkboxes (transfer log, order tracker, sales
tracker, manifest initiated / accepted, invoice sent, processor inventory),
ticked later with Fix form. It's in the Metrc Queue for the manifest, and
Raw Inventory takes each row off its source package on the tab its product
type says (1 On-Stem, 2 Bucked, 3 Flower, 4 Smalls, 5 Trim, 6 Fresh Frozen;
seeds and pre-rolls aren't tracked there). No SQL.

**Work Orders** (`work_orders.html`, hub card `work_orders` directly
under Operations) puts the work queues on one page, a tab each (`?tab=buck|trim|preroll`):
- **Bucking** — `loadBuckingQueue`, the same list and order as the On-Stem
  Flower page (which still has it, with the holds).
- **Hand Trim** — `loadTrimQueue` (`ops_data.js`): every bucked lot,
  including ones still being bucked, with no submitted Hand Trim yet, with
  bucked and trimmed-so-far pounds. The order is one shared
  `operations_forms` row like the bucking queue (`TRIM_QUEUE_ID`,
  station_key `trim_queue`); unordered lots go last, oldest bucked first
  (`orderTrimQueue`).
- **Pre-Roll** — the Pre-Roll Dashboard's queue in a frame
  (`preroll_dashboard.html?embed=queue`, which hides everything else and
  opens links in the whole window), so ordering, adding and Start batch work
  exactly as on the dashboard, which keeps its queue too.

Bucking and Hand Trim are reordered by 'buck release' managers; others see
the order. Tabs show by access: Bucking / Hand Trim to their station's edit
access or 'buck release', Pre-Roll to `preroll_production` edit access or the
Pre-Roll Dashboard card (`2cw_preroll_dash`, set at login). The card is
`ambient`, so someone with only one station still lands straight on it.

**Smalls Hand Trim** (`smalls_trim`) is the paper "Work Order Form (Smalls |
By the Hourly)": one page per flavor per day — package UID, strain, starting
lbs, then the weighing worksheet (employee #, grams, one row per bag), with
grams → lbs worked out (÷ 454, `G_PER_LB`), shake, waste and
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
source UID, estimated start/completion, lead, on-hold, notes, and overrides
for the Sheet's Batch Size (`quantity`) and Strain Type (`strain_type`,
Indica / Sativa / Hybrid) — each stored only when it differs from the Sheet. "Start batch"
opens Pre-Roll Production with `?set_prNum=…&set_strain=…` (any form accepts
`set_<fieldKey>` starting values on a brand-new form), and the dashboard
reads those forms back by `prNum`: an open draft means in production, a
submitted one means done, and the total pre-rolls made shows as progress.
A request is late if its plan finishes after the Sheet's Ready Date, or the
Ready Date has passed. English/Spanish via the shared `2cw_lang` toggle.

**Pre-Roll Queue** (top of the Pre-Roll Dashboard) is the order to make
things in, like the bucking queue. It lists every open pre-roll request that
isn't on hold, plus batches added by hand with **+ Add to queue** (brand,
type, strain, source UID, quantity, notes — `preroll_queue_items`, shown as
`PQ-<queue_no>`). Each row shows brand · strain, the ref (PR# or PQ-#), the
source UID, the quantity and how many are made, with ▲ ▼ / Top, Edit plan /
Edit, and Start batch / Open batch. The order is one shared `operations_forms`
row (`station_key: 'preroll_queue'`, fixed id `PREROLL_QUEUE_ID`,
`fields.order` = refs); anything not in it goes last by Ready Date / date
added. Start batch fills Pre-Roll Production's `prNum` and Batch ID with the
ref, so a hand-added item is tracked the same way as a request, and it drops
off once that batch is submitted. Remove from queue only stamps `removed_at`.
Brand for a request comes from its BSKU code (SRF, HWR, MDO).

**Submitted Runs** (bottom of the Pre-Roll Dashboard) lists every submitted
Pre-Roll Production form, newest first (10, then Show all), whether or not it
carries a request: strain, dates, PR# / Batch ID, labor hours, % of starting
weight accounted for, who submitted it, and pre-rolls made. A "Check" pill
means a calc field's `flag` tripped. Tapping one opens the whole record,
drawn off the station definition (so the page loads `operations_stations.js`,
whose `num()` it shares), with an Edit button for people `canFixSubmitted`
allows. The open run's id goes in the URL (`?run=<id>`), so it can be linked.

With **Pre-Roll Dashboard — see labor cost per pre-roll** (`preroll costs`,
see `docs/USER_ADMIN.md`), each run also shows labor $ per pre-roll, and its
detail a Labor Cost section (whole-run $ and $ per pre-roll). For a run with
a **Project** (every run now — the form no longer takes hours) it comes from
the Labor Log, as below. Older runs are costed from their Workforce Log's hours at the rate in effect on each row's date (`rateFor`),
worked out server-side by `netlify/functions/preroll-costs.js`. Rates are
keyed by Connecteam user id but the form logs employee IDs (badge numbers),
so each badge is looked up in `employee_badges` (admin panel → Labor Rates
→ Badge #, see `docs/USER_ADMIN.md`) first. Hours on a badge nobody has
mapped, or on a person without their own rate, fall to the default rate.
The detail says how many hours did. Hours with no rate at all aren't costed.
A run with a **Project** picked is costed from the Labor Log: its
share of the hours logged to that project (`laborAllocations`, split over
the project's UIDs by pounds), counting the allocations on the run's source
UID — at each person's own rate, by Connecteam id. Its Workforce Log isn't
counted then, so nothing is costed twice; the detail says where the cost
came from (`source: 'project'`).

**Pre-roll products and pack quantities.** Quantities on requests and queue
items are in units — packs, or singles — not pre-rolls. `preroll_products`
(keyed by BSKU; managed from the dashboard's **Products** button) says how
many pre-rolls are in one unit (`pack_size`) and how big each one is
(`preroll_size_g`), e.g. Soma Rosa 28-pack = 28 × 0.5 g, Soma Rosa 1g = 1 ×
1 g, Mendo 10-pack = 10 × 0.5 g. A request uses the product matching its
Sheet BSKU unless Edit plan picks another (`preroll_plans.product_bsku`);
hand-added items pick one with Brand → Product
(`preroll_queue_items.product_bsku`). The dashboard shows units × pack size =
pre-rolls (and the grams of flower that takes), measures Made against that,
and Start batch fills the form's Pre-Roll Size (`set_unitSizeG`). No product →
the quantity is taken as pre-rolls. Products are never deleted, only made
inactive.

**Production Request dropdown on the form.** Pre-Roll Production's
Production Request (`prNum`, `prPicker` in `operations_stations.js`) is a
dropdown of the open Pre-Roll Queue in the dashboard's order
(`loadPrerollQueue` in `preroll_queue.js`, which the dashboard also uses for
the Sheet URL, CSV parsing and the pre-roll filter). Each option shows rank,
ref, product, strain (or type) and quantity; under it, the pre-rolls to make,
the pre-roll size and the Ready Date. Picking one fills Batch ID, Brand,
Pack Type, strain, source UID and Pre-Roll Size (`prPicker.fills`) with
whatever the request has (Brand and Pack Type come from its product in
`preroll_products`; a brand name is matched to the Brand list's label); the
operator fills in the rest. Start batch / Start pass Brand and Pack Type too.
Brand · Pack Type show under the form name in the Metrc Queue. A value a pick put in is replaced by the
next pick; anything typed over it is kept. "Other — type the PR #" shows a
text box for a request not in the queue. A draft opened again, or a form
started from the dashboard's Start batch, comes up with its request selected.

**Harvest Intakes** (`harvest_intakes.html`, hub card `harvest_intakes` under
Processing) lists every Wet Intake, drafts and submitted, newest first, with
a "Waiting for sync" filter (see Metrc details above) and a "Metrc not adjusted" filter. Clicking one shows the whole record. Access is
two checkboxes in the admin user editor: View (`harvest_intakes` column) and
Edit (`harvest intakes edit`, implies view), turned into `2cw_intake_access`
at hub login. Edit reopens a submitted intake in `ops_form.html?edit=<id>`:
no autosave, and Save goes through `updateSubmitted()` in `ops_data.js`,
which only touches rows still `submitted`. The original submitter and
`submitted_at` stay; `updated_by` and `fields.lastEditedBy/lastEditedAt`
record who changed it. This is how a second person records the Metrc
adjustment (`metrcAdjusted` + `metrcAdjustedLb`) after someone else did
the intake.

**Fixing submitted forms from the Today board.** The admin user editor's
"Fix submitted forms" checkbox (`ops fix submitted` column, under Processing —
edit access) puts an Edit button on every submitted form on
`operations_today.html` for the stations that person has edit access to. It
opens the same `ops_form.html?edit=<id>` correction mode (with `&from=today`,
so Back and Save return to that day on the board). Access is
`canFixSubmitted()` in `ops_common.js`: Wet Intakes with Harvest Intakes edit,
or `2cw_ops_fix` (set at hub login) plus station edit access. Correcting a
Take Down keeps its own package in the "Package Drying" list. The edit
history trigger logs these edits like any other; the card shows "edited by".

**Deleting submitted forms.** The admin user editor's "Delete submitted
forms" checkbox (`ops delete submitted` column, next to Fix submitted forms;
implies it, set as `2cw_ops_delete` at hub login) puts **Delete this record**
at the bottom of that correction page (`?edit=<id>` — reached from Edit on
the Today board or the Pre-Roll Dashboard's Submitted Runs), on the stations
the person has edit access to (`canDeleteSubmitted()` in `ops_common.js`;
Wet Intakes also with Harvest Intakes Delete). It opens a popup naming the
record that asks for a reason, then deletes it through
`operations-records.js` (`action: 'delete'`, `deleteSubmitted` in
`ops_data.js`), which re-checks the column and the station edit access from
the PIN and only covers station forms (not Master Schedule projects or Labor
Log entries). The edit history keeps a copy with who and why, and the
record's packages come off its Master Schedule project(s). On a station
that saves one record per UID (`splitBy`), only the opened record goes.

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

**Metrc Queue** (`metrc.html`, hub card `metrc_queue` under Operations)
lists every submitted form that usually means work in Metrc — Wet Intake,
Take Down, Bucking, Hand Trim, Mixed Trim Package, Pre-Roll and Product
Transfer — Outgoing (`METRC_STATIONS` in the page
and in `netlify/functions/metrc-queue.js`; change both together), however old —
only ones submitted through the app: records loaded from the paper sheets
(`owner_user` `paper_import`) are left out.
It's a table — status, form, date, strain, UID, manifest # (Wet Intake
only, with a Copy button), photo, new UID, amount, who
submitted it, days waiting, note, last change. The photo column's 📷 View
button (on any form with an uploaded photo — the intake's manifest photo,
scale photos…) opens it full-screen over the page; ← → step through a form's
photos, Esc closes. Photos in the opened form open the same viewer. Each form is To do until
someone changes it, then In progress, Done or Not needed: with Edit, pick it
in the row's dropdown and hit that row's Save. Open work is listed oldest
first; the counts at the top double as filters. Clicking a row opens the
form, where the note (adjustment #, new tags…) is set too. Opening one shows the whole form — tapping a value copies it (stored codes
and plain numbers, ready to paste into Metrc) — plus the status history.
Fix form (for people who can fix submitted forms) opens `ops_form.html?edit=`.

**Incoming transfers to accept.** Tap its heading to collapse it to one line
(count, overdue, urgent); it stays collapsed on that device
(`localStorage` `metrc_inc_open`). Above the counts: every Metrc transfer to
one of our licenses (`data/canix_facilities.json`) with a package still
"Shipped" — not yet accepted — from `data/canix_transfers_recent.json`
(`incomingTransfers` in `metrc_transfers.js`; tests:
`node scripts/test_metrc_transfers.js`). California requires receipt to be
recorded in Metrc within 24 hours (4 CCR § 15049(b)); Canix has no arrival
time, so the clock starts at departure (the earlier, safe deadline). Each
row shows hours left; **Urgent** at 8 h or less (`URGENT_H`), **Overdue**
past 24 h, soonest first. Canix's `departure_time` is California wall-clock
time with a "Z" on it, read as Pacific (`pacificTime`). Limits: it's only as
fresh as the last Canix sync (every 3 hours; Admin → Data Syncs runs one
now). **Outside farms** (a license we don't have in Canix) aren't in Canix
until their package is accepted, so they come from Wet Intake instead
(`unacceptedIntakes`): an intake from the last 4 days (`INTAKE_DAYS`) whose
scanned UID is on none of our Canix transfers and not in our Canix inventory
(`data/canix_inventory.json`) at one of our licenses — received on the floor,
not accepted in Metrc yet. Its clock starts when the intake form was started;
one row per manifest # (else per intake), "Wet Intake — not in Metrc yet"
opens the form. It drops off once the next sync sees the package at our
license. A UID typed wrong can keep one listed — fix it with Edit. Outside
farms whose load isn't on a Wet Intake yet still only show in Metrc's
Incoming tab.

**New Metrc tags.** A station with `metrcTags` (operations_stations.js —
Hand Trim: Finished Flower `newFinishedUid`, Smalls `newSmallsUid`; Mixed
Trim Package: `newMixedTrimUid`; Bucking: `newBuckedUid`, only on a lot
ticked **Holding as bucked flower**) gets a **New Metrc tags** box in the
opened form: one line per output the form made (pounds > 0, and the tag's
`when(fields)` true if it has one), with the new
package tag typed or scanned once it's made in Metrc. Save sends them with the
status and note; `metrc-queue.js` checks each against the station's
`metrcTags`, upper-cases it, and writes the changed ones onto the form record's
`fields` (blank clears one); the status history logs them. The table's New UID
column lists them, with "+N without a tag" while some are missing. They aren't
on the floor form (Fix form keeps them). Hand Trim's Normal / A+ / Sugar
Trim tags (`newTrimUid`, `newAPlusTrimUid`, `newSugarTrimUid`) have `when`
false: trim is packaged mixed now, so they only show on older records that
already have one. Every tag traces back to the lot
(`buildAliasMap`), Raw Inventory lists each output under its own tag, and the
Labor Log and Master Schedule offer them as UIDs. To give another station
per-output tags, add `metrcTags` to it (it must be in `METRC_STATIONS`).

Statuses live in the `metrc_queue` table, one row per form, created the
first time its status is set (no row = To do; deleting the form deletes the
row); `log` keeps every change with who and when. The page reads it with the
anon key and updates live. Access is two admin-panel checkboxes, View
(`metrc_queue`) and Edit (`metrc queue edit`, implies view), turned into
`2cw_metrc_access` at hub login. Edit only shows the controls: saves go
through `netlify/functions/metrc-queue.js`, which re-checks the column from
the PIN — anon has no write access to the table. Separate from Wet Intake's
own Metrc adjusted / adjusted lb fields, which stay as they are.

**Raw Materials Inventory** (`raw_inventory.html`, hub card `raw_inventory`
under Operations, admin checkbox column `raw inventory`) is the app-data
counterpart to Canix Inventory: what's on hand at each stage, worked out on
the page from the submitted station forms, no table of its own. Tabs: **All**,
**Drying** (`currentlyDrying` — submitted Wet Intakes with no Take Down, wet
lbs, drying room), **On-Stem** (the bucking queue's packages, less boxes
pulled on an open Bucking page, plus Take Downs on hold — `loadBuckingQueue`),
**Bucked** (the trimming queue — `loadTrimQueue` — less flower already weighed
on an open Hand Trim page, and lots with a Machine Trim left out), **Flower**,
**Smalls** and **Trim** (each Hand Trim, Machine Trim and Smalls Hand Trim's
outputs, and Bucking's trim; trim shows its type — Normal, A+, Sugar, Shake,
Bucking trim) and **Fresh Frozen** (fresh-frozen Wet Intakes and Fresh Frozen
forms). Each tab shows its packages and pounds. Farm license, farm name,
farm code and CID come from the record or are traced back through Take Down to
the Wet Intake; the full license is the Canix sync's shipper license, else the
Canix facility whose license number ends in the farm code. A finished output
is listed under its own new tag (Hand Trim's `metrcTags`, Smalls Hand Trim's
`newFinishedUid`) once it has one, else under its lot's UID ("lot UID").

Search matches every word against strain, UID (the farm UIDs behind it too),
license, farm name, farm code, CID and location (FRZ, 3A…). Column headers sort. **Export CSV**
downloads exactly the rows showing (tab, search, Show used up). The tab and
search are in the URL (`?tab=flower&q=agp`).

Flower, Smalls, Trim and Fresh Frozen come down when a Pre-Roll run,
Manufacturing Run, Biomass Request (transferred), Smalls Hand Trim, Mixed
Trim Package or Product Transfer — Outgoing names their UID and category
(oldest first; the row shows what was taken). Anything that leaves without
a form can be marked **Used up** (and
Restored) by people with `buck release` or Metrc Queue edit. Marks live in one
shared `operations_forms` row (`station_key 'raw_inventory_marks'`, fixed id),
re-read before each write, logged by the edit history trigger; Show used up
lists them again. The page reloads itself when forms change.

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

The form has an English / Español toggle (top right). It switches in place
without losing anything typed, remembers the choice in the same `2cw_lang`
setting the station forms use, and `?lang=es` on the link opens it in Spanish.
Page text is tagged `data-i18n` in the HTML with the Spanish in `ES_TEXT`;
service names and rates come from `es` / `rate_es` in `drying_services.js`
(add both when you add a service). The function still answers in English and
the page translates its known messages. Submissions are identical either way.

The form also requires the legal business name, state incorporated, the
business street address (street, city, state, zip — `business_*` columns),
the
Service Agreement signer (first/last name, email) — columns on
`drying_intakes`, editable in the schedule editor — and two attachments: the
cultivation license and a W-9. Those go to the private `customer-docs` bucket
under `requests/` (the function hands out a one-time signed upload URL, the
page uploads straight to Storage, and the submit checks both files are there)
and are recorded in `drying_request_docs`, which has no anon policy. The
schedule editor lists them for users with `customer documents` access, via
`customer-docs.js` (`request_docs` / `request_doc_url`). Uploads are capped at
100 an hour; files from a form that's never submitted stay in `requests/`.

**Service Agreement PDF** — `msa_agreement.js` fills the Master Service
Agreement (the 10-1-2026 wording, typed into the file) with a customer's
details and builds the PDF in the browser with jsPDF (loaded from jsDelivr on
first use; Times, letter, page numbers). Two ways in: the **Service Agreement
PDF** button in the Drying Schedule editor, which uses what's on the screen
(unsaved edits included), and the same button under Signed MSA on a
customer's Documents sheet (Customer IDs tab), which offers every drying
request in a "Fill from a drying request" list and preselects one whose farm
or legal name matches the CID. Either way a dialog shows each fill-in for
checking: legal name, entity type (guessed from the name — "LLC" → Limited
Liability Company), state of formation, effective date, the Notices address
block, signer name and title, and the Exhibit B lines. Exhibit B lists
every service we offer with its unit and rate — so a customer who adds a
service later doesn't need an amendment — and the ones they asked for get
the details: drying the estimated wet lbs and harvest dates, farm support
its dates and crew. The mailing address comes from the request's business
address; the signer's title isn't on the form, so it's typed in the dialog; anything left blank prints as a line to fill in by hand.
Nothing is saved — upload the signed copy under Signed MSA as before.

**Invoice request to Finance** — a separate button in the Drying Schedule
editor, unrelated to the agreement: 2CW Operations asking 2CW Finance to
invoice the customer for the drying deposit. Its own dialog
(`MSA.openInvoice`, same file) takes who to bill (legal name, entity,
farm, license #, mailing address, contact), the estimated wet lbs and the
drying rate, and shows the deposit live: 20% of lbs × rate (MSA section
3.B.a, `DEPOSIT_PCT`). The one-page PDF reads From 2CW Operations / To 2CW
Finance, with the logged-in name as requester, and also lists the expected
harvests and the other services requested (to bill as performed).

**Invoice request for services** — for work already done, the
**Invoice request to Finance** button on the Customer IDs tab (top of the
tab, and on each customer's Documents sheet) opens `invoice_services.js`
(`InvoiceServices.open`). Pick the customer, then a process, and the work done
for them there is listed to tick onto the request:

- **Drying** — their Wet Intakes (by CID), net wet lbs.
- **Bucking** — bucked lots, the CID traced back through Take Down to Wet
  Intake (`buckedLots`); quantity is the dry weight bucked (boxes taken).
- **Machine / Hand trim** — the record's CID or one traced from its UID;
  quantity is the bucked pounds in.
- **Transport** — Labor Log hours with process Transport, one item per day
  (and project). A truck runs once however many ride in it, so the quantity
  is the longest anyone logged that day; the vehicle (box truck, cargo van,
  reefer) is picked on the line, and the box truck takes its 8-hour rate at
  8 hours or more.
- **Farm labor** — Labor Log hours at Harvest, Wet Intake, Take Down or Other,
  per day / process / project, in person-hours.
- **Other** — any service from the price list (storage, batching, testing) or
  a blank line, which can be negative (e.g. less the deposit already invoiced).

Labor Log hours belong to a customer when they're logged to one of the
customer's Master Schedule projects — the project's **Customer (CID)** field,
or else the CIDs its UIDs trace back to — to UIDs that trace back to them, or
to a farm license their Wet Intakes used. Hours logged to nothing are offered
when one of the customer's projects ran that day (marked as such), and "Also
show hours not tied to any customer" lists the rest.

Each line starts at the customer's **contract rate** and the rate can be
changed (a rate under contract shows the % off); the whole request can take a
% or $ discount. Any discount or rate under contract needs a reason, which
prints on the PDF with the contract rate, the rate charged and the totals.
Contract rates are kept per customer in `operations_forms` rows with
`station_key 'customer_rates'` (`{ cid, rates: { service key: $ }, source }`):
making the Service Agreement PDF from a customer's Documents sheet saves its
Exhibit B rates there, and the dialog's "Contract rates → View / edit" changes
them. Without one, the standard rates (`EXB` in `msa_agreement.js`) apply.

**Save & download PDF** saves the request as an `operations_forms` row with
`station_key 'invoice_request'` (number `IR-<CID>-<date>-<n>`, bill-to, lines
with the record / labor entry ids they cover, discount and totals) and then
downloads the PDF. Anything on a saved request shows as invoiced (red ✓,
under "Already invoiced") and can't be ticked again; part-invoiced labor days
show only the hours not billed yet. "Earlier requests" on the dialog
re-downloads a request's PDF or voids it (with a reason), which frees its
work to invoice again. Both row types use the open anon access the rest of
`operations_forms` has, and the history trigger logs edits — no schema change.

When the agreement's wording changes, edit `blocks()` in `msa_agreement.js` (and
bump `CACHE_VERSION`); new services need an `EXB` entry there as well as in
`drying_services.js`.

Each stage pulls its input weight forward from the stage before it: type the
last 4 of the Metrc tag and bucking fills in the dry weight the post-dry check
recorded. Every stage totals its own outputs and shows the variance against
what went in, live, while the operator is still standing at the scale.

## Bucking

Bucking (`buck`) is built like Smalls: one page per on-stem UID (flavor), on
`ops_form.html` with `sharedDay: true`, so the switcher at the top lists
every open bucking page from anyone, plus "+ New flavor". A batch can take
several days; an older page stays in the switcher (with its start date)
until it's submitted. The package is picked from a dropdown of what's **ready to buck**
(`picker: { list: 'buckable' }`; `buckablePackages` in `ops_common.js`):
every Take Down released to bucking (newest per on-stem UID, with what's
left after any parts) and every part released off a held one under its own
tag, less any UID that already has a submitted Bucking record or is open on
another bucking page. Each reads **Strain || abbreviation || last 4** (the
abbreviation is the strain library's `abbreviation`, "—" if none). Picking
one fills the UID, strain and **dry unbucked weight** (`PREFILL_MAP.buck`).
"Not listed — type the UID" still allows typing a tag; a typed UID still
on hold at Take Down shows a warning to release it first. The
**On-Stem Flower** link at the top (station `links`) opens
`buck_hold.html`.

**Day tabs.** A batch is often bucked over several days, so like Hand Trim
and Pre-Roll the page has a tab per day under the flavor tabs (`dayTabs:
{ lines: ['bucked', 'recovered', 'boxes', 'trim'] }`): one per day with anything
logged, the Start Date, today, and any added with "+ Add day" (`runDays`).
The Boxes, Bucked Flower and Trim logs show the picked day's rows and stamp
new ones with that day, so a box or a person's flower weighed yesterday can
be logged on yesterday's tab; the day chips total bucked flower. **✎ Change
date** and **✕ Remove day** work as on Pre-Roll. Box # keeps counting
across the whole batch, the Stems log (close-out) shows every row, and the
totals, loss and yield below cover the whole batch. The Daily Summary
follows the picked day, and each day can have its own Project
(`projectDays`). Rows logged before the tabs already carry their `day`, so
open pages split into tabs by themselves.

**Holding as bucked flower.** Bucked flower normally goes straight to
trimming on the on-stem tag — no new Metrc package (since 2026-10-20, so
tracking keeps up when a whole lot is processed quickly). Only a lot that
will sit as bucked flower (waiting on an order, like the Gelato) is ticked
**Holding as bucked flower — needs its own Metrc tag** (`holdBucked`); the
Metrc Queue then asks for its bucked-flower tag (`newBuckedUid`, a
`metrcTags` entry with `when`). Hand Trim's lookup and `buildAliasMap`
already find the lot by that tag, and Raw Inventory's Bucked tab lists it
under it.

**Deleting a page.** "Delete this page" under the form (station
`canDelete`) is for a page started by mistake. It asks first (naming the
strain / UID and how many boxes, bucked and trim rows go with it), then
deletes the open page and opens a blank one. The browser can't delete
forms (no anon DELETE), so it goes through `operations-records.js`
(`action: 'delete_open'`, `deleteOpenPage` in `ops_data.js`): it checks the
PIN and the person's edit access to the station (`OPEN_PAGE_DELETE` lists
the stations allowed), refuses a submitted record, and deletes through
`delete_operations_form`, so the history log records who did it. Another tablet with that page
open locks on its next check ("deleted on another tablet") instead of
re-creating it on its next autosave (`checkDraft` tells a missing page
apart from a dropped connection).

**Merged dry UIDs.** Several farm packages of one strain can be taken down
into one new dry UID (a Metrc merge): each gets its own Take Down with the
same New Dry UID. Everything treats them as one package — `takeDownGroups`
/ `combineTakeDowns` in `ops_common.js` add the dry weights up (each farm
package counted once, its newest Take Down), for the queue, the Bucking
dropdown and a typed UID — and `buildAliasMap` in `ops_analytics.js` makes
them one lot under the dry UID (each farm UID points at it), so wet, dry
and bucked weights add up on the dashboard. Each Take Down is still held
or released on its own (one On hold card each); the package's starting
weight counts only the released ones.

**Bucking queue.** On-Stem Flower lists what's ready to buck
(`loadBuckingQueue` in `ops_data.js`) in the order a manager sets with ▲ ▼
/ Top. The order is one shared `operations_forms` row (`station_key:
'buck_queue'`, fixed id `BUCK_QUEUE_ID`, `fields.order` = UIDs), like the
trim cost split; `orderBuckQueue` in `ops_common.js` puts anything not in
it last, oldest Take Down first, and a package drops off once its Bucking
record is submitted. A package open on a bucking page shows "being
bucked". Each row shows the **starting weight** (`unbuckedLb`), the pounds
**pulled** so far (the boxes logged on its open bucking page — `withPulled`
in `ops_data.js`) and what's **remaining**. The Bucking form's **Queue** tab
(station `queueTab`) shows the same list — number, strain, UID, starting weight,
pulled and remaining (this page's own boxes live, as typed) — with **Start →** (a
new page with that UID, `?set_sourceUid=`) or **Open →** (the page it's
on), and the package dropdown lists in the same order.

The page has four running logs — `lineitems` with `entry: true`: an entry
bar (the row's boxes plus Add; Enter moves to the next box and adds once
they're filled), and the rows logged so far underneath, newest first:
- `boxes` — each box taken off the dry unbucked weight: lbs, with Box #
  filled in by itself (a `rownum` column: 1, 2, 3… in the order logged,
  renumbered when one is removed). Totals to `startingDryLb`, and "Dry Unbucked Left" is
  the Take Down weight minus that.
- `bucked` — bucked flower by person: `who` is the employee #, or a name for
  someone without one, and lbs. Totals to `buckedFlowerLb`.
- `recovered` — **Recovered from Leaf**: bucked flower sifted back out of
  the leaf, lbs, one row per weigh, nobody's. `buckedFlowerLb` is `bucked`
  plus `recovered` (`buckedLb` in `operations_stations.js`, also used for
  an open page's bucked-so-far in `buckedLots`), so yield, Hand Trim's
  starting weight and the dashboards count it; People on this Batch and the
  by-person labor (`crewLaborLog`) don't. The daily summary shows it as a
  row of its own under the people (`dailySummary.extra`), on the form, the
  Today board, its image and the emailed report's bucking pounds.
- `trim` — trim weighed during the batch, lbs. Totals to `trimLb`.
- `stems` — stems ("Palo" in Spanish, required) weighed at close-out, lbs,
  one row per bin or bag. Totals to `stemLb`. Pages saved when stems was a
  single number open with that number as the log's first row
  (`legacyTotal: 'stemLb'`, fixed `_id` `legacy-stems` so two tablets don't
  both add it).

Then at close-out the stems log, mold (`moldLb`) and floor waste
(`floorWasteLb`), with a **Calculate** button (a `fill` field): with two of
the three weighed (stems counts as weighed once it has a row), it fills in
the third as Total Boxes Taken minus everything else that came out (bucked
+ trim + the other two), so the loss comes to zero. Worked out for stems,
it's added to the log as one row. Then the summary: total out
(bucked + trim + stems + mold + floor waste), loss in lbs and %, and
bucked yield %. Mold and floor waste count as `waste` in the flow. Submit closes the batch. The record keeps the old field
names, so Machine Trim's prefill (`buckedFlowerLb`), the yield calc and the
dashboard read it as before. Bucking doesn't mint a UID: the record stays
under the on-stem tag, and that's what Machine Trim looks up.

Each logged row carries `_id`, `day`, `at` and `by`. That's what lets
several tablets work one page: before every autosave, every 15 seconds,
and before Submit, the page reads the saved copy and merges in rows another
tablet added (and drops rows it removed, kept in `_deleted`). Plain fields
(strain, stems, …) this tablet hasn't changed since its last save take the
saved value. If another tablet already submitted the page, this one locks
instead of turning the record back into a draft.

The daily summary under the form (`dailySummary` with `dateCol: 'day'`,
`unit: 'lb'`) is person × flavor for one day, in lbs, counting only rows
weighed that day — so a three-day batch shows up on each of its days.
Every daily summary (Bucking, Hand Trim, Smalls) has a Name column beside
the employee #, from the admin panel's Labor Rates → Badge #
(`netlify/functions/badge-names.js`). It's blank for a badge nobody has
mapped, and for Bucking rows logged by name.
The same table is on the Today board (`operations_today.html`) when one of
those stations is picked, above its forms, for the day being looked at
(`dailySummaryGrid` in `ops_common.js` builds it for both). **💬 Send as
image** there draws it as a picture to text, like the Master Schedule's
(`makeDaySumImage`, on a white canvas: title and date, Emp # and name,
each flavor with its UID's last 4, each person's total, the totals row),
then shows it with Share / text, Download and Close.
Bucking's by-person rows also feed `crewLaborLog` (a touch, no hours; hours
come from the Labor Log).

Older records: the paper-form imports in `data/operations/buck.json` have
big leaf, waste and A+/A/B trim. Those fields are off the form but still in
the station's `flow`, so those records still balance. The earlier
four-tab Bucking page (`buck_station.html`, `buck_data.js`, station keys
`buck_submission` / `buck_box` / `buck_batch_close`) was removed on
2026-10-13; it had no live rows. Its On hold list moved to `buck_hold.html`.

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
  `labor_log.html?project=<id>`) and **Labor entries**. A card with hours
  logged but no UIDs shows **Hours waiting on UIDs**: those hours sit in
  the project's pool until UIDs are added, then split over them.
  - **Worked that day** (under the UID box) lists the packages on station
    forms on the days the project ran, for its processes (the project's
    and its responsibilities'; "Show every process" drops that filter).
    Finished and in-progress forms both count, including open pages
    touched in the range. Each package can be ticked on or off, or **Add all**.
    It offers each form's *input* package (Take Down: the farm UID), which
    exists as soon as work starts. New tags made later trace back to it:
    bucked (`newBuckedUid`), Hand Trim's per-output tags (`metrcTags`) and
    Smalls' finished smalls (`newFinishedUid`), pre-rolls and their waste (`newPrerollUid`,
    `newWasteUid`), all in `buildAliasMap` (`ops_analytics.js`). So labor
    on the input follows the lot. A typed placeholder with no digits
    ("PENDIENTE") isn't shown as a new tag. Open-ended projects look back
    at most 31 days.
  - **Copy N UIDs from …** copies the UIDs of the latest earlier project
    at the same location with the same name, dates aside ("Trimming 10/14"
    → "Trimming 10/15"), else the same process.
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
- **⇪ Import day plan** (Projects tab) turns the crew lead's day plan
  spreadsheet into that day's projects. The sheet is
  `templates/Plan_Proyectos_Template.xlsx` (blank copy linked from the
  import screen; `scripts/make_day_plan_template.py` rebuilds it, e.g. when
  the Connecteam roster changes, since its name dropdown is a copy). The
  **Plan del Día** tab has one 2-column block per project (up to 10): name, site,
  start | end, lead, two contractor rows (name | how many, start | end),
  notes, then a row per person with **Responsabilidad | Nombre**. A blank
  responsibility is the one above; text in parentheses is a note ("Jorge
  Rojas (sale 5am)"), or a responsibility's own hours ("Colgar
  (5:30pm-2am)"). Upload the .xlsx (SheetJS, loaded from jsdelivr like
  `menu.html`) or paste the tab's cells from Google Sheets.
  - `day_plan.js` (global `DayPlan`; tests in `scripts/test_day_plan.js`)
    reads it: rows are found by their column A labels and blocks by the
    "Responsabilidad | Nombre" header row, so the template's hidden helper
    columns are ignored. Each block becomes one project for the plan's date
    ("Bucking" → "Bucking 10/19", one day, Active; overnight hours end the
    next morning). Responsibilities get their Labor Log process from the
    file's Listas tab (else `ROLE_PROCESS`), and the project gets the one
    station process they share, if any. The same contractor on both rows
    is one contractor with two times. Notes in parentheses go in the
    project's notes.
  - Names are matched to the Connecteam roster (`matchPerson`): exact
    (accents, case, spacing aside), or close (one roster name has every
    typed word, allowing a slip or a shortened word: "Dalet Castro" →
    Dalett Castro, "Juan Parra" → Juan J. Parra). The preview lists every
    name that isn't exact: a close match is used unless changed, several
    possibles (or two people with one name) must be picked, and one not on
    the roster is kept as typed (no Connecteam id) or left out.
  - Projects already saved for that date (same name and location) start
    unticked. Nothing is written until **Create**, which inserts one
    `work_project` row per ticked block and opens that day's Schedule.
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
  [personKey], extra: [{roleId, userId, name}], flc: {shiftId: count},
  here: [personKey], times: {personKey: [{start, end}]} } }, createdBy,
  updatedBy }`. There's no SQL. `here` and `times` come from Crew Check-In
  (below); Change this day's save keeps them.
- Every save re-reads the row and writes only if `updated_at` hasn't
  changed since, retrying on top of the newer version. That way two leads
  editing different days don't undo each other. Remove sets
  `fields.voided`.

### Crew Check-In

`crew_checkin.html` (hub card `crew_checkin`, in the Workforce folder) is for
team leads, so people don't have to be named on every station form — a day
of Wet Intakes is a lot of forms. The lead checks the crew in once a shift,
and the Labor Log puts the time on the right project, and from there on
the project's UIDs (the forms' Project dropdown puts their packages there).
There's no checkbox of its own: anyone with Master Schedule or Labor Log
gets it (derived in `index.html`, listed in `DERIVED_CARD_KEYS` in
`admin.html`).

- It lists the projects running that day (`projectRunsOn`, not marked as
  not working), with that day's changes applied. **My projects** are the
  ones whose Project lead is the logged-in user (by name), and they're
  shown first; **All** shows every project. The choice is remembered per
  device. ‹ › and the date pick another day.
- Each person on a project (its lead, each responsibility's people, that
  day's extras) gets **Here** / **Not here**. **✓ Everyone else is here**
  marks the rest. **+ Add someone** puts anyone else on the project for
  the day, from the Connecteam roster (people clocked in first) or typed
  in, under a responsibility. Extras get × instead of Not here. A green dot
  means clocked in now. A banner lists anyone clocked in who isn't on any
  of the day's projects.
- **⇄ Move** is for someone who works one station part of the day and
  another the rest of it. Pick the project and responsibility they go to
  and the time (now, rounded to 5 minutes, on today's date). Their time
  on this project stops then. They're added to the other one (an extra,
  unless they're already on it) from then to the end of its shift. **Went
  home / left for the day** stops their time on every project they're on.
  Their row then shows their hours there and where they went or came from
  ("7:00 AM–11:30 AM → Take Down at 11:30 AM"). **↺** (Full shift) takes
  their own hours on that project back off. To undo a move, use ↺ on the
  first project and × on the second.
- **From the Labor Log**: time already logged to a project (Labor Log
  entries with `project`) counts as a check-in. When a day has some for
  people who aren't checked in there, a banner offers **Check them in**
  (`laborPlan` / `fromLabor`). It marks each of them Here on the project
  they logged to, adding them under the entry's responsibility (else the
  project's first) when they aren't on it. Someone logged to two or more
  projects that day also gets their own hours on each, from their entries'
  times, unless a lead already gave them times there. Entries on a project
  that isn't running that day (Done, or outside its dates) are left out,
  as is a project with no lead and no responsibilities to put people under.
- Everything is saved on the project's day in the Master Schedule
  (`overrides[date]`, through `patchWorkProject` in `ops_data.js`, which
  re-reads and retries so two leads don't overwrite each other):
  - `here` — who's checked in.
  - `out` — Not here, the same as Change this day.
  - `extra` — people added for the day.
  - `times` — `{personKey: [{start, end}]}`, a person's own hours there
    that day ('HH:MM', blank = the responsibility's; an end at or before the
    start runs past midnight). `[]` means they were moved off before it
    started.
  - The page re-reads the projects every minute and whenever it comes
    back on screen.
- `personSpans(f, role, date, key)` in `operations_stations.js` turns
  those times into a person's hours on a project (minutes, past 1440 for
  overnight shifts — `shiftMin`). Without times of their own, it's the
  responsibility's hours. Everything that reads people's hours off the
  schedule goes through it:
  - **Master Schedule**: the day card (✓ for checked in, their own hours
    in gold), the week table, the timeline (a bar per stretch), the CSV
    (a line per stretch), the image, and double-booking. Someone moved
    from one project to the other isn't double-booked.
  - **Labor Log**: the Timeline's right-click shows a person's own hours,
    and **Auto-assign scheduled** splits a not-logged stretch at the move
    time. Then 7:00–3:30 clocked at Adobe, moved at 11:30, logs 7:00–11:30
    to the first project and 11:30–3:30 to the second. It only splits at
    the move times, not at a shift's usual start and end.
- **Hourly auto-assign for checked-in people.** After the Connecteam
  Hourly Sync pushes the clock-ins, its last step runs
  `scripts/labor_autoassign.js` (Node, `TZ=America/Los_Angeles`, the
  `SUPABASE_SERVICE_ROLE_KEY` secret; `continue-on-error`, so it never
  holds up the sync). For today and yesterday, it logs each stretch of
  clocked time no entry covers, the same way the Labor Log's **Auto-assign
  scheduled** button does, with two limits:
  - only projects the person is checked in on that day (`here`);
  - only shifts they've clocked out of, so a Move recorded later in the
    day still splits their time.

  Entries are ordinary `labor_entry` rows with `enteredBy: 'Auto-assign
  (Crew Check-In)'`, shown and removable in the Labor Log like any other.
  A second run finds nothing new, because the time is already logged.
  `DRY_RUN=1` prints the plan without writing. The button and the script
  share their logic in `labor_auto.js` (`laborDayRows`, `scheduledAround`,
  `moveCuts`, `autoPlan`, `projectEntry`): the button takes everyone
  scheduled, the script only people checked in.
- The Pre-Roll form's Crew check still keeps its own marks per run (and
  writes `out` / `extra` here as before). It doesn't read Crew Check-In's
  `here` yet.

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
  at once. People added in the admin panel's Labor Rates → **+ Add person**
  (not in Connecteam, ids X1, X2, …; `docs/USER_ADMIN.md`) are listed too,
  from `netlify/functions/badge-names.js`, and get their own rate. Anyone
  else not in Connecteam can be typed in and saved with no id. Until the roster file has been written once, the page uses the names from
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
  - **Project on the station forms.** Wet Intake, Take Down, Bucking,
    Hand Trim and Pre-Roll Production have a **Project (Master
    Schedule)** dropdown under the date (`F.project()`, `projectPicker`;
    `wireProjectPicker` in `ops_form.html`). It lists open projects
    (not Done), the ones running on the form's date first and, within
    that, the ones for this station's process. Picking one puts the
    form's package(s) on the project's UIDs (`linkFormToProject` in
    `ops_data.js`), so Labor Log hours logged to the project split onto
    them as above — the labor cost comes from the Labor Log, not the
    form. The package is the form's input, as in "Worked that day"
    (`formProjectUids`): Wet Intake's row UIDs, Take Down's intake UID,
    everyone else's `sourceUid`.
    - The link is made on each autosave whose project or packages
      changed, and again on submit (or a correction's save). UIDs it adds
      carry `form` (the form's id) and `station`; changing the project,
      or the UID, takes them back off, and so does Delete this page. A
      UID already on the project some other way is left alone.
    - The form stores `project` (the id), `projectName`, and
      `projectLinked` (the project that has its packages now, so a
      resumed page or another tablet can move them).
    - **A project per day** on forms with day tabs (Pre-Roll, Hand
      Trim, Bucking): the dropdown is the picked day's project, so a run worked
      10/15 on one project and 10/16 on another keeps both. Picks are in
      `projectDays` (`{day: id}`, `''` for none); a day with no pick of
      its own goes by the last earlier day that has one, else by
      `project` (the latest pick, and all a run from before this had).
      Picking on one day never changes another day's: the next day tab
      and the first one get their own entry when they were going by it
      (`setDayProject`). The packages are linked to every project the
      run is on (`projectsLinked`), the crew check reads each day's
      project, and `preroll-costs.js` counts the Labor Log hours of all
      of them. `projectName` lists their names. Editing a submitted
      record (no day tabs) sets one project for the whole run.
    - Master Schedule's editor keeps UIDs a form added while it was open
      (it merges them in on save); hovering a UID chip says which station
      linked it. Removing one there only lasts until that form saves its
      link again (its next change, or submit) — to take a package off,
      change the form's Project.
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
    browser supports that) opens a menu of every Master Schedule project
    on that day, whatever its hours or status (done projects and skipped
    days included; voided ones aren't). The person's own responsibilities
    come first ("✓ Trimmers"), then other projects, those whose hours
    overlap the stretch ahead of the rest. Picking one
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

Each shift also carries **what they said they did** (`activity`): the
Connecteam sub-job if they punched into one (jobs are mapped as
"Site › Task", the site goes in `job`, the task leads `activity`), then
their answers to the time clock's clock-in/out questions (the shift's
`shiftAttachments`, with drop-down picks named from
`/time-clock/v1/time-clocks/{id}/shift-attachments`). Free text, numbers and
drop-down picks are kept, up to 120 characters. Photos, files, signatures and
locations are left out. Each hatched stretch is labeled with its shift's
place and activity, and the tooltips show both. Tapping a stretch also
picks the process when the activity names one ("Bucking").

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
  **÷ 454** — the floor divides, and so does the app (454 g per lb, the
  industry figure, `G_PER_LB` in `operations_stations.js`) — but it's on
  Version 4 of a printed form and worth correcting at the source.
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
row). `check` fields that share a `group` (Hand Trim's Machine / Hand) sit
side by side and are pick-one: checking one clears the others. `headline`
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
