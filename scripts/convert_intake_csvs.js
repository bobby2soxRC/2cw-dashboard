// One-off: convert the hand-reviewed staging CSVs in data/operations/_intake_review/
// into the flat record shape data/operations/{buck,hand_trim,machine_trim}.json expect
// (see ops_fixture.js / ops_data.js loadJson fallback + operations_stations.js field lists).
// Run: node scripts/convert_intake_csvs.js

const fs = require('fs');
const path = require('path');

const REVIEW_DIR = path.join(__dirname, '..', 'data', 'operations', '_intake_review');
const OUT_DIR = path.join(__dirname, '..', 'data', 'operations');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
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
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (r[idx] || '').trim(); });
    return obj;
  });
}

// UID lineage rule (confirmed 2026-09-04): a Harvest UID becomes a NEW UID at
// drying, and that dry-batch UID is what Bucking and Trimming forms both write
// down — Bucking asks for "last 5", Trimming asks for "last 4", so the two
// numbers usually agree on their last 4 digits (leading zeros included) even
// though the forms show different lengths. Only at final sort does the batch
// split into brand-new UIDs per output material (A Flower, Smalls, A+/A/B
// Trim, Waste) — none of the paper forms transcribed so far capture those.
function uidKey(sourceUid) {
  const digits = (sourceUid || '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  return digits.slice(-4).padStart(4, '0');
}

function num(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

// Pull "Palo = 45 lbs" / "hoja piso = 0.98 lbs" / "Podrido = 0.3 lbs" out of a free-text
// manager-notes string. Handles "Palo-92 lbs", "Palo=45lbs", "Palo (stems) = 45 lbs", etc.
function extractNoted(text, keywords) {
  if (!text) return undefined;
  for (const kw of keywords) {
    const re = new RegExp(kw + '[^0-9\\-]*(-?\\d+(?:\\.\\d+)?)', 'i');
    const m = text.match(re);
    if (m) return parseFloat(m[1]);
  }
  return undefined;
}

function loadAll(prefix) {
  return fs.readdirSync(REVIEW_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.csv'))
    .sort()
    .flatMap((f) => {
      const rows = parseCsv(fs.readFileSync(path.join(REVIEW_DIR, f), 'utf8'));
      rows.forEach((r) => { r.__source_file = f; });
      return rows;
    });
}

let idCounter = 1;
const newId = (prefix) => `${prefix}_${String(idCounter++).padStart(4, '0')}`;

// ── Bucking → buck.json ──────────────────────────────────────────────────────
const buckRows = loadAll('bucking_');
const buckOut = buckRows
  .filter((r) => r.work_order_id && !/^DUPLICATE_FLAG/.test(r.work_order_id))
  .map((r) => {
    const stemLb = extractNoted(r.manager_notes, ['palo']);
    const bigLeafLb = extractNoted(r.manager_notes, ['hoja\\s*piso', 'piso']);
    const wasteLb = extractNoted(r.manager_notes, ['podrido']);
    return {
      id: newId('buck'),
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
      _reviewSource: r.__source_file
    };
  });

// ── Trimming → hand_trim.json ────────────────────────────────────────────────
const trimRows = loadAll('trimming_');
const trimOut = trimRows
  .filter((r) => r.work_order_id)
  .map((r) => {
    const podridoLb = extractNoted(r.notes, ['podrido']);
    return {
      id: newId('trim'),
      date: r.date || null,
      sourceUid: r.package_uid_last4 || null,
      uidKey: uidKey(r.package_uid_last4),
      strain: r.strain || null,
      trimStyle: r.hand_or_machine ? (/machine/i.test(r.hand_or_machine) ? 'machine_hand' : 'full_hand') : null,
      startingBuckedLb: num(r.starting_bucked_weight_lb) ?? null,
      finishedFlowerLb: num(r.finished_flower_lb) ?? null,
      totalGrams: num(r.finished_flower_grams) ?? null,
      smallsLb: num(r.smalls_lb) ?? null,
      sugarTrimLb: num(r.trim_lb) ?? null,
      wasteLb: podridoLb ?? null,
      kiefLb: num(r.kief_lb) ?? null,
      notes: [r.notes, r.qc_flag].filter(Boolean).join(' | ') || null,
      _reviewStatus: r.status || null,
      _reviewSource: r.__source_file
    };
  });

// ── Machine Trim → machine_trim.json ─────────────────────────────────────────
const machRows = loadAll('machine_trim_');
const machOut = machRows
  .filter((r) => r.work_order_id)
  .map((r) => ({
    id: newId('mtrim'),
    date: r.date || null,
    sourceUid: r.package_uid_last4 || null,
    uidKey: uidKey(r.package_uid_last4),
    strain: r.strain || null,
    teamLead: r.operator || null,
    inputBuckedLb: num(r.starting_weight_lb) ?? null,
    flowerALb: num(r.m_flower_output_lb) ?? null,
    smallsBLb: num(r.smalls_lb) ?? null,
    sugarTrimLb: num(r.sugar_lb) ?? null,
    machineShakeLb: num(r.shake_lb) ?? null,
    wasteLb: num(r.waste_lb) ?? null,
    notes: [r.notes, r.qc_flag].filter(Boolean).join(' | ') || null,
    _reviewStatus: r.status || null,
    _reviewSource: r.__source_file
  }));

fs.writeFileSync(path.join(OUT_DIR, 'buck.json'), JSON.stringify(buckOut, null, 2) + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'hand_trim.json'), JSON.stringify(trimOut, null, 2) + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'machine_trim.json'), JSON.stringify(machOut, null, 2) + '\n');

console.log(`buck.json: ${buckOut.length} records`);
console.log(`hand_trim.json: ${trimOut.length} records`);
console.log(`machine_trim.json: ${machOut.length} records`);
