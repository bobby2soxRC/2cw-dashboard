// Labor cost per Pre-Roll Production run, for the Pre-Roll Dashboard
// (preroll_dashboard.html). Rates are pay, so the labor_rates table has no
// anon access; this works the costs out here and hands back only each run's
// totals — never a rate — and only to someone whose app_users row has
// 'preroll costs' ticked (admin panel → user editor → Special access),
// looked up from the PIN they logged in with, like labor-rates.js.
//
// Pre-Roll runs from before October 2026 have a Workforce Log of hours
// (fields.crew; the form now only confirms who's there) and are costed from
// it: each row's hours at the
// rate in effect on its work date (OpsAnalytics.rateFor, the Labor Log's
// lookup). Rates are keyed by Connecteam user id and the form logs badge
// numbers, so each badge goes through employee_badges (admin panel → Labor
// Rates → Badge #) to its person first. Badges nobody has mapped, and people
// without their own rate, fall to the '*' default — `defaultHours` says how
// many hours did.
//
// A run on a Master Schedule project (fields.project, picked on the form —
// or fields.projectDays, a project per day of the run) is costed from the
// Labor Log instead: the hours logged to its project(s), split over each
// project's UIDs by pounds (OpsAnalytics.laborAllocations, the same
// split the Labor Log's By lot shows), counting the share that lands on the
// run's source UID. Its Workforce Log isn't counted then, so nothing is
// costed twice. Those runs come back with `source: 'project'`.
//
// POST {pin} -> {ok, runs: [{id, cost, hours, defaultHours, unratedHours, source}]}
//
// Required env vars (Netlify site config), same as admin.js:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const OpsAnalytics = require('../../ops_analytics.js');
const { OPERATIONS_STATIONS } = require('../../operations_stations.js');

const COST_COL = 'preroll costs';

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function supaFetch(supaUrl, serviceKey, path) {
  return fetch(`${supaUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }
  });
}

// Hub login compares PINs zero-padded to 4 digits (index.html), so "0123"
// typed matches "123" stored — look up the same spellings here.
async function userForPin(supaUrl, serviceKey, pin) {
  const pad = (p) => p.padStart(4, '0');
  const target = pad(pin);
  const variants = [...new Set([pin, target, target.replace(/^0+(?=.)/, '')])]
    .map((p) => `"${p.replace(/["\\]/g, '')}"`).join(',');
  const res = await supaFetch(supaUrl, serviceKey,
    `app_users?pin=in.(${encodeURIComponent(variants)})&active=is.true&select=name,pin,columns`);
  if (!res.ok) throw new Error(`user lookup failed: ${res.status} ${await res.text()}`);
  return (await res.json()).find((u) => pad(String(u.pin)) === target) || null;
}

// Every row a query matches, a page at a time (PostgREST caps each response).
async function fetchAll(supaUrl, serviceKey, path) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await supaFetch(supaUrl, serviceKey, `${path}&order=id.asc&limit=1000&offset=${offset}`);
    if (!res.ok) throw new Error(`read failed: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
// operations_forms rows as ops_analytics expects them (flattenRecord in ops_data.js).
const flat = (row) => ({ ...(row.fields || {}), id: row.id, strain: row.strain || (row.fields || {}).strain,
                         date: row.work_date, submittedAt: row.submitted_at, stationKey: row.station_key });
const normUid = (u) => String(u || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Every project a run is on: its Project, plus each day's (projectDays).
const runProjects = (f) => [...new Set([f.project, ...Object.values(f.projectDays || {})].filter(Boolean))];

// Labor Log allocations for the projects pre-roll runs are on: the projects,
// the labor entries logged to them, and the station records whose pounds
// the hours are split by.
async function projectAllocations(supaUrl, serviceKey, projectIds, rates) {
  if (!projectIds.length) return [];
  const ids = projectIds.map((id) => `"${String(id).replace(/["\\]/g, '')}"`).join(',');
  const keys = OPERATIONS_STATIONS.map((st) => st.key).join(',');
  const [projects, entries, records] = await Promise.all([
    fetchAll(supaUrl, serviceKey, `operations_forms?station_key=eq.work_project&id=in.(${encodeURIComponent(ids)})&select=id,work_date,submitted_at,station_key,strain,fields`),
    fetchAll(supaUrl, serviceKey, `operations_forms?station_key=eq.labor_entry&status=eq.submitted&fields->>project=in.(${encodeURIComponent(ids)})&select=id,work_date,submitted_at,station_key,strain,fields`),
    fetchAll(supaUrl, serviceKey, `operations_forms?station_key=in.(${keys})&status=eq.submitted&select=id,work_date,submitted_at,station_key,strain,fields`)
  ]);
  const stages = { work_project: projects.map(flat), labor_entry: entries.map(flat) };
  OPERATIONS_STATIONS.forEach((st) => { stages[st.key] = []; });
  records.forEach((r) => { (stages[r.station_key] = stages[r.station_key] || []).push(flat(r)); });
  return OpsAnalytics.laborAllocations(stages, rates);
}

