# 2CW Production App

Replaces the hand-written station paperwork (and the retyping that follows it)
with tablet forms that total themselves, plus a dashboard that reads the same
records. It is built into the existing Operations Hub — same login, same
Netlify deploy, same JSON-in-the-repo storage as the field forms.

## What's here

| File | What it is |
|---|---|
| `production.html` | Station picker, grouped by department |
| `prod_form.html` | The form for every station, rendered from the schema |
| `production_dashboard.html` | Pipeline, yields, biomass, labor, requests, exceptions |
| `production_stations.js` | **The schema.** Station and field definitions, EN + ES |
| `prod_common.js` | Language, data loading, offline queue, submit |
| `prod_analytics.js` | Lot tracking, yields, biomass ledger, labor, exceptions |
| `netlify/functions/submit-production.js` | Commits submissions to `data/production/` |
| `data/production/reference.json` | Farms, strains, dry rooms, machines, brands |
| `data/production/<station>.json` | One append-only file per station |
| `scripts/test_prod_analytics.js` | `node scripts/test_prod_analytics.js` |
| `scripts/seed_demo_production.js` | Demo data for the dashboard; `--clear` to empty |

## Stations

**Harvest** — Harvest · Fresh Frozen
**Drying** — Intake-Wet · Post-Dry Check
**Processing** — Bucking · Machine Trim · Hand Trim / Hand Touch
**Manufacturing** — Biomass Request · Manufacturing Run

Each stage pulls its input weight forward from the stage before it: type the
last 4 of the Metrc tag and bucking fills in the dry weight the post-dry check
recorded. Every stage totals its own outputs and shows the variance against
what went in, live, while the operator is still standing at the scale.

## Things the forms do that the paper doesn't

- **Totals itself.** The hand-trim work order adds up every trimmer's grams,
  converts to pounds, and shows the variance against the starting bucked weight
  before anyone signs it.
- **Bilingual.** EN/ES toggle in the header, translation stored next to each
  field so a label and its translation cannot drift apart.
- **Works offline.** Submissions queue on the tablet when there is no signal and
  send themselves when it comes back. The dry rooms and the farms were the
  reason for this.
- **Flags what's off.** A weight that doesn't reconcile, an intake more than 2%
  off the farm's number, or a request nobody has actioned lands on the
  Exceptions tab instead of being discovered a month later in a spreadsheet.
- **Keeps one lot identity.** Bucking issues a new Metrc tag; the app follows
  the link so the lot stays one row from farm to finished flower.

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

2. **Add the access columns to the directory sheet.**
   - `production` — `TRUE` opens the station hub.
   - `production dashboard` — `TRUE` opens the dashboard.
   - `production stations` *(optional)* — a comma-separated list to restrict
     someone to their own stations, e.g. `buck,machine_trim,hand_trim`. Blank
     or `all` means every station, which is what a plant manager wants.

3. **Clear the demo data** if you seeded any:
   `node scripts/seed_demo_production.js --clear`

4. `GITHUB_TOKEN` is already set in Netlify for the field forms; the production
   function uses the same one. Nothing new to configure.

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
`lineitems` (the repeating grid the weighing worksheet uses).

To make a new station appear, add an entry to `PROD_STATIONS`, add its key to
`KNOWN_STATIONS` in `netlify/functions/submit-production.js`, and create an
empty `data/production/<key>.json` containing `[]`.

Run `node scripts/test_prod_analytics.js` after touching `prod_analytics.js` or
any station's `flow` block.

## Not built yet

Deliberately out of this pass, roughly in the order I'd add them:

- **Metrc API integration.** Right now tags are typed in. Metrc's API could pull
  package weights and strains directly and push package adjustments back, which
  would remove most of the typing and all of the transcription risk.
- **Barcode / tag scanning.** The UID fields accept the last 4 by hand; a camera
  scan on the tablet would be faster and eliminate mis-keys.
- **Edit and void.** Records are append-only. A wrong entry currently needs a
  correcting entry, not a fix. A supervisor-only edit path is the next thing
  the floor will ask for.
- **Bulk biomass sales.** Sales to outside distributors and manufacturers aren't
  modelled yet, so biomass that leaves that way will sit on the ledger as
  on-hand.
- **Storage locations.** The ledger tracks *processing* vs *manufacturing*, not
  which room or rack. Fine for reconciliation, not enough for a physical count.
- **A real backend.** See below.

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

One security note while we're here: the current PIN directory is a Google Sheet
published to the web, which means anyone with that URL can read every user's
PIN. It's fine for a dashboard behind an unguessable link; it is not something
to build production authority on top of. Whichever SSO route you pick, moving
the directory out of a published sheet should go with it.

### About the storage model

Submissions are committed to JSON files in this repo. That is genuinely fine at
your volume — a few hundred records a week, and it gives you free version
history of every correction. Two limits to know about before you outgrow it:
concurrent submissions from several stations serialise through one GitHub file
write (handled, with retries, but it's a real ceiling), and there's no way to
edit or query without rewriting a whole file. When either starts to hurt — or
when you want Metrc sync and edit history — the move is a real database
(Supabase or Postgres) behind the same forms. The station schema and the
analytics would carry over unchanged; only `prod_common.js` and the Netlify
function would need rewriting.
