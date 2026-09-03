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
  try {
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
  } catch (e) { console.error('listOpenBatches', e); return []; }
}

// ── Offline queue ────────────────────────────────────────────────────────────
// The quick-entry bar is the one write in this station that has to survive a
// dropped connection at the moment it happens — a team lead standing at the
// scale shouldn't have to remember to re-type a weight because wifi hiccuped.
// Box saves and batch close-out get the same safety net for free: they're
// queued as "please retry this exact call" rather than as pre-computed data,
// so when they do go through (now or after a reconnect) they read whatever
// is actually on the server at that moment — never stale, never guessed.
const BUCK_QUEUE_KEY = '2cw_buck_queue';

function readBuckQueue() {
  try { return JSON.parse(localStorage.getItem(BUCK_QUEUE_KEY) || '[]'); } catch { return []; }
}
function writeBuckQueue(q) { localStorage.setItem(BUCK_QUEUE_KEY, JSON.stringify(q)); }
function enqueueBuck(item) { const q = readBuckQueue(); q.push(item); writeBuckQueue(q); }
function buckQueueCount() { return readBuckQueue().length; }

// Submissions made while offline still need to show up on today's roster
// immediately (an operator needs to see their entry landed, or they'll
// re-type it) — the roster reads these alongside the server rows until they
// actually sync.
function queuedSubmissionsForDate(date) {
  return readBuckQueue().filter((item) => item.type === 'submission' && item.row.work_date === date).map((item) => item.row);
}

// Drains the queue oldest-first, stopping at the first failure so order (and
// the "retry against current server state" guarantee for boxes/close-out) is
// preserved. Safe to call repeatedly — an empty queue is a no-op.
async function flushBuckQueue() {
  const q = readBuckQueue();
  if (!q.length) return { sent: 0, remaining: 0 };
  let sent = 0;
  while (q.length) {
    const item = q[0];
    let res;
    if (item.type === 'submission') res = await _insertBuckRow(item.row);
    else if (item.type === 'box') res = await _rawSaveBuckBoxFields(item.args.batchUid, item.args.boxNo, item.args.partial, item.args.owner);
    else if (item.type === 'close') res = await _rawCloseBuckBatch(item.args.batchUid, item.args.batchStrain, item.args.extra, item.args.owner);
    else { q.shift(); writeBuckQueue(q); continue; } // unrecognized entry — drop rather than get stuck
    if (res.ok) { q.shift(); sent++; writeBuckQueue(q); } else break;
  }
  return { sent, remaining: q.length };
}

// Renders a "N entries waiting to send" banner and keeps it current — same
// idea as prod_common.js's mountQueueBanner, just pointed at this station's
// own queue since it writes straight to Supabase instead of through the
// Netlify function the old queue targets. `strings` needs {pendingOne,
// pendingMany, sendNow} translation objects; `onFlush` (optional) is called
// after every flush attempt so the caller can refresh whatever's on screen.
// Returns the banner's render() function so a caller can force an immediate
// refresh right after queueing something — otherwise the banner wouldn't
// show up until the next 5s poll or 'online' event, which reads as "did
// that actually save?" for however many seconds it takes.
function mountBuckQueueBanner(elId, strings, onFlush) {
  const el = document.getElementById(elId);
  if (!el) return () => {};
  const render = () => {
    const n = buckQueueCount();
    if (!n) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.innerHTML = `<span>${n} ${t(n === 1 ? strings.pendingOne : strings.pendingMany)}</span>` +
                   `<button type="button" id="buck-queue-send">${t(strings.sendNow)}</button>`;
    el.querySelector('#buck-queue-send').onclick = async () => {
      el.querySelector('#buck-queue-send').disabled = true;
      await flushBuckQueue();
      render();
      if (onFlush) onFlush();
    };
  };
  render();
  window.addEventListener('online', async () => { await flushBuckQueue(); render(); if (onFlush) onFlush(); });
  if (navigator.onLine && buckQueueCount()) flushBuckQueue().then(() => { render(); if (onFlush) onFlush(); });
  setInterval(async () => {
    if (buckQueueCount() && navigator.onLine) { await flushBuckQueue(); if (onFlush) onFlush(); }
    render();
  }, 5000);
  return render;
}

// ── Submissions (insert-only) ───────────────────────────────────────────────

function buildBuckSubmissionRow({ batchUid, batchStrain, boxNo, employeeNo, weightLb, owner }) {
  const now = new Date().toISOString();
  return {
    id: newId(), station_key: 'buck_submission', status: 'submitted',
    owner_user: owner || null, updated_by: owner || null,
    strain: batchStrain || null, work_date: now.slice(0, 10),
    submitted_at: now,
    fields: { batchUid, boxNo: boxNo || null, employeeNo: String(employeeNo || '').trim(), weightLb: Number(weightLb) }
  };
}

