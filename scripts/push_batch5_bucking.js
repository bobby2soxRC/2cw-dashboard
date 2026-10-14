// One-off: convert + push ONLY data/operations/_intake_review/bucking_batch5_2026-09.csv
// (2 rows) into buck.json + Supabase, without touching the 54 records already
// pushed from earlier batches. Reuses the exact row-shape/extraction logic from
// convert_intake_csvs.js + push_intake_to_supabase.js, scoped to this one file.
// Run: node scripts/push_batch5_bucking.js

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CSV_PATH = path.join(ROOT, 'data', 'operations', '_intake_review', 'bucking_batch5_2026-09.csv');
const BUCK_JSON_PATH = path.join(ROOT, 'data', 'operations', 'buck.json');
const IMPORT_TAG = 'paper_import';

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
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
  const header = rows.shift();
  return rows.filter((r) => r.length > 1 || r[0]).map((r) => {
    const obj = {}; header.forEach((h, idx) => { obj[h] = (r[idx] || '').trim(); }); return obj;
  });
}

function num(v) { if (v === undefined || v === null || v === '') return undefined; const n = parseFloat(v); return Number.isFinite(n) ? n : undefined; }
function extractNoted(text, keywords) {
  if (!text) return undefined;
  for (const kw of keywords) {
    const m = text.match(new RegExp(kw + '[^0-9\\-]*(-?\\d+(?:\\.\\d+)?)', 'i'));
    if (m) return parseFloat(m[1]);
  }
  return undefined;
}
function uidKey(sourceUid) {
  const digits = (sourceUid || '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  return digits.slice(-4).padStart(4, '0');
}

const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
const TODAY_STR = new Date().toISOString().slice(0, 10);
let idCounter = 1;

const newRecords = rows.map((r) => {
  const stemLb = extractNoted(r.manager_notes, ['palo']);
  const bigLeafLb = extractNoted(r.manager_notes, ['hoja\\s*piso', 'piso']);
  const wasteLb = extractNoted(r.manager_notes, ['podrido']);
  return {
    id: `buck_batch5_${String(idCounter++).padStart(4, '0')}`,
    date: r.date || null,
    sourceUid: r.package_uid || null,
    uidKey: uidKey(r.package_uid),
    strain: r.strain || null,
    startingDryLb: num(r.actual_starting_weight_lb) ?? null,
    buckedFlowerLb: num(r.bucked_flower_page1_lb) ?? null,
    bigLeafLb: bigLeafLb ?? null,
    stemLb: stemLb ?? null,
    wasteLb: wasteLb ?? null,
    aTrimLb: num(r.trim_lb) ?? null,
    pidCustomer: r.pid_customer || null,
    strainGrade: r.strain_grade || null,
    notes: [r.manager_notes, r.qc_flag].filter(Boolean).join(' | ') || null,
    _reviewStatus: r.status || null,
    _reviewSource: 'bucking_batch5_2026-09.csv'
  };
});

// Append to the local buck.json mirror
const existing = JSON.parse(fs.readFileSync(BUCK_JSON_PATH, 'utf8'));
fs.writeFileSync(BUCK_JSON_PATH, JSON.stringify([...existing, ...newRecords], null, 2) + '\n');
console.log(`buck.json: appended ${newRecords.length} records (was ${existing.length}, now ${existing.length + newRecords.length})`);

// Push just these new rows to Supabase
function readSupabaseConfig() {
  const text = fs.readFileSync(path.join(ROOT, 'config', 'supabase_config.js'), 'utf8');
  const url = text.match(/SUPABASE_URL\s*=\s*'([^']*)'/)[1];
  const key = text.match(/SUPABASE_ANON_KEY\s*=\s*'([^']*)'/)[1];
  return { url, key };
}
function postJson(url, key, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL('/rest/v1/operations_forms', url);
    const req = https.request(u, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode }); else reject(new Error(`HTTP ${res.statusCode}: ${data}`)); });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

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
      date: r.date || null, strain: r.strain || null, sourceUid: r.sourceUid || null, uidKey: r.uidKey || null,
      startingDryLb: r.startingDryLb, buckedFlowerLb: r.buckedFlowerLb, bigLeafLb: r.bigLeafLb, stemLb: r.stemLb,
      wasteLb: r.wasteLb, aTrimLb: r.aTrimLb, pidCustomer: r.pidCustomer || null, strainGrade: r.strainGrade || null,
      notes: r.notes || null, _reviewStatus: r._reviewStatus || null, _importTag: IMPORT_TAG
    }
  };
}

async function main() {
  const { url, key } = readSupabaseConfig();
  const payload = newRecords.map(buckRow);
  await postJson(url, key, payload);
  console.log(`Supabase: pushed ${payload.length} new rows tagged owner_user='${IMPORT_TAG}'`);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
