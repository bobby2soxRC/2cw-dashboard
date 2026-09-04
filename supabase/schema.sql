-- 2CW Operations — Supabase schema.
--
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query)
-- after creating the project. Safe to re-run: every statement is idempotent.
--
-- One table holds every station's forms, draft and finalized alike. Station
-- fields vary (bucking has different columns than a preroll run), so the
-- form's own answers live in `fields` (jsonb) and match operations_stations.js
-- field-by-field; the columns outside `fields` are what the app needs to
-- query and filter on without unpacking JSON every time — which record is
-- whose, what stage it's at, and whether it's still being worked on.

create extension if not exists pgcrypto;

create table if not exists operations_forms (
  id            uuid primary key default gen_random_uuid(),
  station_key   text not null,
  status        text not null default 'draft' check (status in ('draft', 'submitted')),
  owner_user    text,                 -- who started it (from 2cw_user_name)
  updated_by    text,                 -- who last touched it — can differ from owner on a handoff
  strain        text,                 -- surfaced outside `fields` so "switch strain" can filter fast
  work_date     date not null default current_date,
  fields        jsonb not null default '{}'::jsonb,
  client_id     text,                 -- ties an offline-queued save back to the browser that made it
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  submitted_at  timestamptz
);

create index if not exists idx_ops_forms_station_date on operations_forms (station_key, work_date);
create index if not exists idx_ops_forms_owner_open on operations_forms (owner_user, status) where status = 'draft';
create index if not exists idx_ops_forms_today on operations_forms (work_date, status);

-- Keeps updated_at honest even on an app bug that forgets to set it.
create or replace function touch_operations_forms() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_operations_forms on operations_forms;
create trigger trg_touch_operations_forms
  before update on operations_forms
  for each row execute function touch_operations_forms();

-- Realtime: lets operations_today.html subscribe and see edits land live
-- instead of polling.
alter publication supabase_realtime add table operations_forms;

-- ── Row Level Security ───────────────────────────────────────────────────
-- IMPORTANT — read this before you trust it with anything sensitive.
--
-- This app has no real user login today (see the SSO discussion in
-- OPERATIONS_APP.md) — PINs live in a Google Sheet published to the web, and
-- "who is logged in" is just a name string sessionStorage trusts. Supabase's
-- Row Level Security is built around verified identity (a JWT from Supabase
-- Auth). Without that, RLS can restrict by *table*, not by *person* — it
-- cannot actually stop one tablet from reading or writing another
-- operator's row, any more than the current PIN system can. The policy
-- below matches today's real security level (a page a stranger can't guess
-- their way to, not a locked door) rather than pretending to be stronger.
--
-- The per-user "who can see/edit which station" restriction is enforced in
-- the app (index.html reads the directory sheet, ops_form.html and
-- operations_today.html check it) — same place it's enforced today. Real
-- row-level security is one of the things proper SSO would unlock; worth
-- doing together if you move on the SSO recommendation.

alter table operations_forms enable row level security;

drop policy if exists "anon read" on operations_forms;
create policy "anon read" on operations_forms for select using (true);

drop policy if exists "anon write" on operations_forms;
create policy "anon write" on operations_forms for insert with check (true);

drop policy if exists "anon update" on operations_forms;
create policy "anon update" on operations_forms for update using (true) with check (true);

-- RLS policies above only take effect once anon also has the base table
-- GRANTs — without this, every anon select/insert/update on operations_forms
-- fails with "permission denied for table operations_forms" even though the
-- policies say it should be allowed (same gotcha called out for app_users
-- below). Tables created via the Supabase dashboard get this by default;
-- one created by running this file in the SQL editor does not.
grant select, insert, update on public.operations_forms to anon;

-- ── User directory (app_users) ───────────────────────────────────────────
-- Backs the in-app admin panel (admin.html) that replaces the "Users"
-- Google Sheet. Unlike operations_forms above, this table gates access to
-- commission and executive data, so it does NOT get an open anon-write
-- policy — all writes go through netlify/functions/admin.js, which uses the
-- Supabase service role key server-side (never shipped to the browser) and
-- requires an admin PIN + signed token. Anon SELECT stays open because the
-- directory sheet it replaces was already world-readable-if-you-have-the-
-- link; that isn't a downgrade.
--
-- `columns` deliberately mirrors the exact flat shape parseCSV() produces
-- from the old sheet (lowercase keys, 'TRUE'/'FALSE' strings, comma-list
-- strings for production station access) so index.html's loadDirectory()
-- is the only place that needs to change — buildHub() and everything
-- downstream stays untouched.

create table if not exists app_users (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  pin          text not null,
  active       boolean not null default true,
  columns      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists idx_app_users_pin_active on app_users (pin) where active;

drop trigger if exists trg_touch_app_users on app_users;
create trigger trg_touch_app_users
  before update on app_users
  for each row execute function touch_operations_forms();

alter table app_users enable row level security;

drop policy if exists "anon read" on app_users;
create policy "anon read" on app_users for select using (true);

-- No anon insert/update/delete policies — writes only via the service role
-- key inside netlify/functions/admin.js.

-- RLS bypass (which the service role has) does not skip Postgres's own
-- table-level GRANT check underneath it — without this, admin.js's queries
-- fail with "permission denied for table app_users" even though the key
-- is correct.
grant select, insert, update, delete on public.app_users to service_role;

-- Same story for anon: the "anon read" RLS policy above only takes effect
-- once anon also has the base table GRANT. Without this, index.html's
-- loadDirectorySupabase() gets a permission error, treats it as "Supabase
-- not available," and silently falls back to the legacy sheet — so admin
-- panel changes look like they're not taking effect, even though they saved.
grant select on public.app_users to anon;