async function _insertBuckRow(row) {
  const client = buckClient();
  if (!client) return { ok: false, reason: 'not-configured' };
  try {
    const { error } = await client.from(BUCK_TABLE).insert(row);
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// Built with a real timestamp the moment this is called, whether or not the
// network is up — so a submission made offline and flushed an hour later
// still shows the time it actually happened on the floor, not when it
// finally reached the server.
async function logBuckSubmission(args) {
  const row = buildBuckSubmissionRow(args);
  const res = await _insertBuckRow(row);
  if (res.ok) return { ok: true, row };
  if (res.reason === 'not-configured') return { ok: false, reason: res.reason };
  enqueueBuck({ type: 'submission', row });
  return { ok: true, queued: true, row };
}

async function listSubmissions({ batchUid, date, employeeNo } = {}) {
  const client = buckClient();
  if (!client) return [];
  try {
    let q = client.from(BUCK_TABLE).select('*').eq('station_key', 'buck_submission').eq('status', 'submitted');
    if (batchUid) q = q.eq('fields->>batchUid', batchUid);
    if (date) q = q.eq('work_date', date);
    if (employeeNo) q = q.eq('fields->>employeeNo', String(employeeNo).trim());
    const { data, error } = await q.order('submitted_at', { ascending: false });
    if (error) { console.error('listSubmissions', error); return []; }
    return data || [];
  } catch (e) { console.error('listSubmissions', e); return []; }
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
  try {
    const { data, error } = await client.from(BUCK_TABLE).select('*')
      .eq('station_key', 'buck_box').eq('fields->>batchUid', batchUid).eq('fields->>boxNo', String(boxNo))
      .maybeSingle();
    if (error) { console.error('getBuckBox', error); return null; }
    return data;
  } catch (e) { console.error('getBuckBox', e); return null; }
}

async function listBuckBoxes(batchUid) {
  const client = buckClient();
  if (!client) return [];
  try {
    const { data, error } = await client.from(BUCK_TABLE).select('*')
      .eq('station_key', 'buck_box').eq('fields->>batchUid', batchUid)
      .order('fields->>boxNo', { ascending: true });
    if (error) { console.error('listBuckBoxes', error); return []; }
    return data || [];
  } catch (e) { console.error('listBuckBoxes', e); return []; }
}

// Only the keys present in `partial` are changed — undefined/missing keys
// keep whatever was already saved. This is what lets someone submit just the
// starting weight now and come back for stems later without wiping it out.
async function _rawSaveBuckBoxFields(batchUid, boxNo, partial, owner) {
  const client = buckClient();
  if (!client) return { ok: false, reason: 'not-configured' };
  try {
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
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// Queues on failure as "retry this exact (batchUid, boxNo, partial, owner)
// call" rather than a pre-built row — so when it's replayed (now or after a
// reconnect), it re-reads whatever is on the server at THAT moment and
// merges into it, exactly as if it had succeeded on the first try. That's
// what keeps the merge-safety guarantee intact even offline.
async function saveBuckBoxFields(batchUid, boxNo, partial, owner) {
  const res = await _rawSaveBuckBoxFields(batchUid, boxNo, partial, owner);
  if (res.ok || res.reason === 'not-configured') return res;
  enqueueBuck({ type: 'box', args: { batchUid, boxNo, partial, owner } });
  return { ok: true, queued: true };
}

// ── Closing a batch: roll up submissions + boxes into a normal 'buck' record ─

async function _rawCloseBuckBatch(batchUid, batchStrain, extra, owner) {
  const client = buckClient();
  if (!client) return { ok: false, reason: 'not-configured' };
  try {
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
    if (error) return { ok: false, reason: error.message };
    return { ok: true, summary: summaryFields };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// Same deferred-retry approach as saveBuckBoxFields — closing a batch has to
// read current submissions/boxes no matter when it happens, so queueing the
// call (not a precomputed total) is what makes a queued close-out come out
// with the right numbers once it actually runs.
async function closeBuckBatch(batchUid, batchStrain, extra, owner) {
  const res = await _rawCloseBuckBatch(batchUid, batchStrain, extra, owner);
  if (res.ok || res.reason === 'not-configured') return res;
  enqueueBuck({ type: 'close', args: { batchUid, batchStrain, extra, owner } });
  return { ok: true, queued: true };
}

// ── Reads for the Employee / Historical tabs ────────────────────────────────

// Every submission for one employee across a date range (inclusive, 'YYYY-MM-DD').
async function listSubmissionsByEmployee(employeeNo, fromDate, toDate) {
  const client = buckClient();
  if (!client || !employeeNo) return [];
  try {
    let q = client.from(BUCK_TABLE).select('*')
      .eq('station_key', 'buck_submission').eq('status', 'submitted')
      .eq('fields->>employeeNo', String(employeeNo).trim());
    if (fromDate) q = q.gte('work_date', fromDate);
    if (toDate) q = q.lte('work_date', toDate);
    const { data, error } = await q.order('submitted_at', { ascending: false });
    if (error) { console.error('listSubmissionsByEmployee', error); return []; }
    return data || [];
  } catch (e) { console.error('listSubmissionsByEmployee', e); return []; }
}

async function listSubmissionsByDateRange(fromDate, toDate) {
  const client = buckClient();
  if (!client) return [];
  try {
    let q = client.from(BUCK_TABLE).select('*').eq('station_key', 'buck_submission').eq('status', 'submitted');
    if (fromDate) q = q.gte('work_date', fromDate);
    if (toDate) q = q.lte('work_date', toDate);
    const { data, error } = await q.order('submitted_at', { ascending: false });
    if (error) { console.error('listSubmissionsByDateRange', error); return []; }
    return data || [];
  } catch (e) { console.error('listSubmissionsByDateRange', e); return []; }
}

async function listClosedBatches() {
  const client = buckClient();
  if (!client) return [];
  try {
    const { data, error } = await client.from(BUCK_TABLE).select('*')
      .eq('station_key', 'buck').eq('status', 'submitted')
      .order('submitted_at', { ascending: false });
    if (error) { console.error('listClosedBatches', error); return []; }
    return data || [];
  } catch (e) { console.error('listClosedBatches', e); return []; }
}
