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

// Every form on one station dated between two days (YYYY-MM-DD, inclusive),
// drafts and submitted — the daily summary for a station whose pages run
// over several days.
async function listStationRange(stationKey, fromDate, toDate) {
  const client = getClient();
  if (!client) return [];
  const { data, error } = await client.from(TABLE).select('*')
    .eq('station_key', stationKey).gte('work_date', fromDate).lte('work_date', toDate)
    .order('work_date', { ascending: false });
  if (error) { console.error('listStationRange', error); return []; }
  return data || [];
}

const shiftDate = (date, days) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

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

// Deletes an open (not yet submitted) page — e.g. a Bucking page started by
// mistake. The browser can't delete forms itself (no anon DELETE — see
// supabase/schema.sql), so this goes through operations-records.js, which
// checks the PIN and the person's edit access to the station, never deletes
// a submitted record, and logs who did it. code: 'submitted' | 'gone' |
// undefined (couldn't reach it, or not allowed — see error).
async function deleteOpenPage(stationKey, id) {
  try {
    const res = await fetch('/.netlify/functions/operations-records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_open', pin: sessionStorage.getItem('2cw_pin') || '', stationKey, id })
    });
    const data = await res.json().catch(() => ({}));
    return { ok: !!(res.ok && data.ok), code: data.code, error: data.error };
  } catch (e) {
    return { ok: false, error: null };
  }
}

// Like getDraft, but tells "it isn't there" ({ ok: true, row: null }) apart
// from "couldn't check" ({ ok: false }) — so a page can notice it was
// deleted on another tablet without mistaking a dropped connection for it.
async function checkDraft(id) {
  const client = getClient();
  if (!client || !id) return { ok: false };
  const { data, error } = await client.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) return { ok: false };
  return { ok: true, row: data || null };
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

// ── Trim cost split (Labor Log → Cost / lb) ─────────────────────────────────
// The % of a lot's trimmed cost that goes to A flower / Smalls / Trim
// (carryCost in ops_analytics.js). One shared setting, kept in a single
// operations_forms row (station_key 'cost_settings', fixed id) so it needs no
// table of its own; the edit history trigger logs each change. It's a
// business ratio, not pay, so the open anon access is fine here.
// ── Bucking queue (On-Stem Flower → the order to buck in) ─────────────────
// One shared operations_forms row (station_key 'buck_queue', fixed id), like
// the trim split below: `order` is the on-stem / part UIDs in the order a
// manager set. Anything not in it goes after, by Take Down date
// (orderBuckQueue in ops_common.js). Open anon access like the rest; the
// edit history trigger logs each change.
const BUCK_QUEUE_ID = '6275636b-7175-4000-8000-000000000001';
async function getBuckQueue() {
  const client = getClient();
  if (!client) return { order: [] };
  const { data } = await client.from(TABLE).select('fields').eq('id', BUCK_QUEUE_ID).maybeSingle();
  const f = (data && data.fields) || {};
  return { order: Array.isArray(f.order) ? f.order : [], updatedBy: f.updatedBy || '', updatedAt: f.updatedAt || '' };
}
async function saveBuckQueue(order, who) {
  const client = getClient();
  if (!client) return { ok: false, reason: 'not-configured' };
  const { error } = await client.from(TABLE).upsert({
    id: BUCK_QUEUE_ID, station_key: 'buck_queue', status: 'submitted', owner_user: who || null, updated_by: who || null,
    submitted_at: new Date().toISOString(),
    fields: { order, updatedBy: who || '', updatedAt: new Date().toISOString() }
  });
  return error ? { ok: false, reason: error.message } : { ok: true };
}

// The bucking queue as both pages show it: what's ready to buck, in queue
// order, each marked with the bucking page it's open on (`draftId`), if any,
// and the pounds pulled off it so far (`pulledLb`: the boxes logged on that
// page) and what's left (`leftLb`, from the starting weight `unbuckedLb`).
async function loadBuckingQueue() {
  const [downs, bucked, open, queue] = await Promise.all([
    loadSubmitted('dry_check'), loadSubmitted('buck'), listOpenDrafts('buck'), getBuckQueue()]);
  const drafts = (open || []).filter((d) => d.fields && d.fields.sourceUid);
  const items = orderBuckQueue(buckablePackages(downs || [], bucked || []), queue).map((p) => {
    const d = drafts.find((x) => uidTailMatch(x.fields.sourceUid, p.sourceUid));
    return withPulled(d ? { ...p, draftId: d.id } : p, d ? d.fields.boxes : []);
  });
  return { items, queue, downs: downs || [] };
}

