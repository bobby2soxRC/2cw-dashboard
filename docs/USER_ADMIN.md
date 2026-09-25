# User Admin — in-app user management

Replaces the "Users" Google Sheet as the place identity, PINs, and access
live. Everyone's access — which hub cards, which field forms, which
commission rep view, which production stations to edit or view — is now
managed from `/admin.html` instead of editing sheet columns by hand.

**This is a stopgap, not SSO.** See "SSO — short answer: yes, and multiple
domains is not the problem" in `OPERATIONS_APP.md` for the real long-term
direction. Everything below is explicitly the interim step: one shared admin
PIN instead of per-person identity, because the floor still needs to log in
with a 4-digit PIN on a shared tablet, and building real SSO wasn't in scope
yet. Anyone who has the admin PIN can grant themselves (or anyone) any
access in the system, including commissions and executive dashboards —
treat it like a master key, not a login.

## What's here

| File | What it is |
|---|---|
| `admin.html` | The panel itself — PIN gate, user list, add/edit/deactivate, import from sheet |
| `hub_config.js` | Card list, sheet-column mapping, commission mapping, `parseCSV()` — shared by `index.html` and `admin.html` so they can't drift apart |
| `netlify/functions/admin.js` | All writes go through here, using the Supabase service role key server-side |
| `supabase/schema.sql` | `app_users` table — see below |

## How it fits together

