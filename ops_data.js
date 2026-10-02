// ─────────────────────────────────────────────────────────────────────────────
// 2CW Operations — the Supabase-backed data layer for drafts and live data.
//
// This is what makes a form survive a tablet dying mid-shift: a draft isn't a
// value sitting in one browser's memory, it's a row in `operations_forms` with
// a stable id, autosaved as the operator types. Open that same id on a
// different tablet and the current values are there. A supervisor's "Today"
// board subscribes to the same table and sees edits land within a second or
// two, without polling.
//
// Falls back cleanly when config/supabase_config.js is still blank (fresh
// checkout, no project created yet): drafts/autosave/live-view are disabled,
// ops_form.html reverts to single-shot submit, and the dashboard reads the
// static data/operations/*.json files instead. Nothing throws either way —
// callers check `supabaseReady()` or just get an empty/queued result back.
// ─────────────────────────────────────────────────────────────────────────────

let _client = null;
let _clientTried = false;

function supabaseReady() {
  return typeof SUPABASE_URL === 'string' && SUPABASE_URL &&
         typeof SUPABASE_ANON_KEY === 'string' && SUPABASE_ANON_KEY;
}

// Lazy: the supabase-js UMD script only needs to load if a project is
// actually configured, so an unconfigured install doesn't pay for it.
function getClient() {
  if (_client || _clientTried) return _client;
  _clientTried = true;
  if (!supabaseReady() || typeof supabase === 'undefined') return null;
  _client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _client;
}

const TABLE = 'operations_forms';
const todayStr = () => new Date().toISOString().slice(0, 10);

// ── Drafts ──────────────────────────────────────────────────────────────────

// Every open (status='draft') form for this operator on this station today —
// the list that drives "your open forms" chips and the strain switcher.
async function listMyDrafts(stationKey, owner, date) {
  const client = getClient();
  if (!client || !owner) return [];
  const { data, error } = await client.from(TABLE).select('*')
    .eq('station_key', stationKey).eq('owner_user', owner)
    .eq('work_date', date || todayStr()).eq('status', 'draft')
    .order('updated_at', { ascending: false });
  if (error) { console.error('listMyDrafts', error); return []; }
  return data || [];
}

// Every open draft on a station, from anyone, any day — for stations whose
// batches run across several days (multiDay in operations_stations.js), so
// whoever picks the batch up tomorrow can find it.
async function listOpenDrafts(stationKey) {
  const client = getClient();
  if (!client) return [];
  const { data, error } = await client.from(TABLE).select('*')
    .eq('station_key', stationKey).eq('status', 'draft')
    .order('work_date', { ascending: false });
  if (error) { console.error('listOpenDrafts', error); return []; }
  return data || [];
}

// One draft by id, for `?draft=<id>` deep links (what makes cross-device
// resume work — the id is the only state that needs to travel).
async function getDraft(id) {
  const client = getClient();
  if (!client || !id) return null;
  const { data, error } = await client.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) { console.error('getDraft', error); return null; }
  return data;
}

// Upsert-on-id: the first call creates the row, every call after that is the
// autosave. `id` is generated client-side (crypto.randomUUID()) so the very
// first save already has the id the URL and the chips need.
async function saveDraft(id, { stationKey, owner, strain, date, fields }) {
  const client = getClient();
  if (!client) return { ok: false, reason: 'not-configured' };
  const { error } = await client.from(TABLE).upsert({
    id, station_key: stationKey, status: 'draft',
    owner_user: owner, updated_by: owner,
    strain: strain || null, work_date: date || todayStr(),
    fields
  });
  if (error) { console.error('saveDraft', error); return { ok: false, reason: error.message }; }
  return { ok: true };
}

