// ─────────────────────────────────────────────────────────────────────────────
// Bucking — the event-sourced data layer behind buck_station.html.
//
// Reuses the same `production_forms` table and Supabase project as
// prod_data.js — no new schema — by giving Bucking its own station_key
// "namespace" instead of the one-record-per-work-order shape every other
// station uses:
//
//   buck_submission   insert-only. One row per scale trip: an employee
//                     weighing bucked flower off a batch/box. Never edited —
//                     this is the log the daily roster and history are built
//                     from.
//   buck_box          one row per (batch, box #), created on first use and
//                     PATCHED after — starting weight, waste, stems, big
//                     leaf, and A+/A/B trim get filled in at different times
//                     by different people. Writes are merged field-by-field
//                     (read, merge, write) so submitting one field never
//                     blanks out one someone already filled in.
//   buck_batch_close  insert-only marker: this batch is done. Also the
//                     moment a normal 'buck' station record gets written —
//                     the rolled-up totals from every submission/box against
//                     this batch — so machine_trim's prefill, the yield/
//                     variance calc, and the dashboard don't need to know
//                     any of this event-sourcing happened.
//
// A "batch" itself is never created here — it's whatever Post-Dry Check
// already produced (a 'pass' result). Bucking just watches for dry_check
// records that don't have a matching buck_batch_close yet.
// ─────────────────────────────────────────────────────────────────────────────

const BUCK_TABLE = 'production_forms';

function buckClient() {
  return typeof getClient === 'function' ? getClient() : null;
}

function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

// ── Open batches (dry_check 'pass' records not yet closed) ─────────────────

async function listOpenBatches() {
  const client = buckClient();
  if (!client) return [];

  const [{ data: passed, error: e1 }, { data: closed, error: e2 }] = await Promise.all([
    client.from(BUCK_TABLE).select('*')
      .eq('station_key', 'dry_check').eq('status', 'submitted').eq('fields->>result', 'pass')
      .order('submitted_at', { ascending: false }),
    client.from(BUCK_TABLE).select('fields')
      .eq('station_key', 'buck_batch_close').eq('status', 'submitted')
  ]);
  if (e1 || e2) { console.error('listOpenBatches', e1 || e2); return []; }

  const closedUids = new Set((closed || []).map((r) => String(r.fields.batchUid || '').toUpperCase()));
  const byUid = new Map();
  (passed || []).forEach((r) => {
    const uid = String(r.fields.sourceUid || '').toUpperCase();
    if (!uid || closedUids.has(uid)) return;
    if (byUid.has(uid)) return; // most-recent dry_check record wins (already ordered desc)
    byUid.set(uid, {
      uid: r.fields.sourceUid,
      strain: r.fields.strain || '',
      dryWeightLb: r.fields.dryWeightLb || null,
      openedDate: r.work_date
    });
  });
  return [...byUid.values()].sort((a, b) => (a.strain || '').localeCompare(b.strain || ''));
}

// ── Submissions (insert-only) ───────────────────────────────────────────────

async function logBuckSubmission({ batchUid, batchStrain, boxNo, employeeNo, weightLb, owner }) {
  const client = buckClient();
  if (!client) return { ok: false, reason: 'not-configured' };
  const now = new Date().toISOString();
  const row = {
    id: newId(), station_key: 'buck_submission', status: 'submitted',
    owner_user: owner || null, updated_by: owner || null,
    strain: batchStrain || null, work_date: now.slice(0, 10),
    submitted_at: now,
    fields: { batchUid, boxNo: boxNo || null, employeeNo: String(employeeNo || '').trim(), weightLb: Number(weightLb) }
  };
  const { error } = await client.from(BUCK_TABLE).insert(row);
  if (error) { console.error('logBuckSubmission', error); return { ok: false, reason: error.message }; }
  return { ok: true, row };
}

async function listSubmissions({ batchUid, date, employeeNo } = {}) {
  const client = buckClient();
  if (!client) return [];
  let q = client.from(BUCK_TABLE).select('*').eq('station_key', 'buck_submission').eq('status', 'submitted');
  if (batchUid) q = q.eq('fields->>batchUid', batchUid);
  if (date) q = q.eq('work_date', date);
  if (employeeNo) q = q.eq('fields->>employeeNo', String(employeeNo).trim());
  const { data, error } = await q.order('submitted_at', { ascending: false });
  if (error) { console.error('listSubmissions', error); return []; }
  return data || [];
}

// Pushes onChange(row) for every new submission — what makes the Today
// roster update live as other tablets log weight, the same idea as
// prod_data.js's subscribeToday.
function subscribeBuckSubmissions(onChange) {
  const client = buckClient();
  if (!client) return () => {};
  const channel = client.channel('buck_submissions')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: BUCK_TABLE, filter: 'station_key=eq.buck_submission' },
      (payload) => onChange(payload.new))
    .subscribe();
  return () => client.removeChannel(channel);
}

// ── Boxes (merge-write — never let a partial save blank out earlier fields) ─

async function getBuckBox(batchUid, boxNo) {
  const client = buckClient();
  if (!client) return null;
  const { data, error } = await client.from(BUCK_TABLE).select('*')
    .eq('station_key', 'buck_box').eq('fields->>batchUid', batchUid).eq('fields->>boxNo', String(boxNo))
    .maybeSingle();
  if (error) { console.error('getBuckBox', error); return null; }
  return data;
}

