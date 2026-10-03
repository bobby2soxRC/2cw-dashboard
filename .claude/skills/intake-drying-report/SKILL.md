---
name: intake-drying-report
description: Report on wet harvest intakes and the drying rooms from live 2CW Supabase data — what came in from which farms (by strain and room) over a date range, what is in each drying room now and for how long, and room/facility capacity. Use when asked about intakes, what came in from a farm, drying room contents, how full the rooms are, days in the drying room, or for the "Intake & Drying report". Arguments like "today", "past 2 days", "since Oct 1", or a farm/room/strain to focus on.
---

# Intake & Drying report

Produce the Intake & Drying report from **live Supabase data** with
`scripts/intake_drying_report.js`. It uses the same builder as the 7 pm email
(`netlify/lib/intake_drying_report.js`), so the numbers match the email exactly.
Don't recompute the totals yourself from raw rows. If you need a different
cut, use `--format json` and work from those numbers.

## Run it

```bash
node scripts/intake_drying_report.js                 # intakes received today + drying rooms now
node scripts/intake_drying_report.js --days 2        # yesterday + today
node scripts/intake_drying_report.js --from 2026-10-01 --to 2026-10-03
node scripts/intake_drying_report.js --format json   # every number, for follow-up questions
node scripts/intake_drying_report.js --format html --out <scratchpad>/report.html   # email-style page
```

Turn the user's words into the range. "Today" means the California business
day. "Past 2 days" or "so far" means `--days 2`, which is yesterday plus
today. The drying-room section is always as of now, whatever the range.

It's read-only and uses the public anon key from `config/supabase_config.js`.
No secrets are needed, and nothing is ever written.

## If it can't connect

When the error mentions fetch failed, 403, or a CONNECT tunnel, the cloud
environment's network isn't allowing the Supabase host
(`ugtxmyciyuelxxzqmrdx.supabase.co`). Tell the user to add it under
Network access → Allowed domains in the environment settings (see
docs/REPORTS.md). Don't swap in Canix data instead: Canix is Metrc data and
often lacks the strain names that the intake forms have. Say what you
couldn't get rather than producing a partial report.

## Present it

- Show the markdown output in the chat. Lead with the headline: total lb
  received, the farms, and the facility's % full. Then give the tables. Keep
  the script's numbers and wording; don't round differently.
- Call out what needs attention:
  - rooms at or over 85% full, or over capacity;
  - the oldest packages in each room (days in room);
  - intakes still being entered, which count as entered so far;
  - weight logged to a room that isn't on the room list.
- If the user narrows the request to one farm, room or strain, filter the
  JSON output and say what you filtered.
- If they want something to share, write the HTML version to the scratchpad
  and publish or send it. Emailing it to the recipient list is done from the
  admin panel (Reports tab → Send now), not from here.

## What the numbers mean

- **Net lb** is each weigh-in row's scale weight minus `binCount × tareEachLb`.
  This matches the form's Total Wet Weight. Farm (`pid` → `ref_codes` name)
  and drying room are recorded once per intake; strain is per row.
- **In a room**: from the intake's date until a submitted Take Down — Dry
  (`dry_check`) form has an `incomingUid` that matches the intake's farm UID.
  Crews often write only the last 4–5 characters, so UIDs match when one ends
  with the other. A package also leaves its room once someone marks it taken
  down in the admin panel (`fields.takenDownAt`).
- **Days in room** count from the intake's `work_date`.
- **Capacity** comes from `data/operations/reference.json` →
  `dryRooms[].capacityLb`, a hoops-based estimate. Rooms 2A–2D are
  provisional: Room 2's 28,140 lb split evenly. Point that out if 2A–2D
  matter to the answer.
- **In progress** means a Wet Intake still being entered (draft). It's
  included as entered so far.

Background: docs/REPORTS.md, plus docs/OPERATIONS_APP.md (Harvest Intakes,
station forms).