// Flips a draft to submitted — the point where it stops being "in progress"
// and starts counting toward the dashboard's yield and biomass numbers.
async function submitDraft(id, { stationKey, owner, strain, date, fields }) {
  const client = getClient();
  if (!client) return { ok: false, reason: 'not-configured' };
  const { error } = await client.from(TABLE).upsert({
    id, station_key: stationKey, status: 'submitted',
    owner_user: owner, updated_by: owner,
    strain: strain || null, work_date: date || todayStr(),
    fields, submitted_at: new Date().toISOString()
  });
  if (error) { console.error('submitDraft', error); return { ok: false, reason: error.message }; }
  return { ok: true, id };
}

// Saves a correction to an already-submitted form (harvest_intakes.html →
// ops_form.html?edit=<id>). Only touches rows that are still 'submitted', so
// it can never turn a draft into a record or a record back into a draft;
// submitted_at and owner_user stay as they were.
async function updateSubmitted(id, { strain, date, fields, editor }) {
  const client = getClient();
  if (!client) return { ok: false, reason: 'not-configured' };
  const { data, error } = await client.from(TABLE).update({
    strain: strain || null, work_date: date || todayStr(), fields, updated_by: editor
  }).eq('id', id).eq('status', 'submitted').select('id');
  if (error) { console.error('updateSubmitted', error); return { ok: false, reason: error.message }; }
  if (!data || !data.length) return { ok: false, reason: 'Record not found.' };
  return { ok: true };
}

// Every form on one station, drafts and submitted, newest first — the list
// on harvest_intakes.html.
async function listStationForms(stationKey) {
  const client = getClient();
  if (!client) return null;
  const { data, error } = await client.from(TABLE).select('*')
    .eq('station_key', stationKey)
    .order('work_date', { ascending: false }).order('updated_at', { ascending: false });
  if (error) { console.error('listStationForms', error); return null; }
  return data || [];
}

async function deleteDraft(id) {
  const client = getClient();
  if (!client || !id) return;
  await client.from(TABLE).delete().eq('id', id).eq('status', 'draft');
}

// ── Live "Today" board ───────────────────────────────────────────────────────

// Every form touched today, draft and submitted, across every station —
// what a lead with view access sees. Filtered client-side to the stations
// they're allowed to view (station access stays app-enforced; see the RLS
// note in supabase/schema.sql).
async function listToday(date) {
  const client = getClient();
  if (!client) return [];
  const { data, error } = await client.from(TABLE).select('*')
    .eq('work_date', date || todayStr())
    .order('updated_at', { ascending: false });
  if (error) { console.error('listToday', error); return []; }
  return data || [];
}

// Pushes `onChange(row)` for every insert/update on today's forms. Returns an
// unsubscribe function. This is what makes the Today board "live" rather
// than "refreshes when you reload" — Supabase pushes the row the moment
// another tablet's autosave lands.
function subscribeToday(onChange) {
  const client = getClient();
  if (!client) return () => {};
  const channel = client.channel('operations_forms_today')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, (payload) => {
      onChange(payload.new || payload.old);
    })
    .subscribe();
  return () => client.removeChannel(channel);
}

// ── Finalized records for the dashboard/analytics ───────────────────────────

// Shapes a submitted row back into the flat {strain, date, ...fields} object
// ops_analytics.js has always consumed — so the analytics layer doesn't
// need to know Supabase exists.
function flattenRecord(row) {
  return {
    ...row.fields,
    id: row.id,
    strain: row.strain || row.fields.strain,
    date: row.work_date,
    submittedAt: row.submitted_at,
    stationKey: row.station_key
  };
}

// All submitted records for one station, shaped for ops_analytics.js. Falls
// back to the static JSON file when Supabase isn't configured yet, so the
// dashboard still works on a fresh checkout.
async function loadSubmitted(stationKey) {
  const client = getClient();
  if (!client) return loadJson(`/data/operations/${stationKey}.json`, []);
  const { data, error } = await client.from(TABLE).select('*')
    .eq('station_key', stationKey).eq('status', 'submitted')
    .order('submitted_at', { ascending: true });
  if (error) { console.error('loadSubmitted', error); return []; }
  return (data || []).map(flattenRecord);
}