async function listBuckBoxes(batchUid) {
  const client = buckClient();
  if (!client) return [];
  const { data, error } = await client.from(BUCK_TABLE).select('*')
    .eq('station_key', 'buck_box').eq('fields->>batchUid', batchUid)
    .order('fields->>boxNo', { ascending: true });
  if (error) { console.error('listBuckBoxes', error); return []; }
  return data || [];
}

// Only the keys present in `partial` are changed — undefined/missing keys
// keep whatever was already saved. This is what lets someone submit just the
// starting weight now and come back for stems later without wiping it out.
async function saveBuckBoxFields(batchUid, boxNo, partial, owner) {
  const client = buckClient();
  if (!client) return { ok: false, reason: 'not-configured' };
  const existing = await getBuckBox(batchUid, boxNo);
  const mergedFields = { ...(existing ? existing.fields : { batchUid, boxNo: String(boxNo) }) };
  Object.entries(partial).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') mergedFields[k] = v;
  });
  const row = {
    id: existing ? existing.id : newId(), station_key: 'buck_box', status: 'draft',
    owner_user: existing ? existing.owner_user : (owner || null), updated_by: owner || null,
    work_date: existing ? existing.work_date : new Date().toISOString().slice(0, 10),
    fields: mergedFields
  };
  const { error } = await client.from(BUCK_TABLE).upsert(row);
  if (error) { console.error('saveBuckBoxFields', error); return { ok: false, reason: error.message }; }
  return { ok: true };
}

// ── Closing a batch: roll up submissions + boxes into a normal 'buck' record ─

async function closeBuckBatch(batchUid, batchStrain, extra, owner) {
  const client = buckClient();
  if (!client) return { ok: false, reason: 'not-configured' };

  const [submissions, boxes] = await Promise.all([
    listSubmissions({ batchUid }),
    listBuckBoxes(batchUid)
  ]);

  const sumBoxes = (key) => boxes.reduce((a, b) => a + (Number(b.fields[key]) || 0), 0);
  const buckedFlowerLb = submissions.reduce((a, s) => a + (Number(s.fields.weightLb) || 0), 0);

  const now = new Date().toISOString();
  const summaryFields = {
    date: now.slice(0, 10),
    strain: batchStrain || null,
    sourceUid: batchUid,
    startingDryLb: sumBoxes('startingWeightLb'),
    buckedFlowerLb,
    bigLeafLb: sumBoxes('bigLeafLb'),
    stemLb: sumBoxes('stemsLb'),
    wasteLb: sumBoxes('wasteLb'),
    aPlusTrimLb: sumBoxes('aPlusTrimLb'),
    aTrimLb: sumBoxes('aTrimLb'),
    bTrimLb: sumBoxes('bTrimLb'),
    ...(extra || {})
  };

  const summaryRow = {
    id: newId(), station_key: 'buck', status: 'submitted',
    owner_user: owner || null, updated_by: owner || null,
    strain: batchStrain || null, work_date: now.slice(0, 10), submitted_at: now,
    fields: summaryFields
  };
  const closeRow = {
    id: newId(), station_key: 'buck_batch_close', status: 'submitted',
    owner_user: owner || null, updated_by: owner || null,
    work_date: now.slice(0, 10), submitted_at: now,
    fields: { batchUid, closedAt: now, closedBy: owner || null }
  };

  const { error } = await client.from(BUCK_TABLE).insert([summaryRow, closeRow]);
  if (error) { console.error('closeBuckBatch', error); return { ok: false, reason: error.message }; }
  return { ok: true, summary: summaryFields };
}

// ── Reads for the Employee / Historical tabs ────────────────────────────────

// Every submission for one employee across a date range (inclusive, 'YYYY-MM-DD').
async function listSubmissionsByEmployee(employeeNo, fromDate, toDate) {
  const client = buckClient();
  if (!client || !employeeNo) return [];
  let q = client.from(BUCK_TABLE).select('*')
    .eq('station_key', 'buck_submission').eq('status', 'submitted')
    .eq('fields->>employeeNo', String(employeeNo).trim());
  if (fromDate) q = q.gte('work_date', fromDate);
  if (toDate) q = q.lte('work_date', toDate);
  const { data, error } = await q.order('submitted_at', { ascending: false });
  if (error) { console.error('listSubmissionsByEmployee', error); return []; }
  return data || [];
}

async function listSubmissionsByDateRange(fromDate, toDate) {
  const client = buckClient();
  if (!client) return [];
  let q = client.from(BUCK_TABLE).select('*').eq('station_key', 'buck_submission').eq('status', 'submitted');
  if (fromDate) q = q.gte('work_date', fromDate);
  if (toDate) q = q.lte('work_date', toDate);
  const { data, error } = await q.order('submitted_at', { ascending: false });
  if (error) { console.error('listSubmissionsByDateRange', error); return []; }
  return data || [];
}

async function listClosedBatches() {
  const client = buckClient();
  if (!client) return [];
  const { data, error } = await client.from(BUCK_TABLE).select('*')
    .eq('station_key', 'buck').eq('status', 'submitted')
    .order('submitted_at', { ascending: false });
  if (error) { console.error('listClosedBatches', error); return []; }
  return data || [];
}
