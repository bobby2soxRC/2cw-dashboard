# California cannabis regulations — what applies to this app

Compiled 2026-10-13 as a working reference for building features. **This isn't
legal advice.** Before anything goes on a form or label, check the exact wording
in the official text: DCC's compiled *Medicinal & Adult-Use Cannabis
Regulations*, July 2026 edition, at
`cdn.cannabis.ca.gov/wp-content/uploads/sites/2/2026/08/dcc_regulations_20260701.pdf`.

That PDF couldn't be downloaded from the build environment because the network
policy blocks cannabis.ca.gov. Everything below comes from search results that
quote DCC, CDTFA, Metrc and Cornell LII pages, plus the structure of the
regulations as they stood through 2025. How solid each item is:

- ✅ **confirmed** — confirmed against an official or quoted source this pass
- ⚠️ **verify** — widely cited or remembered, but the current text wasn't seen
- 🕒 **pending** — proposed rulemaking, not in effect

## Who we are, in regulatory terms

Inferred from `config/canix_facility_config.json` and `data/canix_facilities.json`:

| License | Type | Where |
|---|---|---|
| CCL21/22/23/25/26-… (≈14) | Cultivation, mostly outdoor (some Large, some Medium) | Lake County (Bartlett Springs Rd, Grange Rd, …) |
| C11-0001652-LIC | Commercial – Distributor | Sonoma County |

What the app tracks: harvest → wet intake → drying → take down → bucking → machine and
hand trim → smalls, plus fresh frozen, pre-roll production, biomass transfers,
drying for **outside client farms**, sales to retailers, trade samples (field
forms) and commissions.

**Open question, to settle with compliance and counsel before building anything
here:** which license premises does drying, trimming and pre-rolling run under?
Processing and pre-rolling are allowed under a cultivation license (on its own
premises), a Processor license, or a distributor license (distributors may
package, label and prepare pre-rolls; §15303 ⚠️). Doing post-harvest work *for
other farms' material* depends on the license held where it happens. The answer
decides which rules below apply to the Processing stations.

## Rules that touch the app, by topic

### Track and trace (Metrc)
- ✅ §15049.1 (as amended by DCC-2025-01-R, effective 2026-07-01): for each
  harvest batch, record its **wet weight** and the **weight of cannabis waste**
  in track and trace. Cultivation activities must be recorded **within 3
  calendar days**.
- ⚠️ §15049: all other commercial activity (packages created, adjustments,
  transfers, destruction) must be in Metrc **within 24 hours**. Several law
  firms cite this; the regulation text wasn't seen this pass.
- ⚠️ §15051 (track-and-trace reconciliation): physical inventory must match
  Metrc, and discrepancies must be investigated and reported. The required
  frequency wasn't confirmed.
- 🕒 **DCC-2026-03-R, group tagging**: one group tag per plant group instead of a
  tag on every mature plant. The supplemental comment period closed
  2026-10-02. This would change how Harvest rows map plant counts to tags.
- 🕒 **DCC-2026-02-R, track-and-trace updates**: all parties must approve a
  transfer before Metrc generates the manifest. A distributor may use only
  **one lab and one sample per batch** (against "lab shopping"), with new
  sampling records. Retailers must enter tax information and provide COAs on
  request. Comments closed 2026-07-20; not adopted yet.

### Waste
- ✅ §17223: keep a cannabis waste management plan. Waste must go to approved
  haulers and facilities. §16309 ties the plan to the cultivation plan.
- ✅ Waste weight per harvest batch goes into Metrc (see §15049.1 above).
- What this means for the app: **mold, floor waste, stems and trim waste are
  regulated waste**, not just yield-loss numbers.

### Sanitation (new: DCC-2025-01-R, operative 2026-07-01) ✅
- Minimum sanitation standards apply to any licensee that processes harvested
  cannabis, makes nonmanufactured products (pre-rolls), packages, or handles
  **unpackaged** cannabis. That covers drying rooms, bucking, trim and pre-roll.
