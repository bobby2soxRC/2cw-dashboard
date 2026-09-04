// One-off: push the converted paper-form records (data/operations/{buck,hand_trim,
// machine_trim}.json, produced by convert_intake_csvs.js) into the live Supabase
// operations_forms table, so buck_station.html's Historical tab and
// operations_dashboard.html actually show them (both prefer live Supabase data over
// the local JSON fallback whenever config/supabase_config.js is filled in, which it is).
//
// Every inserted row is tagged owner_user='paper_import' (and updated_by too) so this
// whole batch can be found and rolled back with one query if needed:
//   delete from operations_forms where owner_user = 'paper_import';
//
// Run: node scripts/push_intake_to_supabase.js

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

function readSupabaseConfig() {
  const text = fs.readFileSync(path.join(ROOT, 'config', 'supabase_config.js'), 'utf8');
  const url = text.match(/SUPABASE_URL\s*=\s*'([^']*)'/)[1];
  const key = text.match(/SUPABASE_ANON_KEY\s*=\s*'([^']*)'/)[1];
  if (!url || !key) throw new Error('Supabase not configured in config/supabase_config.js');
  return { url, key };
}

function postJson(url, key, rows) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(rows);
    const u = new URL('/rest/v1/operations_forms', url);
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

function loadJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

const IMPORT_TAG = 'paper_import';
// PostgREST's bulk insert requires every object in one POST to have the same
// key set, so a missing date can't just be omitted (Postgres's own
// current_date default would handle it fine one row at a time, but not in a
// batch with rows that do have a date) -- fall back to today, same value the
// column default would have produced anyway.
const TODAY_STR = new Date().toISOString().slice(0, 10);

function buckRow(r) {
  return {
    id: crypto.randomUUID(),
    station_key: 'buck',
    status: 'submitted',
    owner_user: IMPORT_TAG,
    updated_by: IMPORT_TAG,
    strain: r.strain || null,
    work_date: r.date || TODAY_STR,
    submitted_at: r.date ? `${r.date}T12:00:00Z` : new Date().toISOString(),
    fields: {
      date: r.date || null,
      strain: r.strain || null,
      sourceUid: r.sourceUid || null,
      uidKey: r.uidKey || null,
      startingDryLb: r.startingDryLb,
      buckedFlowerLb: r.buckedFlowerLb,
      bigLeafLb: r.bigLeafLb,
      stemLb: r.stemLb,
      wasteLb: r.wasteLb,
      aTrimLb: r.aTrimLb,
      pidCustomer: r.pidCustomer || null,
      strainGrade: r.strainGrade || null,
      notes: r.notes || null,
      _reviewStatus: r._reviewStatus || null,
      _importTag: IMPORT_TAG
    }
  };
}

function trimRow(r) {
  return {
    id: crypto.randomUUID(),
    station_key: 'hand_trim',
    status: 'submitted',
    owner_user: IMPORT_TAG,
    updated_by: IMPORT_TAG,
    strain: r.strain || null,
    work_date: r.date || TODAY_STR,
    submitted_at: r.date ? `${r.date}T12:00:00Z` : new Date().toISOString(),
    fields: {
      date: r.date || null,
      strain: r.strain || null,
      sourceUid: r.sourceUid || null,
      uidKey: r.uidKey || null,
      trimStyle: r.trimStyle || null,
      startingBuckedLb: r.startingBuckedLb,
      finishedFlowerLb: r.finishedFlowerLb,
      totalGrams: r.totalGrams,
      smallsLb: r.smallsLb,
      sugarTrimLb: r.sugarTrimLb,
      wasteLb: r.wasteLb,
      kiefLb: r.kiefLb,
      notes: r.notes || null,
      _reviewStatus: r._reviewStatus || null,
      _importTag: IMPORT_TAG
    }
  };
}

function machTrimRow(r) {
  return {
    id: crypto.randomUUID(),
    station_key: 'machine_trim',
    status: 'submitted',
    owner_user: IMPORT_TAG,
    updated_by: IMPORT_TAG,
    strain: r.strain || null,
    work_date: r.date || TODAY_STR,
    submitted_at: r.date ? `${r.date}T12:00:00Z` : new Date().toISOString(),
    fields: {
      date: r.date || null,
      strain: r.strain || null,
      sourceUid: r.sourceUid || null,
      uidKey: r.uidKey || null,
      teamLead: r.teamLead || null,
      inputBuckedLb: r.inputBuckedLb,
      flowerALb: r.flowerALb,
      smallsBLb: r.smallsBLb,
      sugarTrimLb: r.sugarTrimLb,
      machineShakeLb: r.machineShakeLb,
      wasteLb: r.wasteLb,
      notes: r.notes || null,
      _reviewStatus: r._reviewStatus || null,
      _importTag: IMPORT_TAG
    }
  };
}

async function main() {
  const { url, key } = readSupabaseConfig();

  const buck = loadJson('data/operations/buck.json').map(buckRow);
  const trim = loadJson('data/operations/hand_trim.json').map(trimRow);
  const mach = loadJson('data/operations/machine_trim.json').map(machTrimRow);

  const all = [...buck, ...trim, ...mach];
  console.log(`Pushing ${all.length} rows (${buck.length} buck, ${trim.length} hand_trim, ${mach.length} machine_trim) tagged owner_user='${IMPORT_TAG}'...`);

  let sent = 0;
  for (const batch of chunk(all, 20)) {
    await postJson(url, key, batch);
    sent += batch.length;
    console.log(`  ${sent}/${all.length} inserted`);
  }
  console.log('Done.');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
