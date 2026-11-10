// Inventory Adjustments (inventory_adjust.html): line Raw Inventory up with
// Metrc after a physical count — or fix one package — with who and why.
//
// This file is the pure part, shared with the tests
// (node scripts/test_inv_adjust.js):
//   fromCanix(inventory, licenses)  Metrc packages from the Canix sync
//   fromGrid(grid) / parseCsv(text) Metrc packages from an uploaded count
//                                   (Metrc package export, or any sheet with
//                                   a tag column and a quantity column)
//   compare(rows, marks, pkgs)      Raw Inventory's on-hand rows against
//                                   those packages, one line per UID
//   entryOf(line, extra)            a line as it's saved in a batch
// raw_stock.js applies saved batches (applyAdjusted) — every page that shows
// Raw Inventory's numbers sees them.
const InvAdjust = (function () {
  const G_PER_LB = 453.59237;
  const r2 = (x) => Math.round(x * 100) / 100;
  const norm = (u) => String(u || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tailMatch = (a, b) => {
    a = norm(a); b = norm(b);
    if (Math.min(a.length, b.length) < 4) return false;
    return a.endsWith(b) || b.endsWith(a);
  };
  // Under this many lbs apart counts as the same.
  const TOL_LB = 0.01;

  const REASONS = [
    { v: 'physical_count', l: { en: 'Physical count', es: 'Conteo físico' } },
    { v: 'missing_form', l: { en: 'Form never filled out', es: 'Formulario no llenado' } },
    { v: 'wrong_form', l: { en: 'Form filled out wrong (weight / UID)', es: 'Formulario mal llenado (peso / UID)' } },
    { v: 'metrc_only', l: { en: 'Done in Metrc only (sold, moved, combined)', es: 'Hecho solo en Metrc (vendido, movido, combinado)' } },
    { v: 'moisture', l: { en: 'Moisture loss / dry-down', es: 'Pérdida de humedad / secado' } },
    { v: 'scale', l: { en: 'Scale difference', es: 'Diferencia de báscula' } },
    { v: 'waste', l: { en: 'Waste / destroyed', es: 'Desecho / destruido' } },
    { v: 'other', l: { en: 'Other (explain in the note)', es: 'Otro (explique en la nota)' } }
  ];
  const REASON_BY = Object.fromEntries(REASONS.map((r) => [r.v, r]));

  // Raw Inventory's tab for a Metrc item ("Unbucked Flower - Zoap",
  // "Flower | Smalls | OG | Bulk", "Pre-Roll-2CW- (1g)").
  function tabOfItem(name, typeName) {
    const s = `${name || ''} ${typeName || ''}`.toLowerCase();
    if (/pre-?\s?roll|pouch|ground/.test(s)) return 'finished';
    if (/frozen/.test(s)) return 'frozen';
    if (/unfinished\s*smalls/.test(s)) return 'smalls_unf';
    if (/smalls?\b|b-?buds?/.test(s)) return 'smalls';
    if (/trim|shake|leaf|biomass|sugar/.test(s)) return 'trim';
    if (/unbucked|on[-\s]?stem/.test(s)) return 'onstem';
    if (/bucked/.test(s)) return 'bucked';
    if (/wet|fresh cannabis/.test(s)) return 'drying';
    if (/flower|bud/.test(s)) return 'flower';
    return '';
  }

  // A quantity in pounds (or units for things counted each). `unit` may be
  // blank when the number cell carries it ("12.5 lb", "448 g").
  function qtyOf(value, unitText) {
    const raw = String(value == null ? '' : value).trim();
    const m = raw.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    const u = `${unitText || ''} ${raw.slice(m.index + m[0].length)}`.toLowerCase().trim();
    if (/^(ea|each|unit|pc|piece|ct|count)/.test(u)) return { qty: n, unit: 'units' };
    if (/^(kg|kilo)/.test(u)) return { qty: r2(n * 2.20462262), unit: 'lb' };
    if (/^(g\b|g$|gram|gm)/.test(u)) return { qty: r2(n / G_PER_LB), unit: 'lb' };
    if (/^(oz|ounce)/.test(u)) return { qty: r2(n / 16), unit: 'lb' };
    return { qty: n, unit: 'lb' };
  }

  // Active packages at the given licenses (In Transit ones are on a manifest:
  // kept, marked, so the page can say so).
  function fromCanix(inventory, licenses) {
    return (inventory || []).filter((p) => p && p.tag && p.is_active !== false &&
      (!licenses || !licenses.length || licenses.includes(p._facility_license_number))).map((p) => {
      const item = p.item || {};
      const q = qtyOf(p.weight, p.weight_unit) || { qty: 0, unit: 'lb' };
      return {
        uid: norm(p.tag), item: item.name || '', strain: ((item.strain || {}).name) || String(item.name || '').split(' - ').pop(),
        qty: q.qty, unit: q.unit, tab: tabOfItem(item.name, (item.type || {}).name),
        status: p.status || '', inTransit: p.status === 'In Transit',
        location: (p.location && p.location.name) || (typeof p.location === 'string' ? p.location : '') || '',
        facility: p._facility_license_number || ''
      };
    });
  }

  // CSV text → rows of cells (quotes, commas and newlines inside quotes).
  function parseCsv(text) {
    const out = []; let row = [], cell = '', q = false;
    const s = String(text || '').replace(/^﻿/, '');
    const delim = (s.split('\n')[0].match(/\t/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); out.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); out.push(row); }
    return out.filter((r) => r.some((x) => String(x).trim() !== ''));
  }

  // A sheet's rows → Metrc packages. Finds the header row (a Tag / UID /
  // Package column) in the first 15 rows; without one, the column holding
  // Metrc tags and the first number column after it.
  const isTag = (v) => /^1A4[0-9A-Z]{21}$/.test(norm(v)) || /^[0-9A-Z]{4,}$/.test(norm(v)) && /\d/.test(norm(v)) && norm(v).length >= 8;
  function fromGrid(grid) {
    const rows = (grid || []).map((r) => (r || []).map((c) => (c == null ? '' : String(c).trim())));
    const find = (hdr, res) => { for (const re of res) { const i = hdr.findIndex((h) => re.test(h)); if (i >= 0) return i; } return -1; };
    let h = -1, col = {};
    for (let i = 0; i < Math.min(15, rows.length) && h < 0; i++) {
      const hdr = rows[i].map((x) => x.toLowerCase());
      const tag = find(hdr, [/^(package\s*)?tag$/, /^(package\s*)?(uid|label)$/, /\btag\b/, /\buid\b/, /^package$/]);
      if (tag < 0) continue;
      h = i;
      col = {
        tag,
        qty: find(hdr, [/^quantity$/, /^(count|counted|physical)/, /^(qty|weight|lbs?|pounds|amount)\b/, /quantity|weight|lbs|count/]),
        unit: find(hdr, [/^(unit|uom|unit of measure)/, /\bunit\b|\buom\b/]),
        item: find(hdr, [/^item$/, /^item\b/, /product|name/]),
        strain: find(hdr, [/strain/]),
        location: find(hdr, [/location|room/])
      };
      if (col.unit === col.qty) col.unit = -1;
    }
    if (h < 0) {
      const sample = rows.slice(0, 30);
      const width = Math.max(0, ...sample.map((r) => r.length));
      let tag = -1;
      for (let c = 0; c < width && tag < 0; c++) if (sample.filter((r) => isTag(r[c])).length >= Math.max(1, sample.length / 2)) tag = c;
      if (tag < 0) return { pkgs: [], skipped: rows.length, cols: null, error: 'noTag' };
      let qty = -1;
      for (let c = 0; c < width && qty < 0; c++) if (c !== tag && sample.filter((r) => qtyOf(r[c])).length >= Math.max(1, sample.length / 2)) qty = c;
      col = { tag, qty, unit: -1, item: -1, strain: -1, location: -1 };
    }
    if (col.qty < 0) return { pkgs: [], skipped: rows.length, cols: col, error: 'noQty' };
    const pkgs = []; let skipped = 0;
    const seen = new Map();
    rows.slice(h + 1).forEach((r) => {
      const uid = norm(r[col.tag]);
      const q = qtyOf(r[col.qty], col.unit >= 0 ? r[col.unit] : '');
      // A tag has digits ("Total", "Subtotal" rows don't).
      if (uid.length < 4 || !/\d/.test(uid) || !q) { skipped++; return; }
      const item = col.item >= 0 ? r[col.item] : '';
      const p = { uid, item, strain: col.strain >= 0 ? r[col.strain] : (item.includes(' - ') ? item.split(' - ').pop() : ''),
        qty: q.qty, unit: q.unit, tab: tabOfItem(item), status: '', inTransit: false, location: col.location >= 0 ? r[col.location] : '', facility: '' };
      // The same tag twice (a count sheet with a package in two bins): added up.
      if (seen.has(uid)) { const x = seen.get(uid); x.qty = r2(x.qty + p.qty); return; }
      seen.set(uid, p); pkgs.push(p);
    });
    return { pkgs, skipped, cols: col, header: h };
  }

  // Raw Inventory against Metrc, one line per UID:
  //   match       same weight
  //   diff        both have it, different weight → set to Metrc's
  //   only_app    Raw Inventory has it, Metrc doesn't → 0 (only listed when
  //               the source is a full count: `full`)
  //   only_metrc  Metrc has it, Raw Inventory doesn't → add it (or bring back
  //               rows marked Used up: `unmark`)
  //   transit     on a manifest in Metrc, still on hand here → 0 (an Outgoing
  //               Transfer form would take it off)
  // `rows` are RawStock's rows (used-up ones too); `marks` its Used up marks.
  function compare(rows, marks, pkgs, opts = {}) {
    marks = marks || {};
    const live = rows.filter((r) => r.uid && r.lb > 0.005 && !marks[r.key]);
    const groups = new Map();
    live.forEach((r) => { const u = norm(r.uid); if (!groups.has(u)) groups.set(u, []); groups.get(u).push(r); });
    const marked = rows.filter((r) => r.uid && r.lb > 0.005 && marks[r.key]);
    const lines = [], matched = new Set();
    const sumLb = (rs) => r2(rs.reduce((a, r) => a + r.lb, 0));
    const lineOf = (uid, rs, p, kind, toLb, extra = {}) => ({
      id: uid, uid, kind, tab: (rs[0] && rs[0].tab) || (p && p.tab) || '', tabs: [...new Set(rs.map((r) => r.tab))],
      strain: (rs[0] && rs[0].strain) || (p && p.strain) || '', unit: (p && p.unit === 'units') || rs.some((r) => r.pieces) ? 'units' : 'lb',
      appLb: sumLb(rs), metrcLb: p ? p.qty : null, toLb: r2(toLb), keys: rs.map((r) => r.key), unmark: [], rows: rs, pkg: p || null, ...extra
    });
    (pkgs || []).forEach((p) => {
      const u = norm(p.uid);
      let g = groups.has(u) ? u : null;
      if (!g) for (const k of groups.keys()) if (tailMatch(k, u)) { g = k; break; }
      const rs = g ? groups.get(g) : [];
      if (g) matched.add(g);
      const uid = g && g.length > u.length ? g : u;
      if (p.inTransit) {
        if (rs.length) lines.push(lineOf(uid, rs, p, 'transit', 0));
        return;
      }
      if (!rs.length) {
        const mk = marked.filter((r) => tailMatch(r.uid, u));
        lines.push(lineOf(mk.length ? norm(mk[0].uid) : uid, mk, p, 'only_metrc', p.qty,
          mk.length ? { appLb: 0, markedLb: sumLb(mk), unmark: mk.map((r) => r.key) } : {}));
        return;
      }
      const same = Math.abs(sumLb(rs) - p.qty) < (p.unit === 'units' ? 0.5 : TOL_LB);
      lines.push(lineOf(uid, rs, p, same ? 'match' : 'diff', p.qty));
    });
    groups.forEach((rs, u) => { if (!matched.has(u)) lines.push(lineOf(u, rs, null, 'only_app', 0)); });
    const noUid = rows.filter((r) => !r.uid && r.lb > 0.005 && !marks[r.key]);
    return { lines, noUid, full: !!opts.full };
  }

  // One line as it's saved in a batch (raw_stock.js applyLine). A line that
  // brings back Used up rows starts from their pounds.
  function entryOf(line, extra = {}) {
    const keys = line.unmark && line.unmark.length ? line.unmark : line.keys;
    const from = line.unmark && line.unmark.length ? (line.markedLb || 0) : line.appLb;
    const toLb = r2(Number(line.toLb) || 0);
    return {
      kind: keys.length ? 'set' : 'add', compare: line.kind, uid: line.uid, tab: line.tab, strain: line.strain || '', unit: line.unit,
      keys, unmark: line.unmark || [], appLb: line.appLb, fromLb: r2(from), toLb, delta: r2(toLb - from),
      metrcLb: line.metrcLb, metrcItem: line.pkg ? line.pkg.item : '', metrcStatus: line.pkg ? line.pkg.status : '',
      location: line.pkg ? line.pkg.location || '' : '', reason: line.reason || '', note: line.note || '', ...extra
    };
  }

  return { G_PER_LB, TOL_LB, REASONS, REASON_BY, tabOfItem, qtyOf, fromCanix, parseCsv, fromGrid, compare, entryOf, norm, tailMatch };
})();
if (typeof module !== 'undefined') module.exports = InvAdjust;