- ⚠️ Draft text listed approved sanitizers and strengths, for example chlorine
  100 ppm for 30 seconds or more, quaternary ammonium 200 ppm, and 70%
  isopropyl alcohol. Check these against the adopted text before putting them
  on a form.
- The same package dropped some redundant reporting duties for cultivators,
  such as submitting a pest management plan with the application.

### Testing, COAs and batches
- ✅ The distributor must physically hold the **entire** batch before arranging
  testing. Only flower may be sampled in bulk; everything else is sampled in
  final form (§§15305, 15707, 15708).
- ✅ §15708: a pre-roll or product batch may hold **no more than 150,000
  units** for a representative sample.
- ⚠️ Harvest-batch sampling scales with batch weight (the §15707 table). Many
  sources cap a flower harvest batch at **50 lb** per test sample. Confirm
  against the table.
- ⚠️ §15307: the distributor's quality-assurance review (label matches COA,
  weight, packaging) comes before transfer to a retailer. DCC-2026-02-R
  amends this section.
- 🕒 DCC-2025-03-R: revised **pesticide action levels**. Comments closed
  2026-03-04.

### Scales and weights
- ⚠️ Any scale used to weigh cannabis for commerce must be **type-approved
  (CTEP), registered with the county sealer, and sealed**. That's Bus. & Prof.
  Code Div. 5 plus the DCC regs. Bulk shipments need a **weighmaster**
  certificate (§17221). The license is renewed every year.

### Trade samples ✅ (§§15041.2, 15041.7; DCC FAQ)
- Cultivators, distributors, manufacturers and microbusinesses may send them.
  They can't go to event organizers, transport-only distributors or labs.
- **Sender caps, per calendar month**: 2 lb of dried flower in total, and 900
  units of products, manufactured or not.
- **Recipient caps, per month**: up to 5 g per strain, at most 6 strains; up to
  5 units per product line, at most 6 product lines.
- Label: **"TRADE SAMPLE. NOT FOR RESALE OR DONATION."** Samples must be
  designated in Metrc. Sources disagree on whether they must be in final form.
- Exempt from the cannabis excise tax.

### Transport
- ⚠️ A manifest is generated in Metrc before the vehicle leaves, and the load is
  checked against it. Vehicles must be alarmed, with product locked in a
  secured box or cage. Only licensed staff aged 21+, taking a direct route
  between licensed premises (§§15311–15315).
- Harvest and Wet Intake already capture the manifest number, a manifest photo,
  the license plate and the driver's ID. That's good.

### Records
- ✅ §15037: keep every required record for **at least 7 years**, in a form DCC
  can get on request. That includes training, personnel and contract records.

### Taxes
- ✅ Cannabis excise tax is **15%** from 2025-10-01 to 2028-06-30 (AB 564).
  Starting FY 2028-29, CDTFA reviews it every two years, capped at 19%. The
  cultivation tax was repealed 2022-07-01 (AB 195).
- ⚠️ Since 2023-01-01, **retailers** collect and remit the excise tax.
  Distributors no longer do.

### Customer and partner licenses
- You can only transact with active licensees (Bus. & Prof. Code §26053, and
  the §15000 series in general). Before any transfer, check that the other
  party's license is **active and of the right type**. That includes client
  farms we dry for, Harvest Intake sources and retailer customers.
- ✅ DCC-2026-03-E (emergency, 2026-06-04 to 2026-12-02): A/M **retail** licenses
  may split into separate A and M licenses. Retail customers may end up with a
  new or second license record, so CID → license mappings can go stale.

## Recommendations for the app

Ordered by compliance risk divided by effort. File references are where the
change would start.

### High: add soon

1. **"Recorded in Metrc" on every station that changes Metrc.** Take Down and
   Wet Intake already have `metrcAdjusted`. Add the same field, plus a
   timestamp, to Bucking (waste and adjustments), Machine Trim, Hand Trim,
   Smalls, Pre-Roll (new UIDs, waste UID) and Fresh Frozen. Then add an
   `exceptions()` rule in `ops_analytics.js:749`: *submitted, and Metrc not
   recorded after 24 h* (make the window configurable; 3 days for cultivation
   events).