// A run's share of its project's Labor Log hours: the allocations on its
// source UID.
function projectRunCost(run, allocs, rates) {
  const f = run.fields || {};
  const uid = normUid(f.sourceUid);
  const pids = new Set(runProjects(f));
  const own = rates.filter((r) => r.employeeId !== '*');
  let cost = 0, hours = 0, defaultHours = 0, unratedHours = 0;
  allocs.forEach((a) => {
    if (!pids.has(a.project) || !uid || normUid(a.uid) !== uid || !(a.hours > 0)) return;
    hours += a.hours;
    if (a.cost == null) { unratedHours += a.hours; return; }
    if (OpsAnalytics.rateFor(own, a.employeeNo, a.date) == null) defaultHours += a.hours;
    cost += a.cost;
  });
  return { id: run.id, cost: round2(cost), hours: round2(hours), defaultHours: round2(defaultHours), unratedHours: round2(unratedHours), source: 'project' };
}

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };
const round2 = (x) => Math.round(x * 100) / 100;

function runCost(run, rates, badgeTo) {
  const f = run.fields || {};
  let cost = 0, hours = 0, defaultHours = 0, unratedHours = 0;
  (Array.isArray(f.crew) ? f.crew : []).forEach((c) => {
    const hrs = num(c.hours);
    if (!(hrs > 0)) return;
    hours += hrs;
    const emp = String(c.employeeNo || '').trim();
    const date = c.workDate || c.day || f.date || run.work_date;
    const person = emp ? badgeTo.get(OpsAnalytics.badgeKey(emp)) : null;
    const own = person ? OpsAnalytics.rateFor(rates.filter((r) => r.employeeId !== '*'), person, date) : null;
    const rate = own != null ? own : OpsAnalytics.rateFor(rates, '', date);
    if (rate == null) { unratedHours += hrs; return; }
    if (own == null) defaultHours += hrs;
    cost += hrs * rate;
  });
  return { id: run.id, cost: round2(cost), hours: round2(hours), defaultHours: round2(defaultHours), unratedHours: round2(unratedHours) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !serviceKey) return json(500, { ok: false, error: 'Server missing Supabase configuration' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }
  const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
  if (!pin) return json(401, { ok: false, error: 'Not logged in' });

  try {
    const user = await userForPin(supaUrl, serviceKey, pin);
    if (!user) return json(401, { ok: false, error: 'PIN not recognized — log in again.' });
    if (String((user.columns || {})[COST_COL] || '').toUpperCase() !== 'TRUE') {
      return json(403, { ok: false, error: 'You don’t have permission to see pre-roll costs.' });
    }
    const [ratesRes, runsRes, badgesRes] = await Promise.all([
      supaFetch(supaUrl, serviceKey, 'labor_rates?select=employee_id,rate,effective_from&order=effective_from.asc'),
      supaFetch(supaUrl, serviceKey, 'operations_forms?station_key=eq.preroll_production&select=id,work_date,fields'),
      supaFetch(supaUrl, serviceKey, 'employee_badges?select=badge_no,employee_id')
    ]);
    if (!ratesRes.ok) throw new Error(`rates read failed: ${ratesRes.status} ${await ratesRes.text()}`);
    if (!runsRes.ok) throw new Error(`runs read failed: ${runsRes.status} ${await runsRes.text()}`);
    const rates = (await ratesRes.json()).map((r) => ({ employeeId: String(r.employee_id), rate: Number(r.rate), from: r.effective_from }));
    // Until employee_badges exists every badge is unmapped (default rate).
    const badgeTo = new Map((badgesRes.ok ? await badgesRes.json() : [])
      .map((b) => [OpsAnalytics.badgeKey(b.badge_no), String(b.employee_id)]));
    const rows = await runsRes.json();
    const projectIds = [...new Set(rows.flatMap((r) => runProjects(r.fields || {})))];
    const allocs = await projectAllocations(supaUrl, serviceKey, projectIds, rates);
    const runs = rows.map((r) => (runProjects(r.fields || {}).length ? projectRunCost(r, allocs, rates) : runCost(r, rates, badgeTo)));
    return json(200, { ok: true, runs });
  } catch (err) {
    return json(502, { ok: false, error: String(err.message || err) });
  }
};
