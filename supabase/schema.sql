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
-- instead of polling. Guarded because `alter publication ... add table` has
-- no `if not exists` of its own — re-running this file unguarded throws
-- "relation ... is already member of publication" on the second run, which
-- (run via the SQL Editor as one batch) rolls back everything else in the
-- paste along with it, contrary to the "safe to re-run" promise below.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'operations_forms'
  ) then
    alter publication supabase_realtime add table operations_forms;
  end if;
end $$;

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
  title        text,               -- org chart job title, e.g. "VP of Operations"
  reports_to   uuid references app_users(id) on delete set null,  -- org chart manager — nullable (top of the chart)
  columns      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Added after the table's first release — `create table if not exists`
-- above won't retrofit new columns onto an already-existing table, so this
-- runs separately and is safe to re-run.
alter table app_users add column if not exists title text;
alter table app_users add column if not exists reports_to uuid references app_users(id) on delete set null;

-- Contact info: last name, email, phone. Email is stored lowercased by
-- admin.js, so the unique index and lookups can use plain equality — it's
-- also what emailed reports and the (not yet enabled) PIN reset in
-- netlify/functions/pin-reset.js send to. pin_reset_sent_at throttles reset
-- emails to one a minute per person.
alter table app_users add column if not exists last_name text;
alter table app_users add column if not exists email text;
alter table app_users add column if not exists phone text;
alter table app_users add column if not exists pin_reset_sent_at timestamptz;

create unique index if not exists idx_app_users_pin_active on app_users (pin) where active;
create unique index if not exists idx_app_users_email_active on app_users (email) where active and email is not null;
create index if not exists idx_app_users_reports_to on app_users (reports_to);

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

-- ── Tasks (Ops Gameplan Tracker) ─────────────────────────────────────────
-- Backs tasks_dashboard.html — the VP-of-Ops 30/60/90 gameplan, tracked as
-- editable tasks instead of a static document. Visibility is the same
-- PIN-card gate as every other dashboard (see hub_config.js's
-- 'tasks_dashboard' card, toggled per person in admin.html) — not a locked
-- table like app_users, because the only two people with the card today are
-- Robert and Ned and there's nothing here more sensitive than what's already
-- on operations_forms. Same anon-write posture as operations_forms above:
-- the wall is "you can't reach the page," not "the table refuses you."

