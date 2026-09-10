// One-off: seed the tasks / task_subtasks tables (tasks_dashboard.html) from
// the two sources the VP-of-Ops gameplan was built from:
//   1. The 30/60/90 plan itself (hardcoded below — it's a fixed, already-
//      reviewed document, not something that benefits from being re-parsed
//      out of the plan artifact every run).
//   2. data/planning/action_items_2026-09.csv, the original action-items
//      export the plan was built from.
//
// Every inserted row is tagged with `source` so this batch can be found and
// rolled back with one query if needed:
//   delete from tasks where source in ('30_60_90_plan', 'action_items_csv');
//
// Safe to re-run against an EMPTY tasks table. Re-running after tasks have
// already been edited in the dashboard will re-insert duplicates (there's no
// upsert-by-title here, unlike the in-app CSV importer) — this is meant to
// run once, right after the schema migration, before anyone starts editing.
//
// Requires: the `tasks` / `task_subtasks` tables already exist (run
// supabase/schema.sql's "Tasks (Ops Gameplan Tracker)" section first).
//
// Run: node scripts/seed_tasks.js

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const PLAN_DUE_DATES = { '0-30': '2026-10-16', '31-60': '2026-11-15', '61-90': '2026-12-15' };

function readSupabaseConfig() {
  const text = fs.readFileSync(path.join(ROOT, 'config', 'supabase_config.js'), 'utf8');
  const url = text.match(/SUPABASE_URL\s*=\s*'([^']*)'/)[1];
  const key = text.match(/SUPABASE_ANON_KEY\s*=\s*'([^']*)'/)[1];
  if (!url || !key) throw new Error('Supabase not configured in config/supabase_config.js');
  return { url, key };
}

function postJson(url, key, table, rows) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(rows);
    const u = new URL('/rest/v1/' + table, url);
    const req = https.request(u, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode });
        else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ── Proper CSV parser (handles quoted fields with embedded commas/newlines —
// the source CSV has at least one multi-line quoted "Results" cell) ────────
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).filter((r) => r.some((v) => v.trim())).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
    return obj;
  });
}

function statusFromCsv(raw) {
  const s = (raw || '').trim().toLowerCase();
  if (s === 'complete' || s === 'done') return 'done';
  if (s === 'in progress') return 'in_progress';
  if (s === 'unsure' || s === 'blocked') return 'blocked';
  return 'not_started';
}

function priorityFromCsv(raw) {
  const s = (raw || '').trim().toLowerCase();
  return ['high', 'medium', 'low'].includes(s) ? s : null;
}

function csvRowToTask(row) {
  const title = row['action item'];
  if (!title) return null;
  const context = [row['date'], row['meeting / source']].filter(Boolean).join(' · ');
  const notes = [context, row['results']].filter(Boolean).join(' — ') || null;
  return {
    title,
    description: row['description'] || null,
    source: 'action_items_csv',
    phase: null,
    track: null,
    status: statusFromCsv(row['status']),
    priority: priorityFromCsv(row['priority']),
    owner: row['responsible'] || null,
    requested_by: row['requested by'] || null,
    due_date: null,
    notes
  };
}