2. **Waste ledger and Metrc waste alert.** Every pound of mold, floor waste,
   stems or `wasteLb` is regulated waste. Build a waste view per harvest batch
   and per UID, using the `waste` category flows that already exist, and
   compare it to what was reported in Metrc. Alert on harvest batches that
   have waste in the app but no Metrc waste entry. Also record who hauled it,
   where it went, and the manifest or receipt, to support the §17223 plan.
3. **Sanitation / cleaning log station** (new under Processing, in
   `operations_stations.js`). Fields: room or equipment (dry rooms, Mobius,
   trim tables, pre-roll machines), task, sanitizer and concentration, contact
   time, who, and a photo. Alert when an active room or machine has no log
   entry within its set interval. This rule took effect 2026-07-01, so it's
   already enforceable.
4. **Partner license checks.** Information Hub → Farm Licenses and Customer
   documents already store license expiry dates. Add:
   - expiry alerts at 60, 30 and 0 days, on the hub and the Exceptions tab;
   - a warning on Wet Intake, Harvest, Drying Schedule and Biomass/sales flows
     when the farm license or CID is expired or has no license on file;
   - an "A/M split" note on retail CIDs until 2026-12-02.
5. **Trade sample limit tracker** (`form_staff_sample.html`). Today it asks for
   a free-text product and "how many". Capture strain or product line, grams or
   units, and the recipient license. Total by calendar month, both against our
   own cap (2 lb flower / 900 units) and per recipient (5 g × 6 strains; 5 units
   × 6 products). Warn at 80% and block at 100%. Show the required label text.

### Medium

6. **Scale ID on weigh-ins.** Add a `scale` reference list in
   `reference.json` (device, serial, county registration number, seal date)
   and a scale drop-down on each worksheet that's weighed. Alert when a
   scale's annual registration or the weighmaster license is about to lapse.
7. **Testing guardrails** on Canix inventory (`canix_inventory.html`, data has
   `test_results`, `is_testing_package`):
   - flag "Available To Sell" packages with no passing COA;
   - flag a source batch with more than one testing package or lab, ahead of
     DCC-2026-02-R;
   - flag harvest batches heavier than the sampling limit (50 lb ⚠️) on Take
     Down or Bucking, before they're sent for testing;
   - Pre-Roll Production: warn when units go over 150,000 in a batch.
8. **Real cultivation stations.** Replace the placeholders. The IPM / Feed Log
   should capture product, EPA/CA registration number, rate, area, applicator,
   REI and pre-harvest interval. Then alert on Harvest when a block was sprayed
   within the PHI. This also covers county pesticide-use reporting, and it
   matters more once the new pesticide action levels land.
9. **7-year retention guarantee.** Write down, and enforce in
   `supabase/schema.sql`, that `operations_forms_history`, deleted-record copies,
   photos and customer documents are never purged before 7 years. Check that
   the GitHub-hosted photos and the Supabase plan's backups actually hold that
   long.

### Watch list (pending rules; build when adopted)

10. **DCC-2026-02-R**: when transfers need approval from all parties before the
    manifest, add lead time to the Biomass Request and sales scheduling.
    Track "approved by receiver" as a status. One lab per batch, as in 7 above.
11. **DCC-2026-03-R group tagging**: the Harvest worksheet's
    UID-to-plant-count rows may become group tags. Keep plant count per row
    either way.
12. **DCC-2026-01-R multipacks** and any label changes: matter for packout and
    the pre-roll SKUs, not the processing stations.

### Not regulatory, but found along the way
- `app_users` is anon-readable (PINs, emails, phones). DCC requires reasonable
  security of records (§15037). The Google sign-in work already planned in
  `CLAUDE.md` fixes this.
