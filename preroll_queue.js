// ─────────────────────────────────────────────────────────────────────────────
// The pre-roll queue, shared by the Pre-Roll Dashboard (preroll_dashboard.html)
// and the Pre-Roll Production form's Production Request dropdown (ops_form.html).
//
// What's in it: every open pre-roll request in the Production Requests Sheet
// (not on hold in preroll_plans) plus batches added by hand
// (preroll_queue_items, "PQ-<queue_no>"), in the order set on the dashboard
// (one operations_forms row, PREROLL_QUEUE_ID). Anything not ordered yet goes
// last, by Ready Date / date added. An item is done once a Pre-Roll Production
// form carrying its ref (PR# or PQ-#) in prNum is submitted.
//
// Quantities are units (packs, or singles); preroll_products turns them into
// pre-rolls (units × pack_size). See "Pre-Roll Dashboard" in
// docs/OPERATIONS_APP.md.
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCTION_REQUESTS_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQkx0gxPTulAOv3WMXayY8HOqcoYByZ_kOXrLvd84-9ReSwGa-6Or-KTx4SdPfT0rC5_qOCE3LHz_mT/pub?gid=1857304423&single=true&output=csv';
const PREROLL_QUEUE_ID = '70726571-7565-4000-8000-000000000001';
// Brand from the BSKU's 3-letter code, or the product name.
const BRAND_CODES = { SRF: 'Soma Rosa', HWR: 'Howie Roll', MDO: 'Mendo' };

// Quote-aware CSV — the Notes column can hold commas.
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [hdr, ...body] = rows;
  if (!hdr) return [];
  const keys = hdr.map((h) => h.trim());
  return body.filter((r) => r.some((v) => v.trim())).map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] || '').trim()])));
}

// Pre-roll products only — decided by what's being made, not the Sheet's
// Crew column (a flower packout can be crewed by the pre-roll team). A BSKU
// is brand code + 2-digit category, and 02 is Preroll (SRF021004 28pk,
// SRF020701 single, MDO021107 10pk; 01 is flower). No BSKU → go by the name.
function isPrerollRequest(r) {
  const bsku = (r['BSKU'] || '').trim().toUpperCase();
  if (/^[A-Z]{3}\d{2}/.test(bsku)) return bsku.slice(3, 5) === '02';
  return /pre-?roll/i.test(r['Product'] || '');
}

function brandOf(bsku, product) {
  const code = String(bsku || '').trim().toUpperCase().slice(0, 3);
  if (BRAND_CODES[code]) return BRAND_CODES[code];
  const p = String(product || '');
  return Object.values(BRAND_CODES).find((b) => p.toLowerCase().includes(b.toLowerCase())) || '';
}

// The open queue, in order, for the form's dropdown. Each item:
// { ref, kind ('pr' | 'manual'), brand, productName, type, strain, sourceUid,
//   units, packSize, packType, target (pre-rolls), unitSizeG, readyDate, draftId, made }.
// A failure in one source drops only that source (no Sheet → hand-added
// items only).
async function loadPrerollQueue(client) {
  if (!client) return [];
  const n = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : 0; };
  const up = (s) => String(s || '').trim().toUpperCase();
  const [sheet, plans, products, manual, ord, forms] = await Promise.all([
    fetch(PRODUCTION_REQUESTS_CSV_URL + '&t=' + Date.now())
      .then((r) => (r.ok ? r.text() : '')).then((txt) => parseCsv(txt).filter(isPrerollRequest).filter((r) => r['PR#']))
      .catch((e) => { console.error('preroll queue: sheet', e); return []; }),
    client.from('preroll_plans').select('*').then(({ data }) => data || []),
    client.from('preroll_products').select('*').then(({ data }) => data || []),
    client.from('preroll_queue_items').select('*').is('removed_at', null).then(({ data }) => data || []),
    client.from('operations_forms').select('fields').eq('id', PREROLL_QUEUE_ID).maybeSingle().then(({ data }) => data),
    client.from('operations_forms').select('id,status,fields').eq('station_key', 'preroll_production').then(({ data }) => data || [])
  ]);
  const planBy = Object.fromEntries(plans.map((p) => [p.pr_num, p]));
  const prodBy = Object.fromEntries(products.map((p) => [up(p.bsku), p]));
  const runsBy = {};
  forms.forEach((f) => { const k = up(f.fields && f.fields.prNum); if (k) (runsBy[k] = runsBy[k] || []).push(f); });
  const order = (ord && ord.fields && Array.isArray(ord.fields.order)) ? ord.fields.order : [];

  const item = (base, prod, units) => {
    const runs = runsBy[up(base.ref)] || [];
    const draft = runs.find((r) => r.status === 'draft');
    return {
      ...base,
      brand: base.brand || (prod && prod.brand) || '',
      productName: prod ? prod.name : base.productName || '',
      units, packSize: prod ? n(prod.pack_size) : 1,
      // The form's Pack Type code: 'single' or '<n>pk'. Unknown without a product.
      packType: prod ? (n(prod.pack_size) > 1 ? `${n(prod.pack_size)}pk` : 'single') : '',
      target: prod ? units * n(prod.pack_size) : units,
      unitSizeG: prod && prod.preroll_size_g != null ? n(prod.preroll_size_g) : null,
      draftId: draft ? draft.id : null,
      // Pre-rolls on its runs so far (the form's Queue tab).
      made: runs.reduce((a, r) => a + n(r.fields && r.fields.totalPrerolls), 0),
      done: runs.some((r) => r.status === 'submitted')
    };
  };
  const fromSheet = sheet.map((r) => {
    const plan = planBy[r['PR#']] || {};
    if (plan.on_hold) return null;
    const prod = prodBy[up(plan.product_bsku || r['BSKU'])] || null;
    const units = n(plan.quantity) > 0 ? n(plan.quantity) : n(r['Batch Size']);
    return item({
      ref: r['PR#'], kind: 'pr', brand: brandOf(r['BSKU'], r['Product']), productName: r['Product'],
      type: plan.strain_type || r['Strain Type'] || '', strain: plan.strain || r['Output Strain'] || '',
      sourceUid: plan.source_uid || '', readyDate: r['Ready Date'] || '', sortDate: r['Ready Date'] || '9999'
    }, prod, units);
  }).filter(Boolean);
  const fromManual = manual.map((m) => item({
    ref: 'PQ-' + m.queue_no, kind: 'manual', brand: m.brand || '', type: m.strain_type || '', strain: m.strain || '',
    sourceUid: m.source_uid || '', readyDate: '', sortDate: String(m.created_at || '').slice(0, 10) || '9999'
  }, prodBy[up(m.product_bsku)] || null, n(m.quantity)));
  const pos = (x) => { const i = order.indexOf(x.ref); return i < 0 ? Infinity : i; };
  return fromSheet.concat(fromManual).filter((x) => !x.done)
    .sort((a, b) => (pos(a) - pos(b)) || a.sortDate.localeCompare(b.sortDate) || a.ref.localeCompare(b.ref));
}