// ── The 30/60/90 plan, as reviewed with Ned ─────────────────────────────
// [phase, track, title, description]
const PLAN_ITEMS = [
  // Day 1–30
  ['0-30', 'compliance', 'Close the Adobe move', 'Material staged and transferred by the 15th (grace to 17th); DCC hold cleared before anything new comes in.'],
  ['0-30', 'compliance', 'Bartlett + Comstock/Sulfur Bank compliance', 'Final plant counts, remaining metric tags, pesticide records, and county inspection sign-off.'],
  ['0-30', 'compliance', '2CW bank account + Allgood wire', 'Finish setup so bills stop stacking up.'],
  ['0-30', 'compliance', 'Finalize the boilerplate processing contract', 'Needed within 3–4 weeks so new clients can be onboarded against the agreement and start paying a deposit.'],
  ['0-30', 'systems', 'Digital tracking fully replaces paper forms', 'Live in time for the October harvest — cultivation, processing, manufacturing, and inventory all running without paper.'],
  ['0-30', 'systems', 'Full Canix + ConnectTeam access → one dashboard', 'Move past sandbox; wire both into a single executive view.'],
  ['0-30', 'systems', 'Turn on iPad production forms at Adobe', 'App is built — flip it on station by station, backfill 8/24–present data.'],
  ['0-30', 'systems', 'One accountable owner per department', 'Intake/dry, bucking, machine trim, hand finish, pre-roll, packing, vape/concentrates.'],
  ['0-30', 'facilities', 'Scope Giffen build-out with Ned — starting immediately', 'Pantograph and equipment needs for Manufacturing/Processing/Nursery.'],
  ['0-30', 'facilities', 'Start the license paperwork', 'Inventory equipment worth moving from Artemis/Adobe; open the application.'],
  ['0-30', 'facilities', 'Lock Oct 5 / Oct 10 harvest logistics', 'Trucks, Class A driver, and a 480V generator for freezer transport.'],
  ['0-30', 'facilities', 'Consolidate packaging into one location', 'Standalone cleanup — scattered boxes/tubes into a single known spot, not tied to any event.'],
  ['0-30', 'facilities', 'Confirm total drying capacity at Kelseyville', 'Nail down what the facility can actually run per cycle before committing it to clients.'],
  ['0-30', 'facilities', "Confirm forecasts with last year's dry/process clients", 'Check in with the farms 2CW dried and processed for last season on 2026 volume and renewal plans.'],
  ['0-30', 'facilities', 'Sell the remaining Kelseyville capacity', "Line up additional processing clients to fill whatever isn't already spoken for."],
  ['0-30', 'facilities', "Train on Dennis' pre-roll machine, Sebastopol — this week", 'Get one of our own team members up to speed and producing there.'],
  ['0-30', 'people', 'Finalize your own VP scope + comp', 'Responsibilities doc/MSA and the 1099-vs-payroll call with Ned/Sheree.'],
  ['0-30', 'people', 'Meet with Autumn on all her roles', "In-person, next week — she's leaving; work through succession for everything she owns, not just compliance/CRO."],
  ['0-30', 'people', 'Network trade show, Sep 23–24', 'Banners and logos ready for load-in.'],
  ['0-30', 'people', 'Launch ground flower pouches', 'New SKU live within the first 30 days.'],

  // Day 31–60
  ['31-60', 'systems', 'Batch-level COGS rollup, every product line', 'Drying → bucking → trim → pack cost flows into one figure per batch — flower, pre-rolls, vape, and concentrates, not just pre-rolls.'],
  ['31-60', 'systems', 'Packaging/hardware inventory at Airway', 'Boxes, cartridges, and expendables tracked and deducted against real usage.'],
  ['31-60', 'systems', 'Production-request workflow fully onboarded', 'Low-supply SKU flag → auto-generated request → processing confirmation, with Yali trained.'],
  ['31-60', 'facilities', 'Giffen landlord improvements underway', 'Build-out running alongside the license process, targeting an equipment move-in of December or January.'],
  ['31-60', 'facilities', 'Santa Rosa nursery space planned', 'Mother-stock indoor nursery laid out alongside manufacturing and distro.'],
  ['31-60', 'facilities', 'Distribution stood up as its own entity', "Separately owned from Ned, operated in-house — packs and completes COAs for Giffen's finished goods."],
  ['31-60', 'facilities', 'Preventative maintenance program live', 'Asset list, equipment startup checklists, Mobius cleaning cadence enforced.'],
  ['31-60', 'compliance', 'Environmental controls (phase 1)', 'Ammonia lines swapped to glycol, freezer container fixed. Automated night-air cooling holds until Spring 2027.'],
  ['31-60', 'people', 'Trimmer/bucker scoreboard running', 'Daily ranking by pounds and quality, bottom performers cycled out weekly.'],
  ['31-60', 'people', 'Staff each station proportionally to batch flow', 'Match headcount at intake, bucking, trim, and pack to the batches actually moving that day, so batches finish as they happen instead of backing up.'],
  ['31-60', 'people', 'Launch hash-infused pre-rolls, 10-pack', 'New SKU built on the Sebastopol pre-roll line.'],
  ['31-60', 'people', 'Launch Mendo Rosin Vapes', 'New SKU live in the second 30 days.'],

  // Day 61–90
  ['61-90', 'systems', 'First full quarter of batch cost data reviewed', 'Checked against the Soma Rosa Farms rate card to sanity-check real margins.'],
  ['61-90', 'facilities', 'Giffen on track for a Dec/Jan move-in', 'Landlord improvements complete or nearly complete; Manufacturing, Processing, and Nursery build-out ready for equipment.'],
  ['61-90', 'facilities', 'Kelseyville capacity plan drafted', 'The drying/processing facility is already owned — plan staffing and volume to run it at full capacity as farm output scales.'],
  ['61-90', 'compliance', 'SOPs refreshed, year-end compliance closed', "Sheree's notes incorporated; DCC, inspections, and contracts filed clean."],
  ['61-90', 'people', '2027 comp/KPI structure locked', "Robert's salary transition and Ned's own 30/60/90 both set for Jan 1."]
];

function planItemToTask([phase, track, title, description]) {
  return {
    title,
    description,
    source: '30_60_90_plan',
    phase,
    track,
    status: 'not_started',
    priority: null,
    owner: 'Robert',
    requested_by: null,
    due_date: PLAN_DUE_DATES[phase],
    notes: null
  };
}

async function main() {
  const { url, key } = readSupabaseConfig();

  const planTasks = PLAN_ITEMS.map(planItemToTask);

  const csvPath = path.join(ROOT, 'data', 'planning', 'action_items_2026-09.csv');
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const csvTasks = parseCsv(csvText).map(csvRowToTask).filter(Boolean);

  const all = [...planTasks, ...csvTasks];
  console.log(`Seeding ${all.length} tasks (${planTasks.length} from the 30/60/90 plan, ${csvTasks.length} from the action-items CSV)...`);

  let sent = 0;
  for (const batch of chunk(all, 20)) {
    await postJson(url, key, 'tasks', batch);
    sent += batch.length;
    console.log(`  ${sent}/${all.length} inserted`);
  }
  console.log('Done.');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