`app_users` is a Supabase table: `id`, `name`, `pin`, `active`, `title`,
`reports_to` (self-referencing FK — that person's manager, null at the top
of the chart), `columns` (jsonb), timestamps. `title`/`reports_to` back the
**Org Chart** tab in `admin.html` — set from the same per-user editor as
everything else, visualized as a nested tree there. The "Reports to"
dropdown only offers active users, and excludes the person themself and
anyone already below them on the chart; `netlify/functions/admin.js`
double-checks the same thing server-side on save (walks the proposed
manager's chain and rejects if it leads back to the person being edited),
so a reporting loop can't get saved even via a direct API call.

`admin.html` also has a **Responsibilities** tab — the delegation matrix
(every recurring responsibility, grouped by department/area, with an owner
and backup) that used to live on the Ops Gameplan Tracker. It talks to the
`responsibilities` Supabase table directly with the anon key (not through
`admin.js`), because that table already has an open anon read/write/delete
RLS policy — same posture as `tasks` — so there's nothing extra to lock
down there; the admin PIN gate is what controls who can *reach* the tab,
not the table's own permissions. One side effect worth knowing: moving it
here means only people with the admin PIN can edit responsibilities now
(previously it was gated by the same per-user hub card as the rest of the
Ops Gameplan Tracker, which could be a wider group). `my_responsibilities.html`
still reads the same table with no PIN required — anyone can see what's
assigned to them — it's only editing assignments that now requires the
admin PIN.

## My Tasks — personal task assignment

`my_tasks.html` is a two-tab personal page (no admin PIN needed, gated only
by the `my_tasks` hub card, toggled per person in `admin.html` like any
other card): a **Tasks** tab and a **Job Description & Responsibilities**
tab (the latter is the same data/UI as `my_responsibilities.html`, just
embedded as a second tab so both live in one place).

The Tasks tab is one-on-one task delegation between coworkers — separate
from the org-wide 30/60/90 gameplan on `tasks_dashboard.html` — backed by
two new Supabase tables (`personal_tasks`, `personal_task_notes`), both
with the same open anon read/write/delete RLS as `tasks`/`responsibilities`:
nothing here is more sensitive than what's already on the Gameplan
Tracker, and any logged-in person can create a task and assign it to
anyone else (matched by login name, same string-match approach as
`responsibilities.owner`). The page shows two sections: **Assigned to
you** (tasks where you're the assignee — status, priority, due date,
follow-up date, and a running notes log you can add to) and **You've
handed out** (tasks you created for someone else, so you can follow their
progress). Unlike `responsibilities.notes` (a single overwritten field),
`personal_task_notes` is an append-only log — every note is its own
timestamped row with an author, so a task keeps a visible history instead
of just the latest comment.

If you're setting this up for the first time, re-run `supabase/schema.sql`
in the Supabase SQL editor (idempotent, safe to re-run) to create the two
new tables, then turn on the `my_tasks` card for whoever should have it in
`admin.html`'s per-user editor.

`personal_tasks.completed_at` is set/cleared by a database trigger the
moment `status` flips into or out of `'done'` — not by the app — so it
stays correct no matter which page changed the status. Both `my_tasks.html`
and `task_oversight.html` also write an automatic `kind:'system'` row to
`personal_task_notes` on every status change (e.g. "Status: Not started →
In progress"), so the notes log doubles as a per-task activity trail
alongside whatever people type themselves (`kind:'note'`).

## Task Activity — admin oversight of everyone's tasks

`task_oversight.html` is the manager's-eye view of the same
`personal_tasks`/`personal_task_notes` data behind My Tasks, across every
person at once — not just your own. It's gated by its own hub card
(`task_oversight`, pinned alongside the Ops Gameplan Tracker), toggled per
person in `admin.html`'s per-user editor exactly like every other card —
there's no separate admin PIN for it, so whoever you check the box for can
open it. It shows:

- Org-wide summary tiles (open/blocked/done counts, overdue, average days
  to close).
- An **Activity by person** table — assigned/open/overdue counts and
  average completion time per person, so you can see at a glance who's
  overloaded or falling behind.
- The full task list across everyone, filterable by person/status/priority/
  overdue, with the same expand-to-see-notes, add-note, edit, and delete
  capabilities as `my_tasks.html` — an admin can act on anyone's task since
  the table has no per-row access control (same open-RLS posture as
  everywhere else in this doc).

Turn it on for whoever should have visibility (ops leads, managers) the
same way you'd turn on any other card — no extra setup beyond the schema
already required for My Tasks.

## Task CSV template, export, and re-import

Both `my_tasks.html` and `task_oversight.html` have **Download template**,
**Download … (CSV)**, and **Upload CSV** buttons — available to everyone on
`my_tasks.html` (no PIN or special access needed, same as the rest of that
page), and to whoever has the Task Activity card on `task_oversight.html`.
All three read/write the same eight columns: `id, title, description,
assignee, priority, status, due_date, follow_up_date`.

- **Download template** gives a one-row example CSV for creating tasks from
  scratch — `id` is blank, so every row becomes a new task on upload. Only
  `title` is required; `assignee` defaults to whoever uploads it on
  `my_tasks.html` (on `task_oversight.html` it's required, since there's no
  "current person" to default to there).
- **Download my tasks / Download all tasks** exports the tasks already
  visible on that page (yours + handed-out on `my_tasks.html`; everyone's on
  `task_oversight.html`) with their `id` filled in.
- **Upload CSV** re-imports either kind of file: a row whose `id` matches an
  existing task updates it in place (including logging a status-change note
  if `status` differs, same as editing it directly); a row with no
  `id`, or one that doesn't match, falls back to matching by title+assignee,
  and failing that is inserted as a brand-new task. This is what makes the
  round trip work — download, edit in a spreadsheet, re-upload, and the same
  tasks update instead of duplicating.

Dates accept `YYYY-MM-DD` (what the app itself exports and what `<input
type=date>` produces) or anything else JavaScript's `Date` parser accepts
(e.g. Excel's `9/25/2026`). `status` accepts the raw values
(`not_started`/`in_progress`/`blocked`/`done`) plus a few common spellings
(`Complete`, `In Progress`, `Unsure`→blocked); anything unrecognized falls
back to `not_started`, so a garbled status column never fails the whole
import.

The important design choice for the rest of the row is that `columns` stores
the **exact same flat shape** `parseCSV()` already produced from the sheet —
lowercase column names, `'TRUE'`/`'FALSE'` strings, comma-list strings for
`production edit stations` / `production view stations`. That means
`index.html`'s `loadDirectory()` is the *only* place that changed:

```
loadDirectory()
  -> try app_users (active=true) via the anon key, mapped to the same shape
  -> falls back to the sheet CSV if Supabase isn't configured, or has no
     active users yet
```

`buildHub()` and every downstream access check are untouched — they still
just read `user['some column name']`, with no idea whether it came from a
sheet row or a database row.

## Setting it up

1. **Run the schema.** In the Supabase SQL editor, run `supabase/schema.sql`
   (idempotent — safe even if you already ran it for the operations app).
   This adds `app_users` alongside the existing `operations_forms` table.
2. **Add four Netlify env vars** (Site configuration → Environment
   variables) — none of these are shipped to the browser:
   - `ADMIN_PIN` — the PIN that unlocks `/admin.html`. Pick something that
     isn't also a staff PIN.
   - `ADMIN_SIGNING_SECRET` — any long random string (e.g. `openssl rand
     -hex 32`). Used to sign the session token issued on admin login; it
     never leaves the server.
   - `SUPABASE_URL` — same Project URL as `config/supabase_config.js`.
   - `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API → `service_role`
     key. **Never** put this in a browser-served file — it bypasses Row
     Level Security entirely, which is exactly why writes to `app_users` are
     routed through `netlify/functions/admin.js` instead of the client
     talking to Supabase directly.
3. **Deploy**, open `/admin.html`, enter the admin PIN.
4. **Import from Sheet.** The panel has an "Import from Sheet" button that
   fetches the live directory CSV (same URL `index.html` already used) and
   bulk-upserts every row into `app_users`, matched by name — existing rows
   get updated, new names get created. This is meant to be run once during
   migration so you don't have to retype the whole staff list by hand; it's
   safe to run again later (e.g. after adding someone new to the sheet as a
   stopgap before you remember to add them properly).
5. Once you trust the imported data, treat the sheet as retired — new users
   and access changes go through the panel from here on. The sheet fallback
   stays in the code as a safety net (if Supabase is ever unreachable, or
   the project gets torn down, login degrades back to the sheet instead of
   locking everyone out) — it isn't something you need to keep maintaining.

## Why `app_users` isn't as open as `operations_forms`

`operations_forms`' RLS intentionally allows anonymous read/write — see the
comment in `supabase/schema.sql` — because there's no real identity to
restrict by yet, and a closed policy there would be false security, not
real security. `app_users` is treated differently: it gates access to
commissions and executive data, so:

- **Anon SELECT is allowed** — the same "not secret, just not advertised"
  posture as the sheet it replaces (index.html needs to read it to log
  people in).
- **Anon INSERT/UPDATE/DELETE are blocked.** Every write goes through
  `netlify/functions/admin.js`, which requires a signed token issued only
  after the correct `ADMIN_PIN` was supplied, and does its actual writes
  with the service role key — never the anon key.

## Token mechanics (for the curious / for extending this later)

`POST /.netlify/functions/admin` with `{action:'login', pin}` checks the PIN
against `ADMIN_PIN` and, if it matches, returns a token: `<expiry
timestamp>.<HMAC-SHA256 of the expiry, signed with ADMIN_SIGNING_SECRET>`.
Every other action (`list`, `upsert`, `deactivate`, `reactivate`, `import`)
requires that token in the body; the function recomputes the HMAC and
checks the expiry (6 hours) before doing anything. There's no session
store — the token is self-contained, same idea as a JWT, just without
pulling in a JWT library for one field. `admin.html` keeps it in
`sessionStorage`, same lifetime as the staff PIN session already uses.

This is intentionally simple and has real limits: there's one shared admin
PIN (not per-admin identity or an audit trail of *which* admin made a
change), and a leaked `ADMIN_SIGNING_SECRET` lets anyone mint tokens without
knowing the PIN. Both are acceptable for a small ops team today and both
are the kind of thing real SSO (see `OPERATIONS_APP.md`) would clean up —
rotate `ADMIN_SIGNING_SECRET` in Netlify if you ever suspect it leaked.