// The trimming queue: one shared row like the bucking queue (station_key
// 'trim_queue', fixed id), `order` = bucked-lot UIDs in the order a manager
// set on the Work Orders page.
const TRIM_QUEUE_ID = '7472696d-7175-4000-8000-000000000001';
async function getTrimQueue() {
  const client = getClient();
  if (!client) return { order: [] };
  const { data } = await client.from(TABLE).select('fields').eq('id', TRIM_QUEUE_ID).maybeSingle();
  const f = (data && data.fields) || {};
  return { order: Array.isArray(f.order) ? f.order : [], updatedBy: f.updatedBy || '', updatedAt: f.updatedAt || '' };
}
async function saveTrimQueue(order, who) {
  const client = getClient();
  if (!client) return { ok: false, reason: 'not-configured' };
  const { error } = await client.from(TABLE).upsert({
    id: TRIM_QUEUE_ID, station_key: 'trim_queue', status: 'submitted', owner_user: who || null, updated_by: who || null,
    submitted_at: new Date().toISOString(),
    fields: { order, updatedBy: who || '', updatedAt: new Date().toISOString() }
  });
  return error ? { ok: false, reason: error.message } : { ok: true };
}

// The trimming queue as the Work Orders page and Hand Trim's Queue tab show
// it: every bucked lot (buckedLots — including ones still being bucked) with
// no submitted Hand Trim yet, in queue order, each marked with the Hand Trim
// page it's open on (`draftId`) and the finished flower weighed there so far
// (`trimmedLb`). `all` is every bucked lot, for Hand Trim's dropdown.
async function loadTrimQueue() {
  const [bucks, openBucks, downs, intakes, trimmed, openTrims, queue] = await Promise.all([
    loadSubmitted('buck'), listOpenDrafts('buck'), loadSubmitted('dry_check'), loadSubmitted('intake_wet'),
    loadSubmitted('hand_trim'), listOpenDrafts('hand_trim'), getTrimQueue()]);
  const all = buckedLots(bucks || [], downs || [], intakes || [], openBucks || []);
  const done = (trimmed || []).map((r) => r.sourceUid).filter(Boolean);
  const drafts = (openTrims || []).filter((d) => d.fields && d.fields.sourceUid);
  const items = orderTrimQueue(all.filter((l) => !done.some((u) => uidTailMatch(u, l.sourceUid))), queue).map((l) => {
    const d = drafts.find((x) => uidTailMatch(x.fields.sourceUid, l.sourceUid));
    return withTrimmed(d ? { ...l, draftId: d.id } : l, d ? d.fields.weights : []);
  });
  return { items, all, queue, openTrims: openTrims || [] };
}

// Finished flower weighed so far on a Hand Trim page (grams → lbs).
function withTrimmed(p, weights) {
  const g = (weights || []).reduce((a, r) => a + (Number(r.grams) || 0), 0);
  return { ...p, trimmedLb: Math.round(g / G_PER_LB * 100) / 100 };
}

// Pounds pulled so far (the bucking page's boxes) and what's left.
function withPulled(p, boxes) {
  const pulledLb = Math.round((boxes || []).reduce((a, r) => a + (Number(r.weightLb) || 0), 0) * 100) / 100;
  const leftLb = p.unbuckedLb == null ? null : Math.round((Number(p.unbuckedLb) - pulledLb) * 100) / 100;
  return { ...p, pulledLb, leftLb };
}

const COST_SETTINGS_ID = '636f7374-7370-4000-8000-000000000001';
async function getTrimSplit() {
  const client = getClient();
  const def = (typeof OpsAnalytics !== 'undefined' && OpsAnalytics.DEFAULT_TRIM_SPLIT) || { a: 70, smalls: 20, trim: 10 };
  if (!client) return { ...def };
  const { data } = await client.from(TABLE).select('fields').eq('id', COST_SETTINGS_ID).maybeSingle();
  const sp = data && data.fields && data.fields.trimSplit;
  return sp ? { a: Number(sp.a) || 0, smalls: Number(sp.smalls) || 0, trim: Number(sp.trim) || 0 } : { ...def };
}
async function saveTrimSplit(split, who) {
  const client = getClient();
  if (!client) return { ok: false, reason: 'not-configured' };
  const { data } = await client.from(TABLE).select('fields').eq('id', COST_SETTINGS_ID).maybeSingle();
  const { error } = await client.from(TABLE).upsert({
    id: COST_SETTINGS_ID, station_key: 'cost_settings', status: 'submitted', owner_user: who || null, updated_by: who || null,
    submitted_at: new Date().toISOString(), fields: { ...((data && data.fields) || {}), trimSplit: split, updatedBy: who || '' }
  });
  return error ? { ok: false, reason: error.message } : { ok: true };
}