create table if not exists tasks (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text,
  source        text not null default 'manual' check (source in ('30_60_90_plan', 'action_items_csv', 'manual', 'csv_upload')),
  phase         text check (phase in ('0-30', '31-60', '61-90')),   -- null = not tied to a 30/60/90 window
  track         text check (track in ('compliance', 'systems', 'facilities', 'people')), -- null = no pillar tag
  status        text not null default 'not_started' check (status in ('not_started', 'in_progress', 'blocked', 'done')),
  priority      text check (priority in ('low', 'medium', 'high')),
  owner         text,          -- "Responsible" in the original action-items list
  requested_by  text,
  due_date      date,
  notes         text,          -- free-text status notes / "Results" column from CSV imports
  sort_order    integer not null default 0,
  updated_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_tasks_phase on tasks (phase);
create index if not exists idx_tasks_status on tasks (status);

drop trigger if exists trg_touch_tasks on tasks;
create trigger trg_touch_tasks
  before update on tasks
  for each row execute function touch_operations_forms();

alter table tasks enable row level security;

drop policy if exists "anon read" on tasks;
create policy "anon read" on tasks for select using (true);
drop policy if exists "anon write" on tasks;
create policy "anon write" on tasks for insert with check (true);
drop policy if exists "anon update" on tasks;
create policy "anon update" on tasks for update using (true) with check (true);
drop policy if exists "anon delete" on tasks;
create policy "anon delete" on tasks for delete using (true);

grant select, insert, update, delete on public.tasks to anon;

-- Subtasks are full mini-tasks (own status/owner/due date), not a checklist —
-- each row references its parent task and is deleted along with it.
create table if not exists task_subtasks (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references tasks(id) on delete cascade,
  title         text not null,
  status        text not null default 'not_started' check (status in ('not_started', 'in_progress', 'blocked', 'done')),
  owner         text,
  due_date      date,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_task_subtasks_task on task_subtasks (task_id);

drop trigger if exists trg_touch_task_subtasks on task_subtasks;
create trigger trg_touch_task_subtasks
  before update on task_subtasks
  for each row execute function touch_operations_forms();

alter table task_subtasks enable row level security;

drop policy if exists "anon read" on task_subtasks;
create policy "anon read" on task_subtasks for select using (true);
drop policy if exists "anon write" on task_subtasks;
create policy "anon write" on task_subtasks for insert with check (true);
drop policy if exists "anon update" on task_subtasks;
create policy "anon update" on task_subtasks for update using (true) with check (true);
drop policy if exists "anon delete" on task_subtasks;
create policy "anon delete" on task_subtasks for delete using (true);

grant select, insert, update, delete on public.task_subtasks to anon;

-- ── Responsibilities Matrix ──────────────────────────────────────────────
-- Backs the Responsibilities tab on tasks_dashboard.html (Ops Gameplan
-- Tracker) and my_responsibilities.html's personal "what's mine" view —
-- every recurring responsibility across the business (leases, licensing,
-- cultivation, processing, manufacturing, distribution, S&OP, systems)
-- with a named owner/backup, so delegation gaps are visible instead of
-- living in someone's head. Same posture as tasks/task_subtasks above:
-- visibility is gated by the hub cards (see hub_config.js's
-- 'tasks_dashboard' and 'my_responsibilities' cards, toggled per person in
-- admin.html), and the table itself stays open to anon read/write since
-- there's nothing here more sensitive than what's already on tasks.

create table if not exists responsibilities (
  id            uuid primary key default gen_random_uuid(),
  department    text,            -- e.g. 'Cultivation', 'Compliance' — coarser roll-up than `area`, for org-level filtering/reporting
  area          text not null,   -- e.g. 'Land & Leases', 'Cultivation' — free text, grouped in the UI by whatever values exist
  title         text not null,
  description   text,
  owner         text,
  backup_owner  text,
  status        text not null default 'unassigned' check (status in ('unassigned', 'assigned', 'needs_backup')),
  priority      text check (priority in ('low', 'medium', 'high')),
  notes         text,
  source        text not null default 'manual' check (source in ('seed', 'manual', 'csv_upload')),
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Added after the table's first release — `create table if not exists`
-- above won't retrofit a new column onto an already-existing table, so this
-- runs separately and is safe to re-run (same pattern as canix_facilities'
-- `status` column below).
alter table responsibilities add column if not exists department text;

create index if not exists idx_responsibilities_area on responsibilities (area);
create index if not exists idx_responsibilities_department on responsibilities (department);
create index if not exists idx_responsibilities_status on responsibilities (status);
create unique index if not exists idx_responsibilities_area_title on responsibilities (area, title);

drop trigger if exists trg_touch_responsibilities on responsibilities;
create trigger trg_touch_responsibilities
  before update on responsibilities
  for each row execute function touch_operations_forms();

alter table responsibilities enable row level security;

drop policy if exists "anon read" on responsibilities;
create policy "anon read" on responsibilities for select using (true);
drop policy if exists "anon write" on responsibilities;
create policy "anon write" on responsibilities for insert with check (true);
drop policy if exists "anon update" on responsibilities;
create policy "anon update" on responsibilities for update using (true) with check (true);
drop policy if exists "anon delete" on responsibilities;
create policy "anon delete" on responsibilities for delete using (true);

grant select, insert, update, delete on public.responsibilities to anon;

-- Seed with the first pass at the full responsibility list (unowned —
-- assign owner/backup_owner from the UI). department is the coarser
-- roll-up (one of 9 org-level buckets); area stays the finer grouping the
-- UI already renders. sort_order keeps each area in the order it was
-- drafted rather than alphabetical. Safe to re-run: the unique (area,
-- title) index above makes this an upsert-free no-op on rows that already
-- exist, and it never touches owner/status/notes you've since edited in
-- the UI. An existing table gets `department` backfilled per row below via
-- an explicit update, since `on conflict do nothing` skips existing rows
-- entirely (including this new column) on a re-run.
insert into responsibilities (department, area, title, description, sort_order, source) values
  ('Real Estate & Facilities', 'Land & Leases', 'Landlord relationships', 'Primary point of contact with each land owner — day-to-day communication and issue resolution.', 1, 'seed'),
  ('Real Estate & Facilities', 'Land & Leases', 'Lease negotiation & renewal', 'Negotiating new leases and renewing/amending existing ones before they lapse.', 2, 'seed'),
  ('Real Estate & Facilities', 'Land & Leases', 'Lease payment scheduling', 'Tracking lease payment amounts and due dates across every property, making sure they''re paid on time.', 3, 'seed'),
  ('Real Estate & Facilities', 'Land & Leases', 'Property capital upgrades', 'Scoping and approving upgrades — power drops, shade cloths, pump upgrades, water tanks — per property.', 4, 'seed'),
  ('Real Estate & Facilities', 'Land & Leases', 'Upgrade project & contractor management', 'Running the actual upgrade projects — scheduling contractors, tracking completion.', 5, 'seed'),

  ('Compliance', 'Licensing & Compliance', 'DCC license applications', 'Applying for new cultivation/processing/manufacturing/distribution licenses as needed.', 1, 'seed'),
  ('Compliance', 'Licensing & Compliance', 'DCC license renewals & maintenance', 'Keeping every existing license current — renewal deadlines, fee payments, amendments.', 2, 'seed'),
  ('Compliance', 'Licensing & Compliance', 'DCC inspections', 'Scheduling and being present for DCC inspections, and closing out any findings.', 3, 'seed'),
  ('Compliance', 'Licensing & Compliance', 'DCC relationship management', 'The primary point of contact with the Department of Cannabis Control.', 4, 'seed'),
  ('Compliance', 'Licensing & Compliance', 'Metrc compliance — cultivation', 'Plant tags, plant counts, and Metrc recordkeeping at the farms.', 5, 'seed'),
  ('Compliance', 'Licensing & Compliance', 'Metrc compliance — processing', 'Metrc recordkeeping at the processing facility (Adobe).', 6, 'seed'),
  ('Compliance', 'Licensing & Compliance', 'Metrc compliance — distribution', 'Metrc recordkeeping at the distribution facility (Airway).', 7, 'seed'),
  ('Compliance', 'Licensing & Compliance', 'Compliance SOPs & recordkeeping', 'Maintaining written SOPs and the compliance paper trail across all licenses.', 8, 'seed'),

  ('Cultivation', 'Nursery', 'Nursery build-out', 'Project-managing construction of the nursery — design, contractors, timeline.', 1, 'seed'),
  ('Cultivation', 'Nursery', 'Nursery licensing', 'Getting DCC licensing in place for the nursery once built.', 2, 'seed'),
  ('Cultivation', 'Nursery', 'Nursery operations', 'Running the nursery once live — mother plants, clone production for internal use.', 3, 'seed'),

  ('Cultivation', 'Cultivation', 'Clone sourcing', 'Sourcing clones from outside vendors until the nursery is online.', 1, 'seed'),
  ('Cultivation', 'Cultivation', 'Planting schedule', 'Building and maintaining the planting calendar across all farms.', 2, 'seed'),
  ('Cultivation', 'Cultivation', 'Cultivation labor scheduling', 'Scheduling crews for planting, maintenance, and general farm labor.', 3, 'seed'),
  ('Cultivation', 'Cultivation', 'Materials & supplies procurement', 'Buying soil, nutrients, and other cultivation materials — making sure farms don''t run out.', 4, 'seed'),
  ('Cultivation', 'Cultivation', 'Cultivation transportation scheduling', 'Scheduling crew, equipment, and material transport between farms.', 5, 'seed'),
  ('Cultivation', 'Cultivation', 'Farm equipment maintenance', 'Maintaining tractors, pumps, and other cultivation equipment.', 6, 'seed'),
  ('Cultivation', 'Cultivation', 'Farm equipment transport', 'Moving farm equipment between farms as needed.', 7, 'seed'),
  ('Cultivation', 'Cultivation', 'Pest management / IPM program', 'Running the integrated pest management program across all farms.', 8, 'seed'),
  ('Cultivation', 'Cultivation', 'Spray scheduling & application', 'Scheduling and executing spray applications.', 9, 'seed'),
  ('Cultivation', 'Cultivation', 'Fertilizer / nutrient program', 'Planning and executing the fertilizer/nutrient program through the grow cycle.', 10, 'seed'),
  ('Cultivation', 'Cultivation', 'Irrigation & water systems', 'Managing irrigation systems and water supply across all farms.', 11, 'seed'),

  ('Cultivation', 'Harvest & Post-Harvest', 'Harvest forecasting', 'Forecasting expected yield by farm and strain ahead of harvest.', 1, 'seed'),
  ('Cultivation', 'Harvest & Post-Harvest', 'Harvest scheduling', 'Scheduling harvest dates by farm and strain.', 2, 'seed'),
  ('Cultivation', 'Harvest & Post-Harvest', 'Harvest labor scheduling', 'Staffing harvest crews.', 3, 'seed'),
  ('Cultivation', 'Harvest & Post-Harvest', 'Harvest equipment & truck rentals', 'Arranging truck rentals and equipment needed for harvest.', 4, 'seed'),
  ('Cultivation', 'Harvest & Post-Harvest', 'Fresh-frozen vs. dried allocation', 'Deciding per-lot what goes fresh-frozen (concentrates) vs. dried (flower/pre-rolls).', 5, 'seed'),
  ('Cultivation', 'Harvest & Post-Harvest', 'Farm-to-processing transport', 'Transporting harvested material from the farms to the processing facility.', 6, 'seed'),
  ('Cultivation', 'Harvest & Post-Harvest', 'Drying process management', 'Managing the drying process once material arrives at processing.', 7, 'seed'),

  ('Processing', 'Processing Facility (Adobe)', 'Facility lease management', 'Lease payments and annual balloon payments on the processing facility.', 1, 'seed'),
  ('Processing', 'Processing Facility (Adobe)', 'Processing license & DCC relationship', 'Maintaining the processing license and the DCC relationship for this facility.', 2, 'seed'),
  ('Processing', 'Processing Facility (Adobe)', 'Processing Metrc & intake scheduling', 'Metrc compliance and scheduling of incoming material at processing.', 3, 'seed'),
  ('Processing', 'Processing Facility (Adobe)', 'HVAC maintenance', 'Maintaining and servicing the facility HVAC system.', 4, 'seed'),
  ('Processing', 'Processing Facility (Adobe)', 'Trimming machine maintenance', 'Maintaining and servicing the trimming machines.', 5, 'seed'),
  ('Processing', 'Processing Facility (Adobe)', 'Pre-roll machine maintenance', 'Maintaining and servicing the pre-roll machine.', 6, 'seed'),
  ('Processing', 'Processing Facility (Adobe)', 'Dehumidifier maintenance', 'Maintaining and servicing dehumidifiers.', 7, 'seed'),
  ('Processing', 'Processing Facility (Adobe)', 'General facility maintenance', 'General building upkeep and repairs.', 8, 'seed'),
  ('Processing', 'Processing Facility (Adobe)', 'Facility sanitation', 'Cleaning schedule — bathrooms, common areas, production spaces.', 9, 'seed'),
  ('Processing', 'Processing Facility (Adobe)', 'Trim scheduling & lot decisions', 'Deciding what gets trimmed, when, and what happens to it afterward.', 10, 'seed'),
  ('Processing', 'Processing Facility (Adobe)', 'Bulk sales coordination', 'Coordinating bulk sales of output that comes out of processing.', 11, 'seed'),
  ('Processing', 'Processing Facility (Adobe)', 'Processing facility inventory', 'Tracking on-hand inventory at the processing facility.', 12, 'seed'),

  ('Logistics', 'Transportation & Logistics', 'Adobe → Airway transfer planning', 'Deciding what gets transferred to distribution — strain, lot size, timing.', 1, 'seed'),
  ('Logistics', 'Transportation & Logistics', 'Adobe → Airway transfer execution', 'Scheduling and executing the actual transport between facilities.', 2, 'seed'),

  ('Manufacturing', 'Manufacturing', 'Pre-roll production planning', 'Deciding how many pre-rolls to make, in what sizes and flavors.', 1, 'seed'),
  ('Manufacturing', 'Manufacturing', 'Manufacturing labor scheduling', 'Staffing pre-roll and manufacturing production runs.', 2, 'seed'),
  ('Manufacturing', 'Manufacturing', 'Vape & concentrate production planning', 'Deciding how much to manufacture and when, and staffing it.', 3, 'seed'),
  ('Manufacturing', 'Manufacturing', 'Hash-infused pre-roll production planning', 'Deciding how much to manufacture and when, and staffing it.', 4, 'seed'),
  ('Manufacturing', 'Manufacturing', 'Packaging materials inventory', 'Tracking on-hand packaging material inventory and making sure production runs deplete it correctly in Canix.', 5, 'seed'),
  ('Manufacturing', 'Manufacturing', 'Packaging materials & supplies ordering', 'Placing orders for packaging materials and production supplies (e.g. pre-roll cones), timed to lead times and volume price breaks.', 6, 'seed'),

  ('Distribution', 'Distribution (Airway)', 'Pack-out planning', 'Deciding what flower gets packed into which pouches/sizes.', 1, 'seed'),
  ('Distribution', 'Distribution (Airway)', 'Product testing coordination', 'Scheduling and coordinating required lab testing.', 2, 'seed'),
  ('Distribution', 'Distribution (Airway)', 'Distribution Metrc compliance', 'Metrc recordkeeping at the distribution facility.', 3, 'seed'),
  ('Distribution', 'Distribution (Airway)', 'Distribution inventory counts', 'Regular inventory counts at the distribution facility.', 4, 'seed'),
  ('Distribution', 'Distribution (Airway)', 'Scheduling to KFS/KSS (last-mile)', 'Scheduling delivery of finished inventory to Kiva/KSS, the last-mile distributor.', 5, 'seed'),
  ('Distribution', 'Distribution (Airway)', 'Distribution facility inventory management', 'Overall inventory management at the distribution facility.', 6, 'seed'),

  ('Sales & Planning', 'Sales & Operations Planning', 'S&OP planning', 'Building the sales & operations plan — what needs to be produced, when, based on demand and inventory.', 1, 'seed'),
  ('Sales & Planning', 'Sales & Operations Planning', 'KSS inventory monitoring', 'Watching inventory levels at KSS to inform production planning.', 2, 'seed'),
  ('Sales & Planning', 'Sales & Operations Planning', 'Cross-functional production coordination', 'Coordinating the production plan across cultivation, processing, manufacturing, and distribution.', 3, 'seed'),

  ('Systems & IT', 'Systems & ERP (Canix)', 'Canix batch entry — cultivation', 'Creating/updating batches and recording cultivation activity in Canix.', 1, 'seed'),
  ('Systems & IT', 'Systems & ERP (Canix)', 'Canix batch entry — processing', 'Creating/updating batches and recording processing activity in Canix.', 2, 'seed'),
  ('Systems & IT', 'Systems & ERP (Canix)', 'Canix batch entry — manufacturing', 'Creating/updating batches and recording manufacturing production runs in Canix.', 3, 'seed'),
  ('Systems & IT', 'Systems & ERP (Canix)', 'Canix batch entry — distribution', 'Creating/updating batches and recording distribution activity in Canix.', 4, 'seed'),
  ('Systems & IT', 'Systems & ERP (Canix)', 'Canix/Metrc data integrity oversight', 'Making sure what''s entered in Canix syncs correctly to Metrc and stays accurate across all stages.', 5, 'seed')
on conflict (area, title) do nothing;

-- Backfill department on any rows that already existed before this column
-- was added (the insert above only sets it for brand-new rows — `on
-- conflict do nothing` skips existing ones entirely). Matches by area only,
-- so it's safe to re-run and never overwrites a department you've since
-- changed by hand — the `is null` guard means it only fills gaps.
update responsibilities set department = 'Real Estate & Facilities' where area = 'Land & Leases' and department is null;
update responsibilities set department = 'Compliance' where area = 'Licensing & Compliance' and department is null;
update responsibilities set department = 'Cultivation' where area in ('Nursery', 'Cultivation', 'Harvest & Post-Harvest') and department is null;
update responsibilities set department = 'Processing' where area = 'Processing Facility (Adobe)' and department is null;
update responsibilities set department = 'Logistics' where area = 'Transportation & Logistics' and department is null;
update responsibilities set department = 'Manufacturing' where area = 'Manufacturing' and department is null;
update responsibilities set department = 'Distribution' where area = 'Distribution (Airway)' and department is null;
update responsibilities set department = 'Sales & Planning' where area = 'Sales & Operations Planning' and department is null;
update responsibilities set department = 'Systems & IT' where area = 'Systems & ERP (Canix)' and department is null;

-- ── Canix facility nicknames ─────────────────────────────────────────────
-- Backs canix_inventory.html's facility labeling/grouping (stage, farm
-- group, a human nickname) for the licenses pulled by scripts/canix_sync.py.
-- Same security posture as app_users above: this is admin-managed reference
-- data, not something every viewer should be able to rewrite, so it does
-- NOT get an open anon-write policy. Two different writers, on purpose:
--   - scripts/canix_sync.py (service role key, run nightly) owns
--     canix_name/license_number/status — it upserts every facility Canix
--     currently reports (status='active') and flips status to 'archived'
--     for any facility_id it used to see but no longer does. It never
--     touches display_name/stage/farm_group/exclude.
--   - netlify/functions/canix-facilities.js (service role key, admin PIN)
--     owns display_name/stage/farm_group/exclude — the human-edited fields
--     from admin.html's "Canix Facilities" tab. It never touches
--     canix_name/license_number/status.
-- Anon SELECT stays open so the dashboard itself (no login) can read
-- facility labels.

create table if not exists canix_facilities (
  facility_id       bigint primary key,   -- Canix's own facility id
  canix_name        text,                 -- facility "name" field as Canix has it on file
  license_number    text,                 -- Canix's license_number field (can differ from canix_name — see CCL25/28-0000167 mixup)
  display_name      text,                 -- nickname shown on the dashboard; falls back to canix_name when null
  stage             text,                 -- Cultivation | Processing | Manufacturing | Distribution
  farm_group        text,                 -- cultivation-only: which physical farm this license sits on
  dcc_license_type  text,                 -- verified against search.cannabis.ca.gov, not guessed
  dcc_county        text,
  held_by           text,                 -- legal entity holding the license per DCC
  address           text,
  exclude           boolean not null default false,  -- e.g. the Canix sandbox facility
  updated_at        timestamptz not null default now()
);

-- Added after the table's first release — `create table if not exists`
-- above won't retrofit a new column onto an already-existing table, so this
-- runs separately and is safe to re-run.
alter table canix_facilities add column if not exists status text not null default 'active';
alter table canix_facilities drop constraint if exists canix_facilities_status_check;
alter table canix_facilities add constraint canix_facilities_status_check check (status in ('active', 'archived'));

drop trigger if exists trg_touch_canix_facilities on canix_facilities;
create trigger trg_touch_canix_facilities
  before update on canix_facilities
  for each row execute function touch_operations_forms();

alter table canix_facilities enable row level security;

drop policy if exists "anon read" on canix_facilities;
create policy "anon read" on canix_facilities for select using (true);

-- No anon insert/update/delete policies. service_role covers both writers:
-- scripts/canix_sync.py (canix_name/license_number/status) and
-- netlify/functions/canix-facilities.js (display_name/stage/farm_group/exclude).

grant select, insert, update, delete on public.canix_facilities to service_role;
grant select on public.canix_facilities to anon;

-- Seed with the 16 licenses verified against the DCC's public license
-- search (search.cannabis.ca.gov) on 2026-09-14 — not guessed from license
-- number prefixes. Safe to re-run: existing rows (and any nicknames already
-- set on them) are left alone. scripts/canix_sync.py takes over keeping
-- canix_name/license_number/status current after this one-time seed.
insert into canix_facilities
  (facility_id, canix_name, license_number, status, stage, farm_group, dcc_license_type, dcc_county, held_by, address, exclude)
values
  (5123, '2CW-Sandbox', '2CW-Sandbox', 'active', null, null, null, null, null, '2351 Circadian Way, Santa Rosa, CA 95407', true),
  (5098, 'CCL21-0006075-Artemis Farms, LLC', 'CCL21-0006075', 'active', 'Cultivation', 'Bartlett Springs Rd', 'Cultivation - Medium Outdoor', 'Lake', 'Artemis Farms, LLC', '5200 Bartlett Springs Road, Unincorporated, CA 95464', false),
  (5097, 'CCL21-0006073-Artemis Farms, LLC', 'CCL21-0006073', 'active', 'Cultivation', 'Bartlett Springs Rd', 'Cultivation - Medium Outdoor', 'Lake', 'Artemis Farms, LLC', '5200 Bartlett Springs Road, Unincorporated, CA 95464', false),
  (5096, 'CCL21-0006071-Artemis Farms, LLC', 'CCL21-0006071', 'active', 'Cultivation', 'Bartlett Springs Rd', 'Cultivation - Medium Outdoor', 'Lake', 'Artemis Farms, LLC', '5200 Bartlett Springs Road, Unincorporated, CA 95464', false),
  (5095, 'CCL26-0000027 - All Good Properties, Inc', 'CCL26-0000027', 'active', 'Cultivation', 'Grange Rd', 'Cultivation - Large Outdoor', 'Lake', 'All Good Properties, Inc.', '19955 Grange Road, Unincorporated, CA 95461', false),
  (5012, 'CCL21-0002183', 'CCL21-0002183', 'active', 'Cultivation', 'Antler Hill Dr', 'Cultivation - Small Outdoor', 'Lake', 'Wildcat Farmz LLC', '9275 Antler Hill Drive, Unincorporated, CA 95451', false),
  (5011, 'CCL21-0002182', 'CCL21-0002182', 'active', 'Cultivation', 'Antler Hill Dr', 'Cultivation - Small Outdoor', 'Lake', 'Wildcat Farmz LLC', '9275 Antler Hill Drive, Unincorporated, CA 95451', false),
  (5010, 'CCL21-0002181', 'CCL21-0002181', 'active', 'Cultivation', 'Antler Hill Dr', 'Cultivation - Small Outdoor', 'Lake', 'Wildcat Farmz LLC', '9275 Antler Hill Drive, Unincorporated, CA 95451', false),
  (5009, 'CCL21-0002180', 'CCL21-0002180', 'active', 'Cultivation', 'Antler Hill Dr', 'Cultivation - Small Outdoor', 'Lake', 'Wildcat Farmz LLC', '9275 Antler Hill Drive, Unincorporated, CA 95451', false),
  (5008, 'CCL21-0002179', 'CCL21-0002179', 'active', 'Cultivation', 'Antler Hill Dr', 'Cultivation - Small Outdoor', 'Lake', 'Wildcat Farmz LLC', '9275 Antler Hill Drive, Unincorporated, CA 95451', false),
  (4929, 'C11-0001652-LIC', 'C11-0001652-LIC', 'active', 'Distribution', null, 'Commercial - Distributor', 'Sonoma', 'Airway Industries Inc.', '3415 Industrial Drive, Santa Rosa, CA 95403', false),
  (4927, 'CCL23-0000540', 'CCL23-0000540', 'active', 'Cultivation', 'Highland Springs Rd', 'Cultivation - Medium Outdoor', 'Lake', 'BG Property Management, LLC', '9200 Highland Springs Road, Unincorporated, CA 95453', false),
  (4926, 'CCL21-0000310', 'CCL21-0000310', 'active', 'Cultivation', 'Highland Springs Rd', 'Cultivation - Medium Outdoor', 'Lake', 'BG Property Management, LLC', '9200 Highland Springs Road, Unincorporated, CA 95453', false),
  (4925, 'CCL21-0000309', 'CCL21-0000309', 'active', 'Cultivation', 'Highland Springs Rd', 'Cultivation - Medium Outdoor', 'Lake', 'BG Property Management, LLC', '9200 Highland Springs Road, Unincorporated, CA 95453', false),
  (4924, 'CCL28-0000167', 'CCL25-0000167', 'active', 'Cultivation', 'Sulphur Bank Dr', 'Cultivation - Large Outdoor', 'Lake', 'All Good Properties, Inc.', '1111 Sulphur Bank Drive, Clearlake Oaks, CA 95423', false),
  (4923, 'CCL22-0001284', 'CCL22-0001284', 'active', 'Cultivation', 'Loasa Rd', 'Cultivation - Processor', 'Lake', '2CW Productions, Inc.', '4820 Loasa Rd, Kelseyville, CA 95451', false)
on conflict (facility_id) do nothing;

-- ── Canix yield forecasting ───────────────────────────────────────────────
-- Backs canix_inventory.html's "Forecasted Flower" view: an estimated
-- lbs/plant per farm, and a planned harvest date per farm. Forecast lbs for
-- a farm = (flowering_count summed across that farm's plant_batches, from
-- data/canix_plant_batches.json) x (that farm's most recent estimate as of
-- the planned harvest date). Same write posture as canix_facilities:
-- admin-only via netlify/functions/canix-forecast.js (reusing the same
-- admin PIN/token as admin.js and canix-facilities.js — no new secret),
-- anon read so the dashboard can show the forecast without its own login.
--
-- Estimates are a history, not a single overwritten value — "might change
-- per harvest" means the estimate used for a past forecast needs to stay
-- visible after a newer one is entered, e.g. for comparing forecast vs.
-- what Canix's own harvest records later show as the actual
-- average_plant_weight. Nothing here is ever updated in place; a new
-- estimate is a new row.

create table if not exists canix_yield_estimates (
  id                       uuid primary key default gen_random_uuid(),
  farm_group               text not null,      -- matches canix_facilities.farm_group
  estimated_lbs_per_plant  numeric not null check (estimated_lbs_per_plant > 0),
  effective_date           date not null default current_date,
  notes                    text,
  created_at               timestamptz not null default now()
);

create index if not exists idx_canix_yield_estimates_farm on canix_yield_estimates (farm_group, effective_date desc);

alter table canix_yield_estimates enable row level security;

drop policy if exists "anon read" on canix_yield_estimates;
create policy "anon read" on canix_yield_estimates for select using (true);

grant select, insert, update, delete on public.canix_yield_estimates to service_role;
grant select on public.canix_yield_estimates to anon;

-- Planned harvest date per farm. plant_count_override exists for planning
-- ahead of when Canix's own plant_batches data is trustworthy/populated for
-- a given season — leave null to use the live flowering_count sum instead.

create table if not exists canix_harvest_plans (
  id                     uuid primary key default gen_random_uuid(),
  farm_group             text not null,
  planned_harvest_date   date not null,
  plant_count_override   integer,
  status                 text not null default 'planned' check (status in ('planned', 'completed', 'canceled')),
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists idx_canix_harvest_plans_farm on canix_harvest_plans (farm_group, planned_harvest_date);

drop trigger if exists trg_touch_canix_harvest_plans on canix_harvest_plans;
create trigger trg_touch_canix_harvest_plans
  before update on canix_harvest_plans
  for each row execute function touch_operations_forms();

alter table canix_harvest_plans enable row level security;

drop policy if exists "anon read" on canix_harvest_plans;
create policy "anon read" on canix_harvest_plans for select using (true);

grant select, insert, update, delete on public.canix_harvest_plans to service_role;
grant select on public.canix_harvest_plans to anon;

-- ── Personal Tasks (My Tasks) ────────────────────────────────────────────
-- Backs my_tasks.html — one-on-one task delegation between people (assign
-- someone a task, they update status/notes/dates as they work it), as
-- opposed to the org-wide 30/60/90 gameplan in `tasks`/`task_subtasks`
-- above. Kept as its own table rather than folded into `tasks` so the
-- Gameplan Tracker's phase/track/CSV-import machinery stays untouched by
-- day-to-day task assignment between coworkers. Same open posture as
-- tasks/responsibilities: visibility is gated by the 'my_tasks' hub card
-- (toggled per person in admin.html), and the table itself stays open to
-- anon read/write since there's nothing here more sensitive than what's
-- already on the Ops Gameplan Tracker. `assignee` is who the task is for
-- (matched against sessionStorage's login name, same string-match approach
-- as `responsibilities.owner`); `assigned_by` is who created it, for the
-- "tasks I handed out" view.

create table if not exists personal_tasks (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  description    text,
  assignee       text,          -- deprecated single-owner column, kept for history — see `assignees` below
  assignees      text[] not null default '{}',  -- one task can have several owners; a shared status/notes thread (see personal_task_notes) rather than one row per person
  assigned_by    text,
  status         text not null default 'not_started' check (status in ('not_started', 'in_progress', 'blocked', 'done')),
  priority       text check (priority in ('low', 'medium', 'high')),
  due_date       date,
  follow_up_date date,
  completed_at   timestamptz,   -- auto-set/cleared by trigger below on every status change into/out of 'done' — powers "days to complete" on task_oversight.html
  link_url       text,          -- optional outside reference — Google Sheet, Smartsheet, source email, anything — shown as a link, never validated/fetched
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Added after the table's first release — `create table if not exists`
-- above won't retrofit a new column onto an already-existing table, so this
-- runs separately and is safe to re-run.
alter table personal_tasks add column if not exists completed_at timestamptz;
alter table personal_tasks add column if not exists link_url text;

-- Multi-assignee migration: add the array column, backfill it from the old
-- single-value `assignee` for any row that predates this (the `assignees is
-- null or '{}'` guard makes this idempotent — re-running never clobbers an
-- assignees list someone's already edited), then relax `assignee` from
-- not-null to nullable now that it's no longer the source of truth. The
-- column itself isn't dropped, so nothing that still reads it breaks.
alter table personal_tasks add column if not exists assignees text[] not null default '{}';
update personal_tasks set assignees = array[assignee]
  where assignee is not null and (assignees is null or assignees = '{}');
alter table personal_tasks alter column assignee drop not null;

create index if not exists idx_personal_tasks_assignees on personal_tasks using gin (assignees);
create index if not exists idx_personal_tasks_status on personal_tasks (status);

drop trigger if exists trg_touch_personal_tasks on personal_tasks;
create trigger trg_touch_personal_tasks
  before update on personal_tasks
  for each row execute function touch_operations_forms();

-- Tracks completion at the database level rather than trusting the app to
-- set it — every writer (my_tasks.html's status dot, the editor modal,
-- task_oversight.html) goes through the same `update ... set status = ...`,
-- so this is the one place completed_at can't get missed or double-set.
-- Clears itself if a task gets reopened, so "done" always means "done now."
create or replace function touch_personal_task_completion() returns trigger as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' then
    new.completed_at = now();
  elsif new.status <> 'done' and old.status = 'done' then
    new.completed_at = null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_personal_tasks_completion on personal_tasks;
create trigger trg_personal_tasks_completion
  before update on personal_tasks
  for each row execute function touch_personal_task_completion();

alter table personal_tasks enable row level security;

drop policy if exists "anon read" on personal_tasks;
create policy "anon read" on personal_tasks for select using (true);
drop policy if exists "anon write" on personal_tasks;
create policy "anon write" on personal_tasks for insert with check (true);
drop policy if exists "anon update" on personal_tasks;
create policy "anon update" on personal_tasks for update using (true) with check (true);
drop policy if exists "anon delete" on personal_tasks;
create policy "anon delete" on personal_tasks for delete using (true);

grant select, insert, update, delete on public.personal_tasks to anon;

-- Notes are a running log (not a single overwritten field like
-- responsibilities.notes) — every status update, follow-up, or comment gets
-- its own timestamped row, since the point of "create notes" here is a
-- visible history for whoever's following up, not just the latest note.
-- `kind` separates a person's own note ('note') from an automatic entry the
-- app writes on every status change ('system', e.g. "Status: Not started ->
-- In progress") — together these make the log double as the activity trail
-- task_oversight.html shows per task, with no separate audit table needed.
create table if not exists personal_task_notes (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references personal_tasks(id) on delete cascade,
  author      text,
  note        text not null,
  kind        text not null default 'note' check (kind in ('note', 'system')),
  created_at  timestamptz not null default now()
);

-- Added after the table's first release — safe to re-run.
alter table personal_task_notes add column if not exists kind text not null default 'note';
alter table personal_task_notes drop constraint if exists personal_task_notes_kind_check;
alter table personal_task_notes add constraint personal_task_notes_kind_check check (kind in ('note', 'system'));

create index if not exists idx_personal_task_notes_task on personal_task_notes (task_id, created_at);

alter table personal_task_notes enable row level security;

drop policy if exists "anon read" on personal_task_notes;
create policy "anon read" on personal_task_notes for select using (true);
drop policy if exists "anon write" on personal_task_notes;
create policy "anon write" on personal_task_notes for insert with check (true);
drop policy if exists "anon delete" on personal_task_notes;
create policy "anon delete" on personal_task_notes for delete using (true);

grant select, insert, delete on public.personal_task_notes to anon;

-- ── Pre-roll plans (preroll_dashboard.html) ─────────────────────────────
-- The pre-roll team's plan for each pre-roll production request. The
-- requests themselves stay in the Production Requests Google Sheet (read
-- live by the dashboard); this table only holds what the team adds on top,
-- one row per PR#: which strain goes in, and when they expect to start and
-- finish. Progress isn't stored here — the dashboard reads it from the
-- Pre-Roll Production forms (operations_forms, station preroll_production)
-- whose prNum field names the request. Same open anon posture as tasks:
-- nothing here is more sensitive than operations_forms.

create table if not exists preroll_plans (
  pr_num         text primary key,
  strain         text,
  source_uid     text,
  est_start      date,
  est_completion date,
  assigned_to    text,
  on_hold        boolean not null default false,
  notes          text,
  updated_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

drop trigger if exists trg_touch_preroll_plans on preroll_plans;
create trigger trg_touch_preroll_plans
  before update on preroll_plans
  for each row execute function touch_operations_forms();

alter table preroll_plans enable row level security;

drop policy if exists "anon read" on preroll_plans;
create policy "anon read" on preroll_plans for select using (true);
drop policy if exists "anon write" on preroll_plans;
create policy "anon write" on preroll_plans for insert with check (true);
drop policy if exists "anon update" on preroll_plans;
create policy "anon update" on preroll_plans for update using (true) with check (true);
drop policy if exists "anon delete" on preroll_plans;
create policy "anon delete" on preroll_plans for delete using (true);

grant select, insert, update, delete on public.preroll_plans to anon;

-- ── Drying schedule (drying_schedule.html) ───────────────────────────────
-- Outside clients whose wet material we take in to dry. One row per planned
-- intake: who it's from (farm, license, contact), how big the farm is, and
-- when and how much we expect to receive. A farm coming back next season
-- gets a new row; the page offers to copy the farm details from its last
-- one. Same open anon posture as preroll_plans.

create table if not exists drying_intakes (
  id              uuid primary key default gen_random_uuid(),
  farm_name       text not null,
  license_number  text,
  contact_name    text,
  contact_phone   text,
  contact_email   text,
  farm_size       numeric,
  farm_size_unit  text not null default 'sq ft',   -- 'sq ft' | 'acres' | 'plants'
  strains         text,
  est_start       date,
  est_end         date,
  est_wet_lb      numeric,
  status          text not null default 'tentative',
                  -- tentative | confirmed | receiving | complete | cancelled
  notes           text,
  created_by      text,
  updated_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_drying_intakes_start on drying_intakes (est_start);

drop trigger if exists trg_touch_drying_intakes on drying_intakes;
create trigger trg_touch_drying_intakes
  before update on drying_intakes
  for each row execute function touch_operations_forms();

alter table drying_intakes enable row level security;

drop policy if exists "anon read" on drying_intakes;
create policy "anon read" on drying_intakes for select using (true);
drop policy if exists "anon write" on drying_intakes;
create policy "anon write" on drying_intakes for insert with check (true);
drop policy if exists "anon update" on drying_intakes;
create policy "anon update" on drying_intakes for update using (true) with check (true);
drop policy if exists "anon delete" on drying_intakes;
create policy "anon delete" on drying_intakes for delete using (true);

grant select, insert, update, delete on public.drying_intakes to anon;
-- netlify/functions/drying-request.js (the public client form) inserts with
-- the service-role key, which this project doesn't grant on new tables by
-- default — without this the insert is refused.
grant select, insert, update, delete on public.drying_intakes to service_role;

-- Drying schedule v2: a client's season can have several harvest windows
-- (e.g. Oct 7 for 3 days, then Oct 17 for 3 days), the services they want
-- from the 2026 pricing sheet, and the dates/crew size for farm support.
--   harvests      [{ "start": "2026-10-07", "days": 3, "lb": 12000 }, …]
--                 lb is optional per window; est_wet_lb stays the client's
--                 total, spread over the windows without their own lb.
--   services      service keys, e.g. {drying,farm_labor,machine_trim} —
--                 the list lives in drying_schedule.html (SERVICES).
--   farm_support  [{ "start": "2026-10-06", "days": 2, "people": 4 }, …]
-- est_start/est_end are kept up to date by the page as the first harvest's
-- start and the last one's end, so ordering by est_start still works.
-- Rows from v1 get their single start/end turned into one harvest window;
-- the guard means a re-run never touches rows the page has saved since.
alter table drying_intakes add column if not exists harvests jsonb not null default '[]';
alter table drying_intakes add column if not exists services text[] not null default '{drying}';
alter table drying_intakes add column if not exists farm_support jsonb not null default '[]';

update drying_intakes
   set harvests = jsonb_build_array(jsonb_build_object(
         'start', coalesce(est_start, est_end),
         'days',  greatest(1, coalesce(est_end, est_start) - coalesce(est_start, est_end) + 1)))
 where harvests = '[]'::jsonb and coalesce(est_start, est_end) is not null;

-- ── PIDs & CIDs (admin panel "PIDs & CIDs" tab) ─────────────────────────────
-- Property IDs (farm properties) and Customer IDs, with a name and notes for
-- each. The station forms' PID and CID dropdowns read the active rows (see
-- loadReference in ops_common.js); data/operations/reference.json's
-- `properties` list is only the fallback when Supabase can't be reached.
-- Same open anon posture as `responsibilities` — the admin PIN gate is what
-- keeps people out of the editor.
create table if not exists ref_codes (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('pid', 'cid')),
  code        text not null,          -- e.g. '027' — what the forms store
  name        text,                   -- farm/property or customer name
  notes       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists idx_ref_codes_kind_code on ref_codes (kind, code);

drop trigger if exists trg_touch_ref_codes on ref_codes;
create trigger trg_touch_ref_codes
  before update on ref_codes
  for each row execute function touch_operations_forms();

alter table ref_codes enable row level security;
drop policy if exists "anon read" on ref_codes;
create policy "anon read" on ref_codes for select using (true);
drop policy if exists "anon write" on ref_codes;
create policy "anon write" on ref_codes for insert with check (true);
drop policy if exists "anon update" on ref_codes;
create policy "anon update" on ref_codes for update using (true) with check (true);
drop policy if exists "anon delete" on ref_codes;
create policy "anon delete" on ref_codes for delete using (true);
grant select, insert, update, delete on public.ref_codes to anon;

-- Seed with the PIDs that were in reference.json; a re-run leaves edits alone.
insert into ref_codes (kind, code, name) values
  ('pid', '027', 'Comstock'),
  ('pid', '309', 'Highland Springs Rd'),
  ('pid', '310', 'Highland Springs Rd'),
  ('pid', '540', 'Highland Springs Rd'),
  ('pid', '071', 'Lucern'),
  ('pid', '073', 'Lucern'),
  ('pid', '075', 'Lucern'),
  ('pid', '167', 'Sulphur Bank'),
  ('pid', '179', 'Wildcat'),
  ('pid', '180', 'Wildcat'),
  ('pid', '181', 'Wildcat'),
  ('pid', '182', 'Wildcat'),
  ('pid', '183', 'Wildcat')
on conflict (kind, code) do nothing;

-- ── Strain Library (strain_library.html) ────────────────────────────────────
-- The strain list every station form's Strain dropdown offers (see
-- loadReference in ops_common.js); data/operations/reference.json's
-- `strains` list is only the fallback when Supabase can't be reached.
-- `name` is exactly what the forms store, so renaming one doesn't touch
-- records already submitted under the old name — keep the old spelling in
-- `aliases`. Inactive strains stay in the library but drop off the
-- dropdowns. Who can open or edit the page is set per user in the admin
-- panel (app_users.columns 'strain_library' / 'strain library edit'); the
-- table itself has the same open anon posture as ref_codes.
create table if not exists strains (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  sources     text[] not null default '{}',   -- Genetics ID(s), e.g. CUS, HVN
  dominance   text,                       -- indica | indica_hybrid | hybrid | sativa_hybrid | sativa
  aliases     text[] not null default '{}',   -- other spellings seen in old records
  notes       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists idx_strains_name on strains (lower(name));
-- Added after the table's first version — a no-op on a fresh install.
alter table strains add column if not exists dominance text;
alter table strains add column if not exists abbreviation text;   -- short code, usually 2–4 letters, e.g. LCG

drop trigger if exists trg_touch_strains on strains;
create trigger trg_touch_strains
  before update on strains
  for each row execute function touch_operations_forms();

alter table strains enable row level security;
drop policy if exists "anon read" on strains;
create policy "anon read" on strains for select using (true);
drop policy if exists "anon write" on strains;
create policy "anon write" on strains for insert with check (true);
drop policy if exists "anon update" on strains;
create policy "anon update" on strains for update using (true) with check (true);
drop policy if exists "anon delete" on strains;
create policy "anon delete" on strains for delete using (true);
grant select, insert, update, delete on public.strains to anon;

-- Seed with the strains that were in reference.json; a re-run leaves edits alone.
insert into strains (name, sources, aliases, active) values
  ('Applescotti', array['CUS'], array['Applescotti [CUS]'], true),
  ('Banana Punch', array['HVN'], array['Banana Punch [HVN]'], true),
  ('Black Maple Zuava', array['RC'], array['Black Maple Zuava [RC]'], true),
  ('Blue Nerdz', '{}', array['Blue Nerds'], true),
  ('Blue Taffeze', array['CUS'], array['Blue Taffeze [CUS]'], true),
  ('Blue Z', '{}', '{}', true),
  ('Galactic Warheadz', array['PH'], array['Galactic Warheadz [PH]'], true),
  ('Gelato 33', array['RC'], array['Gelato 33 [RC]'], true),
  ('Gelato Pop', '{}', '{}', true),
  ('Glitter Bomb', array['PH'], array['Glitter Bomb [PH]'], true),
  ('Grape Gas', '{}', array['Grape Gas - AF'], true),
  ('Guava Tart', '{}', '{}', true),
  ('Hashburger', '{}', '{}', true),
  ('High Society 132', array['PH'], array['High Society 132 [PH]'], true),
  ('Ice Cream Pie', '{}', array['Ice cream pie'], true),
  ('It''z Pluto', '{}', array['It''z Pluto - AF', 'Itz Pluto'], true),
  ('Kept Secret', '{}', '{}', true),
  ('Lemon Cherry Gelato', array['RC'], array['Lemon Cherry Gelato - AF', 'Lemon Cherry Gelato 2', 'Lemon Cherry Gelato [RC]'], true),
  ('Mad Fruit', '{}', '{}', true),
  ('Mule Fuel', array['HVN'], array['Mule Fuel [HVN]'], true),
  ('Nimbus Snacks', array['CUS'], array['Nimbus Snacks [CUS]'], true),
  ('Pack Mule #3', array['HVN'], array['Pack Mule #3 [HVN]'], true),
  ('Pack Mule #4', array['HVN'], array['Pack Mule #4 [HVN]'], true),
  ('Papaya', '{}', '{}', true),
  ('Peanut Butter Breath', '{}', '{}', true),
  ('Permanent Marker', array['HVN'], array['Permanent Marker [HVN]'], true),
  ('Pink Certs', array['HVN'], array['Pink Certs [HVN]'], true),
  ('Pinyatti', array['CUS'], array['Pinyatti [CUS]'], true),
  ('Ron Burgandy', array['CUS'], array['Ron Burgandy [CUS]'], true),
  ('Runtz', '{}', '{}', true),
  ('Super Buff Cherry', array['HVN'], array['Super Bluff Cherry', 'Super Buff Cherry [HVN]'], true),
  ('Super Runtz', array['PH'], array['Super Runtz [PH]'], true),
  ('Tahiti Twist', '{}', '{}', true),
  ('Total Eclipse', array['PH'], array['Total Eclipse [PH]'], true),
  ('Wedding Cake', '{}', '{}', true),
  ('White Runtz', '{}', array['White Runtz - AF'], true),
  ('Wimbledon', '{}', '{}', true),
  ('ZClair', array['PH'], array['ZClair [PH]'], true),
  ('Zoap', array['PH'], array['Zoap - AF', 'Zoap [PH]'], true)
on conflict ((lower(name))) do nothing;
