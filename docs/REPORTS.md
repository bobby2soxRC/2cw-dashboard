# Emailed reports

## Intake & Drying report

Covers what came in by farm (with strain and room), what's in each drying room
right now and for how long, and how full each room and the facility are. It's
emailed every evening at **7 pm Pacific** to the recipient list. You can also
send it any time from the admin panel, either to the whole list or to one address.

| Piece | File |
|---|---|
| Report builder (data, numbers, email HTML/text, markdown) | `netlify/lib/intake_drying_report.js` |
| Sending, recipient list, send log | `netlify/lib/report_mail.js` |
| 7 pm scheduled email | `netlify/functions/intake-drying-report-daily.js` + `netlify.toml` |
| Admin panel → **Reports** tab (recipients, preview, send now, drying-room fixes) | `admin.html`, actions in `netlify/functions/admin.js` |
| Claude skill `/intake-drying-report` | `.claude/skills/intake-drying-report/SKILL.md`, `scripts/intake_drying_report.js` |
| Room capacities | `data/operations/reference.json` → `dryRooms[].capacityLb` |
| Tables | `report_recipients`, `report_runs` in `supabase/schema.sql` |

Everything goes through the one builder, so the email, the preview and the
skill always agree.

### How the numbers work

- **Received:** Harvest Intake — Wet forms (`intake_wet`) whose `work_date`
  falls in the range. Net lb comes from each weigh-in row: weight − bins ×
  tare each (the form's Total Wet Weight). Farm and room are per intake;
  strain is per row. Intakes still being entered (drafts) count as entered
  so far and are flagged.
- **In a room:** an intake is in its Drying Location from its date until a
  Take Down — Dry form (`dry_check`) is submitted with a matching
  `incomingUid`. UIDs match when one ends with the other, since crews write
  the last 4–5 characters. The admin panel can also mark a package taken
  down (`fields.takenDownAt` / `takenDownNote`) for take-downs that never got
  a form, or move it to the right room (`fields.dryRoom`). Those changes are
  saved on the intake as "Admin panel", show in its edit history, and can be
  put back. Weight logged to a room that isn't on the room list (like the
  old "Room 2") is shown separately and isn't counted against capacity.
- **Days in room** count from the intake date.
- **Capacity** is the hoops-based estimate from "Rooms capacity.xlsx". Room 2
  was measured as one room (28,140 lb), so 2A–2D are split evenly at 7,035 lb
  each until they're measured. To change a capacity, edit `capacityLb` in
  `reference.json`. Note that `canix_inventory.html` still has its own
  `DRYING_ROOMS` table with Room 2 whole; it's based on Canix data, not the forms.

### Schedule

Netlify's cron runs on UTC, so `netlify.toml` fires at 02:00 and 03:00 UTC.
The function only sends on whichever run is 7 pm in California, so daylight
saving is handled. It sends every evening, including days with no intakes,
because the drying rooms still change. To change the time, edit `SEND_HOUR`
in the function and the cron hours in `netlify.toml`.

### Email setup (one time)

The report is sent from a Gmail account using a Google **app password**. You
don't need to own a domain for this.

1. Use or create the Gmail account the reports should come from. Turn on
   2-Step Verification (Google Account → Security).
2. Google Account → Security → **App passwords**: create one named "2CW
   reports" and copy the 16-letter password.
3. In Netlify → Site configuration → Environment variables, add:
   - `GMAIL_USER`: the Gmail address
   - `GMAIL_APP_PASSWORD`: the app password (no spaces)
   - `REPORT_FROM_NAME` (optional): the sender name shown in inboxes
     (default "2CW Reports")
4. Redeploy so the functions pick up the variables, then use **Send now →
   Only another address…** to send a test to yourself.

The same Gmail account could also send the parked PIN-reset emails (see
"PIN reset by email" in `USER_ADMIN.md`). `pin-reset.js` uses Resend today,
so it would need switching to `report_mail.js`'s sender.

### Recipients and privacy

Anyone can be added, with or without an app login. Every email is BCC'd
(the To line is the sending address), so recipients don't see each other.
The recipient list and send log can only be read or changed through the
admin panel (admin PIN), because the tables have no browser access.
