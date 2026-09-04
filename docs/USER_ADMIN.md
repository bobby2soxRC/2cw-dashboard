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

`app_users` is a Supabase table: `id`, `name`, `pin`, `active`, `columns`
(jsonb), timestamps. The important design choice is that `columns` stores
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
