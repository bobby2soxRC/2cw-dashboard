-- 2CW Production — Supabase schema.
--
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query)
-- after creating the project. Safe to re-run: every statement is idempotent.
--
-- One table holds every station's forms, draft and finalized alike. Station
-- fields vary (bucking has different columns than a preroll run), so the
-- form's own answers live in `fields` (jsonb) and match production_stations.js
-- field-by-field; the columns outside `fields` are what the app needs to
-- query and filter on without unpacking JSON every time — which record is
-- whose, what stage it's at, and whether it's still being worked on.

create extension if not exists pgcrypto;

create table if not exists production_forms (
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

create index if not exists idx_forms_station_date on production_forms (station_key, work_date);
create index if not exists idx_forms_owner_open on production_forms (owner_user, status) where status = 'draft';
create index if not exists idx_forms_today on production_forms (work_date, status);

-- Keeps updated_at honest even on an app bug that forgets to set it.
create or replace function touch_production_forms() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_production_forms on production_forms;
create trigger trg_touch_production_forms
  before update on production_forms
  for each row execute function touch_production_forms();

-- Realtime: lets production_today.html subscribe and see edits land live
-- instead of polling.
alter publication supabase_realtime add table production_forms;

-- ── Row Level Security ───────────────────────────────────────────────────
-- IMPORTANT — read this before you trust it with anything sensitive.
--
-- This app has no real user login today (see the SSO discussion in
-- PRODUCTION_APP.md) — PINs live in a Google Sheet published to the web, and
-- "who is logged in" is just a name string sessionStorage trusts. Supabase's
-- Row Level Security is built around verified identity (a JWT from Supabase
-- Auth). Without that, RLS can restrict by *table*, not by *person* — it
-- cannot actually stop one tablet from reading or writing another
-- operator's row, any more than the current PIN system can. The policy
-- below matches today's real security level (a page a stranger can't guess
-- their way to, not a locked door) rather than pretending to be stronger.
--
-- The per-user "who can see/edit which station" restriction is enforced in
-- the app (index.html reads the directory sheet, prod_form.html and
-- production_today.html check it) — same place it's enforced today. Real
-- row-level security is one of the things proper SSO would unlock; worth
-- doing together if you move on the SSO recommendation.

alter table production_forms enable row level security;

drop policy if exists "anon read" on production_forms;
create policy "anon read" on production_forms for select using (true);

drop policy if exists "anon write" on production_forms;
create policy "anon write" on production_forms for insert with check (true);

drop policy if exists "anon update" on production_forms;
create policy "anon update" on production_forms for update using (true) with check (true);
