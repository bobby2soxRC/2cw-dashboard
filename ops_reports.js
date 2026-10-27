// ─────────────────────────────────────────────────────────────────────────────
// 2CW Operations — the Reports page's reports (reports.html).
//
// One builder per report in OPS_REPORTS (hub_config.js, which also has the
// titles and access columns). Each takes the loaded data and the run's
// context and returns what the page draws and exports:
//
//   { tiles:    [{ l: {en, es}, v, t }],
//     sections: [{ key, title: {en, es}, note?, cols: [{ k, l, t }], rows, total? }],
//     notes:    [{en, es}] }
//
// Column types (t): text, uid, date, lb, int, num, pct, usd, g, hrs. The
// page formats them; Excel gets the raw numbers.
//
// D (what reports.html loaded, see NEEDS):
//   sub[station]    submitted records, flattened like ops_data.js's
//                   flattenRecord (+ status, owner)
//   open[station]   open pages (drafts), same shape
// ctx:
//   from, to        the date range (YYYY-MM-DD, farm time), today
//   params          the report's own options (PARAMS below)
//   farmName(pid)   farm for a Farm License code, personName(badge)
//   rates, split    pay rates (labor_cost only) and the trim cost split
//   reference, metrcQueue (Map form id → row), canix {transfers,
//   facilities}, packages (Canix package rows), shifts (connecteam_shifts.json), prerollQueue (rows)
//
// Plain browser script over the operations_stations.js / ops_common.js /
// ops_analytics.js / ops_flow.js globals. Tests:
// node scripts/test_ops_reports.js.
// ─────────────────────────────────────────────────────────────────────────────

(function (root) {
  const A = root.OpsAnalytics;
  const n = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : 0; };
  const r2 = (x) => Math.round(x * 100) / 100;
  const L = (en, es) => ({ en, es: es || en });
  const day = (r) => String((r && (r.date || r.submittedAt)) || '').slice(0, 10);
  const div = (a, b) => (b > 0 ? a / b : null);
  const sum = (list, f) => list.reduce((a, x) => a + n(typeof f === 'function' ? f(x) : x[f]), 0);
  const uniq = (a) => [...new Set(a.map((x) => String(x == null ? '' : x).trim()).filter(Boolean))];
  const inRange = (d, ctx) => !!d && d >= ctx.from && d <= ctx.to;
  const daysBetween = (a, b) => (a && b ? Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000) : null);
  const title = (k) => (STATION_BY_KEY[k] || {}).title || processTitle(k);
  const groupBy = (list, keyFn) => {
    const m = new Map();
    list.forEach((x) => { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
    return m;
  };
  const C = (k, en, es, t) => ({ k, l: L(en, es), t: t || 'text' });
  const totalOf = (rows, cols, label) => {
    const t = { [cols[0].k]: label || L('Total', 'Total') };
    cols.slice(1).forEach((c) => { if (['lb', 'int', 'usd', 'g', 'hrs'].includes(c.t)) t[c.k] = r2(sum(rows, c.k)); });
    return t;
  };
  const sub = (D, k) => (D.sub && D.sub[k]) || [];
  const open = (D, k) => (D.open && D.open[k]) || [];
  const both = (D, k) => [...sub(D, k), ...open(D, k)];
  const tagTail = (u) => String(u || '');

  // What each report needs loaded. stations: submitted records; drafts:
  // open pages too; extra: metrc, canix, shifts, rates, split, names,
  // reference, prerollQueue.
  const PIPE = ['harvest', 'intake_wet', 'dry_check', 'buck', 'machine_trim', 'hand_trim'];
  const DOWNSTREAM = ['smalls_trim', 'preroll_production', 'pouch_production', 'mfg_output', 'biomass_request', 'trim_package', 'transfer_out', 'fresh_frozen'];
  const NEEDS = {
    uid_flow:           { stations: [...PIPE, ...DOWNSTREAM], drafts: ['buck', 'hand_trim', 'machine_trim'] },
    lot_yield:          { stations: PIPE, drafts: ['buck', 'hand_trim', 'machine_trim'] },
    station_throughput: { stations: OPERATIONS_STATIONS.map((s) => s.key), drafts: OPERATIONS_STATIONS.map((s) => s.key) },
    strain_yield:       { stations: PIPE, drafts: ['buck', 'hand_trim', 'machine_trim'] },
    preroll_pouch:      { stations: ['preroll_production', 'pouch_production'], drafts: ['preroll_production', 'pouch_production'], extra: ['reference', 'prerollQueue'] },
    drying:             { stations: ['intake_wet', 'dry_check'] },
    fresh_frozen:       { stations: ['intake_wet', 'fresh_frozen', 'biomass_request'] },
    trim_metrc_recon:   { stations: ['hand_trim'], drafts: ['hand_trim'], extra: ['metrc', 'packages', 'names'] },
    trimmer_pay:        { stations: ['hand_trim', 'smalls_trim'], drafts: ['hand_trim', 'smalls_trim'], extra: ['names'] },
    bucker_output:      { stations: ['buck'], drafts: ['buck'], extra: ['names'] },
    labor_cost:         { stations: [...PIPE, 'labor_entry', 'work_project', 'smalls_trim', 'preroll_production', 'pouch_production'], drafts: ['hand_trim'], extra: ['rates', 'split'] },
    intake_log:         { stations: ['intake_wet'], extra: ['reference'] },
    metrc_activity:     { stations: ['intake_wet', 'dry_check', 'buck', 'hand_trim', 'trim_package', 'preroll_production', 'pouch_production', 'transfer_out', 'smalls_trim'], extra: ['metrc'] },
    transfers:          { stations: ['transfer_out'], extra: ['canix'] },
    waste_log:          { stations: OPERATIONS_STATIONS.map((s) => s.key) },
    customer_summary:   { stations: [...PIPE, 'transfer_out'], drafts: ['buck', 'hand_trim'] },
    ops_summary:        { stations: OPERATIONS_STATIONS.map((s) => s.key), drafts: OPERATIONS_STATIONS.map((s) => s.key), extra: ['shifts'] }
  };

  // Each report's own options, drawn above the results. `opts` can be a
  // function of the loaded data (D, ctx) for lists built from it.
  const OPEN_PAGES = { k: 'open', t: 'check', def: false, l: L('Include open pages (Bucking / Trim not submitted yet)', 'Incluir hojas abiertas (desvarado / corte sin enviar)') };
  const LOT_BASIS = { k: 'basis', t: 'select', def: 'start', l: L('Lots that', 'Lotes que'), opts: [
    { v: 'start', l: L('came in during the range', 'entraron en el rango') },
    { v: 'trimmed', l: L('were trimmed during the range', 'se cortaron en el rango') },
    { v: 'any', l: L('had any form during the range', 'tuvieron algún formulario en el rango') }] };
  const PARAMS = {
    lot_yield: [LOT_BASIS, OPEN_PAGES],
    strain_yield: [LOT_BASIS, OPEN_PAGES],
    labor_cost: [LOT_BASIS],
    trim_metrc_recon: [{ k: 'open', t: 'check', def: true, l: L('Include open pages (lots still being trimmed)', 'Incluir hojas abiertas (lotes aún en corte)') },
      { k: 'tol', t: 'select', def: '1', l: L('Matches within', 'Cuadra dentro de'), opts: ['0.5', '1', '2', '5'].map((v) => ({ v, l: L(`${v}%`) })) }],
    customer_summary: [{ k: 'who', t: 'select', l: L('Farm or customer', 'Rancho o cliente'), opts: (D, ctx) => customerOptions(D, ctx) }, OPEN_PAGES]
  };

  // ── Lots ────────────────────────────────────────────────────────────────
  // buildLots' lots, with the records behind each (by the same root-UID
  // rule), for the farm, CID and dates the lot summary doesn't keep.
  function withOpen(D, keys, on) {
    const st = {};
    Object.keys(D.sub || {}).forEach((k) => { st[k] = sub(D, k); });
    if (on) keys.forEach((k) => { st[k] = both(D, k); });
    return st;
  }
  function lotIndex(stages) {
    const lots = A.buildLots(stages);
    const alias = A.buildAliasMap(stages);
    const roots = new Set(lots.map((l) => l.id));
    const keyFor = (uid) => {
      let u = A.rootUid(alias, uid);
      if (u && u.length < 8) { const hit = [...roots].find((r) => r !== u && r.endsWith(u)); if (hit) u = hit; }
      return u;
    };
    const recs = new Map(lots.map((l) => [l.id, {}]));
    PIPELINE_ORDER.forEach((k) => (stages[k] || []).forEach((r) => {
      const e = recs.get(keyFor(r.sourceUid));
      if (e) (e[k] = e[k] || []).push(r);
    }));
    return { lots, recs, keyFor };
  }
  function lotRow(lot, recs, ctx) {
    const st = lot.stages;
    const o = (k, ...cats) => cats.reduce((a, c) => a + n(((st[k] || {}).outputs || {})[c]), 0);
    const trimKeys = ['hand_trim', 'machine_trim'];
    const all = Object.values(recs).flat();
    const dates = all.map(day).filter(Boolean).sort();
    const trimDates = trimKeys.flatMap((k) => (recs[k] || []).map(day)).filter(Boolean).sort();
    const wet = (st.intake_wet || {}).outputLb || (st.harvest || {}).outputLb || 0;
    const dry = st.dry_check ? (o('dry_check', 'dry_whole_plant') || st.dry_check.outputLb) : 0;
    const bucked = o('buck', 'bucked_flower');
    const trimIn = trimKeys.reduce((a, k) => a + n((st[k] || {}).inputLb), 0);
    const flower = trimKeys.reduce((a, k) => a + o(k, 'flower_a'), 0);
    const smalls = trimKeys.reduce((a, k) => a + o(k, 'smalls_b'), 0);
    const trim = trimKeys.reduce((a, k) => a + o(k, 'trim', 'trim_a_plus', 'sugar_trim', 'shake'), 0);
    const pid = lot.pid || uniq(all.map((r) => r.pid))[0] || '';
    const STAGE = { harvest: L('Harvested', 'Cosechado'), intake_wet: L('Drying', 'Secando'), dry_check: L('On stem', 'En tallo'),
                    buck: L('Bucked', 'Desvarado'), machine_trim: L('Trimmed', 'Cortado'), hand_trim: L('Trimmed', 'Cortado') };
    const isOpen = all.some((r) => r.status === 'draft');
    return {
      uid: lot.id, strain: lot.strain, pid, farm: ctx.farmName(pid) || pid,
      cid: uniq(all.map((r) => r.cid || r.pidCustomer)).join(', '),
      start: dates[0] || '', trimmed: trimDates[trimDates.length - 1] || '', dates,
      wetLb: r2(wet) || null, dryLb: r2(dry) || null, waterPct: wet && dry ? (wet - dry) / wet : null,
      buckInLb: r2(n((st.buck || {}).inputLb)) || null, buckedLb: r2(bucked) || null,
      stemsLb: r2(o('buck', 'stems')) || null, buckWasteLb: r2(o('buck', 'waste')) || null,
      buckTrimLb: r2(o('buck', 'trim', 'trim_a_plus', 'trim_a', 'trim_b')) || null,
      buckedPct: dry && bucked ? bucked / dry : null,
      trimInLb: r2(trimIn) || null, flowerLb: r2(flower) || null, smallsLb: r2(smalls) || null, trimLb: r2(trim) || null,
      trimWasteLb: r2(trimKeys.reduce((a, k) => a + o(k, 'waste'), 0)) || null,
      flowerPct: trimIn && flower ? flower / trimIn : null,
      finishedPctWet: wet && (flower + smalls) ? (flower + smalls) / wet : null,
      stage: lot.currentStage ? { en: STAGE[lot.currentStage].en + (isOpen ? ' (open page)' : ''), es: STAGE[lot.currentStage].es + (isOpen ? ' (hoja abierta)' : '') } : '',
      lot
    };
  }
  function lotRows(D, ctx, filter) {
    const p = ctx.params || {};
    const stages = withOpen(D, ['buck', 'hand_trim', 'machine_trim'], p.open);
    const { lots, recs } = lotIndex(stages);
    const basis = p.basis || 'start';
    return lots.filter((l) => !String(l.id).startsWith('batch:'))
      .map((l) => lotRow(l, recs.get(l.id) || {}, ctx))
      .filter((r) => basis === 'start' ? inRange(r.start, ctx) : basis === 'trimmed' ? inRange(r.trimmed, ctx) : r.dates.some((d) => inRange(d, ctx)))
      .filter((r) => !filter || filter(r))
      .sort((a, b) => String(b.start).localeCompare(String(a.start)));
  }
  const LOT_COLS = [
    C('uid', 'Lot UID', 'UID del lote', 'uid'), C('strain', 'Strain', 'Variedad'), C('farm', 'Farm', 'Rancho'), C('cid', 'CID', 'CID'),
    C('start', 'In', 'Entró', 'date'), C('wetLb', 'Wet lb', 'Húmedo lb', 'lb'), C('dryLb', 'Dry lb', 'Seco lb', 'lb'),
    C('waterPct', 'Water lost', 'Agua perdida', 'pct'), C('buckedLb', 'Bucked lb', 'Desvarado lb', 'lb'), C('stemsLb', 'Stems lb', 'Tallos lb', 'lb'),
    C('buckWasteLb', 'Buck waste lb', 'Desecho desv. lb', 'lb'), C('buckTrimLb', 'Buck trim lb', 'Recorte desv. lb', 'lb'),
    C('buckedPct', 'Bucked % of dry', 'Desv. % del seco', 'pct'), C('trimInLb', 'Into trim lb', 'A corte lb', 'lb'),
    C('flowerLb', 'Flower lb', 'Flor lb', 'lb'), C('smallsLb', 'Smalls lb', 'Smalls lb', 'lb'), C('trimLb', 'Trim lb', 'Recorte lb', 'lb'),
    C('trimWasteLb', 'Trim waste lb', 'Desecho corte lb', 'lb'), C('flowerPct', 'Flower % of trim in', 'Flor % de lo cortado', 'pct'),
    C('finishedPctWet', 'Flower+smalls % of wet', 'Flor+smalls % del húmedo', 'pct'), C('stage', 'Where it is', 'Dónde está')
  ];
  // Ratios over only the lots that have both numbers, so a lot still drying
  // doesn't drag the average down.
  const pairRatio = (rows, a, b) => {
    const xs = rows.filter((r) => n(r[a]) > 0 && n(r[b]) > 0);
    return div(sum(xs, a), sum(xs, b));
  };
  function lotTotals(rows) {
    const t = totalOf(rows, LOT_COLS, L(`Total — ${rows.length} lots`, `Total — ${rows.length} lotes`));
    t.waterPct = rows.length ? 1 - (pairRatio(rows, 'dryLb', 'wetLb') || 1) : null;
    if (!pairRatio(rows, 'dryLb', 'wetLb')) t.waterPct = null;
    t.buckedPct = pairRatio(rows, 'buckedLb', 'dryLb');
    t.flowerPct = pairRatio(rows, 'flowerLb', 'trimInLb');
    const fw = rows.filter((r) => n(r.wetLb) > 0 && (n(r.flowerLb) + n(r.smallsLb)) > 0);
    t.finishedPctWet = div(sum(fw, (r) => n(r.flowerLb) + n(r.smallsLb)), sum(fw, 'wetLb'));
    return t;
  }
  const OPEN_NOTE = L('Only submitted forms count unless “Include open pages” is ticked; a lot shows up to the last stage it has a form for.',
                      'Solo cuentan los formularios enviados salvo que marque “Incluir hojas abiertas”; un lote aparece hasta la última etapa con formulario.');

  const R = {};

  R.lot_yield = (D, ctx) => {
    const rows = lotRows(D, ctx);
    const t = lotTotals(rows);
    return {
      tiles: [
        { l: L('Lots', 'Lotes'), v: rows.length, t: 'int' },
        { l: L('Wet in', 'Húmedo'), v: t.wetLb, t: 'lb' },
        { l: L('Dry', 'Seco'), v: t.dryLb, t: 'lb' },
        { l: L('Water lost', 'Agua perdida'), v: t.waterPct, t: 'pct' },
        { l: L('Bucked', 'Desvarado'), v: t.buckedLb, t: 'lb' },
        { l: L('Flower', 'Flor'), v: t.flowerLb, t: 'lb' },
        { l: L('Smalls', 'Smalls'), v: t.smallsLb, t: 'lb' },
        { l: L('Trim', 'Recorte'), v: t.trimLb, t: 'lb' }
      ],
      sections: [{ key: 'lots', title: L('Lots', 'Lotes'), cols: LOT_COLS, rows, total: t }],
      notes: [OPEN_NOTE, L('Water lost is wet minus dry at Take Down. Bucked % is bucked flower over the dry weight. Trim is normal, A+, sugar trim and shake.',
                           'Agua perdida es húmedo menos seco en la bajada. Desvarado % es flor desvarada entre el peso seco. Recorte es normal, A+, azucarado y shake.')]
    };
  };

  R.strain_yield = (D, ctx) => {
    const lots = lotRows(D, ctx);
    const rows = [...groupBy(lots, (r) => r.strain || '—')].map(([strain, xs]) => ({
      strain, lots: xs.length,
      wetLb: r2(sum(xs, 'wetLb')), dryLb: r2(sum(xs, 'dryLb')), dryPct: pairRatio(xs, 'dryLb', 'wetLb'),
      buckedLb: r2(sum(xs, 'buckedLb')), buckedPct: pairRatio(xs, 'buckedLb', 'dryLb'),
      trimInLb: r2(sum(xs, 'trimInLb')), flowerLb: r2(sum(xs, 'flowerLb')), smallsLb: r2(sum(xs, 'smallsLb')), trimLb: r2(sum(xs, 'trimLb')),
      flowerPct: pairRatio(xs, 'flowerLb', 'trimInLb'), smallsPct: pairRatio(xs, 'smallsLb', 'trimInLb'), trimPct: pairRatio(xs, 'trimLb', 'trimInLb'),
      perWet: (() => { const f = xs.filter((r) => n(r.wetLb) > 0 && n(r.flowerLb) > 0); return div(sum(f, 'flowerLb'), sum(f, 'wetLb')); })()
    })).sort((a, b) => b.flowerLb - a.flowerLb || b.wetLb - a.wetLb);
    const cols = [C('strain', 'Strain', 'Variedad'), C('lots', 'Lots', 'Lotes', 'int'), C('wetLb', 'Wet lb', 'Húmedo lb', 'lb'),
      C('dryLb', 'Dry lb', 'Seco lb', 'lb'), C('dryPct', 'Dry % of wet', 'Seco % del húmedo', 'pct'), C('buckedLb', 'Bucked lb', 'Desvarado lb', 'lb'),
      C('buckedPct', 'Bucked % of dry', 'Desv. % del seco', 'pct'), C('trimInLb', 'Into trim lb', 'A corte lb', 'lb'),
      C('flowerLb', 'Flower lb', 'Flor lb', 'lb'), C('smallsLb', 'Smalls lb', 'Smalls lb', 'lb'), C('trimLb', 'Trim lb', 'Recorte lb', 'lb'),
      C('flowerPct', 'Flower %', 'Flor %', 'pct'), C('smallsPct', 'Smalls %', 'Smalls %', 'pct'), C('trimPct', 'Trim %', 'Recorte %', 'pct'),
      C('perWet', 'Flower % of wet', 'Flor % del húmedo', 'pct')];
    const total = totalOf(rows, cols);
    Object.assign(total, { dryPct: pairRatio(lots, 'dryLb', 'wetLb'), buckedPct: pairRatio(lots, 'buckedLb', 'dryLb'),
      flowerPct: pairRatio(lots, 'flowerLb', 'trimInLb'), smallsPct: pairRatio(lots, 'smallsLb', 'trimInLb'), trimPct: pairRatio(lots, 'trimLb', 'trimInLb') });
    return {
      tiles: [{ l: L('Strains', 'Variedades'), v: rows.length, t: 'int' }, { l: L('Lots', 'Lotes'), v: lots.length, t: 'int' },
        { l: L('Dry % of wet', 'Seco % del húmedo'), v: total.dryPct, t: 'pct' }, { l: L('Flower % of trim in', 'Flor % de lo cortado'), v: total.flowerPct, t: 'pct' }],
      sections: [{ key: 'strains', title: L('By strain', 'Por variedad'), cols, rows, total }],
      notes: [OPEN_NOTE, L('Each % uses only the lots that have both weights (dry % only lots taken down; flower % only lots trimmed). Flower / smalls / trim % are of the bucked flower that went into trim.',
                           'Cada % usa solo los lotes con ambos pesos. Flor / smalls / recorte % son de la flor desvarada que entró a corte.')]
    };
  };

  // ── Throughput ──────────────────────────────────────────────────────────
  const NOT_PRODUCT = ['stems', 'waste', 'big_leaf'];
  const inLbOf = (s, r) => {
    const f = s.flow && s.flow.input;
    if (!f) return 0;
    if (f.lines) return sum(r[f.lines.field] || [], (x) => n(x[f.lines.gramsCol]) / G_PER_LB);
    return n(r[f.field]);
  };
  const outLbOf = (s, r, onlyProduct) => ((s.flow && s.flow.outputs) || [])
    .filter((o) => !onlyProduct || !NOT_PRODUCT.includes(o.category)).reduce((a, o) => a + n(r[o.field]), 0);
  const UNITS = { preroll_production: 'totalPrerolls', pouch_production: 'totalPouches', mfg_output: 'unitsProduced' };
  // Pounds weighed each day on a station's daily tally (Bucking, Hand Trim,
  // Smalls), open pages included — the same tally as the form's Daily
  // Summary and the emailed report.
  function tally(station, pages, ctx) {
    const cfg = station.dailySummary;
    const byDay = {};
    const people = new Set();
    if (!cfg) return null;
    const toLb = cfg.unit === 'lb' && !cfg.fromGrams ? 1 : 1 / G_PER_LB;
    const add = (r, p, col) => {
      const d = cfg.dateCol ? String(r[cfg.dateCol] || day(p)) : day(p);
      const v = n(r[col]);
      if (!inRange(d, ctx) || !v) return false;
      byDay[d] = (byDay[d] || 0) + v * toLb;
      return true;
    };
    pages.forEach((p) => {
      (p[cfg.lines] || []).forEach((r) => { if (add(r, p, cfg.valueCol)) { const w = String(r[cfg.empCol] || '').toLowerCase().replace(/[^a-z0-9]/g, ''); if (w) people.add(w); } });
      if (cfg.extra) (p[cfg.extra.lines] || []).forEach((r) => add(r, p, cfg.extra.valueCol));
    });
    return { byDay, lb: Object.values(byDay).reduce((a, b) => a + b, 0), people: people.size };
  }
  // Each day of the range, oldest first.
  function rangeDays(ctx) {
    const out = [];
    for (let d = ctx.from; d <= ctx.to && out.length < 400; d = addDay(d, 1)) out.push(d);
    return out;
  }
  const addDay = (d, k) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };

  function stationRows(D, ctx) {
    return OPERATIONS_STATIONS.map((s) => {
      const recs = sub(D, s.key).filter((r) => inRange(day(r), ctx));
      const drafts = open(D, s.key).filter((r) => day(r) <= ctx.to);
      const tl = tally(s, [...sub(D, s.key), ...open(D, s.key)], ctx);
      const inLb = sum(recs, (r) => inLbOf(s, r));
      const outLb = sum(recs, (r) => outLbOf(s, r));
      const conserving = s.flow && s.flow.lossKind === 'conserving';
      const withIn = recs.filter((r) => inLbOf(s, r) > 0);
      const units = UNITS[s.key] ? sum([...recs], UNITS[s.key]) : null;
      return {
        key: s.key, station: s.title, dept: s.dept, forms: recs.length, open: drafts.length,
        days: uniq(recs.map(day)).length, inLb: r2(inLb) || null, outLb: r2(outLb) || null,
        productLb: r2(sum(recs, (r) => outLbOf(s, r, true))) || null,
        lossPct: conserving && withIn.length ? div(sum(withIn, (r) => inLbOf(s, r) - outLbOf(s, r)), sum(withIn, (r) => inLbOf(s, r))) : null,
        weighedLb: tl ? r2(tl.lb) || null : null, people: tl ? tl.people || null : null,
        units: units || null, recs, tally: tl
      };
    }).filter((r) => r.forms || r.open || r.weighedLb);
  }
  R.station_throughput = (D, ctx) => {
    const rows = stationRows(D, ctx);
    const cols = [C('station', 'Station', 'Estación'), C('forms', 'Forms submitted', 'Enviados', 'int'), C('open', 'Open pages', 'Hojas abiertas', 'int'),
      C('days', 'Days with forms', 'Días con formularios', 'int'), C('inLb', 'In lb', 'Entrada lb', 'lb'), C('outLb', 'Out lb (all)', 'Salida lb (todo)', 'lb'),
      C('productLb', 'Product lb', 'Producto lb', 'lb'), C('lossPct', 'Unweighed loss', 'Pérdida sin pesar', 'pct'),
      C('weighedLb', 'Weighed in range (incl. open)', 'Pesado en el rango (con abiertas)', 'lb'), C('people', 'People weighed', 'Personas', 'int'),
      C('units', 'Units', 'Unidades', 'int')];
    rows.forEach((r) => { r.avgPerDay = r.days ? r2((r.weighedLb || r.productLb || r.outLb || 0) / r.days) : null; });
    // Daily: the tally where a station keeps one (by the day each row was
    // weighed), else pounds out on forms submitted for that day.
    const days = rangeDays(ctx);
    const used = rows.filter((r) => r.tally || r.outLb || r.units);
    const daily = days.map((d) => {
      const row = { day: d };
      used.forEach((r) => {
        const v = r.tally ? r.tally.byDay[d] || 0 : r.units ? sum(r.recs.filter((x) => day(x) === d), UNITS[r.key]) : sum(r.recs.filter((x) => day(x) === d), (x) => outLbOf(STATION_BY_KEY[r.key], x));
        row[r.key] = v ? r2(v) : null;
      });
      return row;
    }).filter((row) => used.some((r) => row[r.key]));
    const dcols = [C('day', 'Day', 'Día', 'date'), ...used.map((r) => ({ k: r.key, l: r.units ? { en: `${r.station.en} (units)`, es: `${r.station.es} (unidades)` } : { en: `${r.station.en} lb`, es: `${r.station.es} lb` }, t: r.units ? 'int' : 'lb' }))];
    return {
      tiles: [{ l: L('Forms submitted', 'Formularios enviados'), v: sum(rows, 'forms'), t: 'int' }, { l: L('Open pages', 'Hojas abiertas'), v: sum(rows, 'open'), t: 'int' },
        ...rows.filter((r) => r.weighedLb || r.productLb || r.units).slice(0, 6).map((r) => ({
          l: r.units ? { en: `${r.station.en} (units)`, es: `${r.station.es} (unidades)` } : r.station, v: r.units || r.weighedLb || r.productLb, t: r.units ? 'int' : 'lb' }))],
      sections: [
        { key: 'stations', title: L('By station', 'Por estación'), cols, rows, total: totalOf(rows, cols) },
        { key: 'daily', title: L('By day', 'Por día'), cols: dcols, rows: daily, total: totalOf(daily, dcols) }
      ],
      notes: [L('Forms count by the form’s date. “Weighed in range” is the station’s Daily Summary tally (Bucking, Hand Trim, Smalls): each row on the day it was weighed, open pages included. Product leaves out stems and waste. Open pages are pages started on or before the end of the range and not submitted.',
                'Los formularios cuentan por su fecha. “Pesado en el rango” es el resumen diario (desvarado, corte a mano, smalls): cada fila el día que se pesó, con hojas abiertas. Producto no incluye tallos ni desecho.')]
    };
  };

  // ── Pre-rolls & pouches ─────────────────────────────────────────────────
  R.preroll_pouch = (D, ctx) => {
    const brand = (v) => { const b = ((ctx.reference || {}).brands || []).find((x) => x.id === v); return b ? b.label : v || ''; };
    const runs = [];
    [['preroll_production', L('Pre-roll', 'Preroll'), 'totalPrerolls'], ['pouch_production', L('Pouch', 'Bolsa'), 'totalPouches']].forEach(([k, kind, totalField]) => {
      both(D, k).forEach((r) => {
        const out = Array.isArray(r.output) ? r.output : [];
        const inRangeUnits = out.length ? sum(out.filter((x) => inRange(String(x.day || day(r)), ctx)), 'count') : (inRange(day(r), ctx) ? n(r[totalField]) : 0);
        const runDays = uniq([day(r), ...out.map((x) => x.day)]).sort();
        if (!inRangeUnits && !runDays.some((d) => inRange(d, ctx))) return;
        const units = out.length ? sum(out, 'count') : n(r[totalField]);
        const inG = n(r.startingWtG) || n(r.startingLb) * G_PER_LB;
        const wasteG = n(r.totalWasteG) || sum(out, 'wasteG');
        const gPer = units ? (inG - wasteG) / units : null;
        runs.push({
          start: runDays[0], end: r.finishDate || runDays[runDays.length - 1], kind, batch: r.batchId || r.prNum || '', pr: r.prNum || '',
          brand: brand(r.brand), strain: r.strain || '', pack: r.packType || '', unitG: n(r.unitSizeG) || null,
          inG: r2(inG) || null, units: units || null, unitsInRange: inRangeUnits || null, wasteG: r2(wasteG) || null,
          gPerUnit: gPer != null ? Math.round(gPer * 1000) / 1000 : null,
          overPct: gPer != null && n(r.unitSizeG) ? gPer / n(r.unitSizeG) - 1 : null,
          crew: n(r.crewSize) || null, laborHours: n(r.laborHours) || null,
          status: r.status === 'draft' ? L('In progress', 'En curso') : L('Done', 'Terminado'), uid: r.sourceUid || ((r.lines || [])[0] || {}).sourceUid || ''
        });
      });
    });
    runs.sort((a, b) => String(b.start).localeCompare(String(a.start)));
    const rcols = [C('start', 'Started', 'Inicio', 'date'), C('end', 'Finished', 'Fin', 'date'), C('kind', 'Type', 'Tipo'), C('batch', 'Batch / PQ', 'Lote / PQ'),
      C('brand', 'Brand', 'Marca'), C('strain', 'Strain', 'Variedad'), C('pack', 'Pack', 'Empaque'), C('uid', 'Source UID', 'UID origen', 'uid'),
      C('inG', 'Grams in', 'Gramos', 'g'), C('unitsInRange', 'Units in range', 'Unidades en rango', 'int'), C('units', 'Units (whole run)', 'Unidades (corrida)', 'int'),
      C('wasteG', 'Waste g', 'Desecho g', 'g'), C('unitG', 'Target g/unit', 'Meta g/u', 'num'), C('gPerUnit', 'Actual g/unit', 'Real g/u', 'num'),
      C('overPct', 'Over target', 'Sobre la meta', 'pct'), C('crew', 'Crew', 'Equipo', 'int'), C('status', 'Status', 'Estado')];
    const byProduct = [...groupBy(runs, (r) => [r.kind.en, r.brand, r.strain, r.pack].join('|'))].map(([, xs]) => ({
      kind: xs[0].kind, brand: xs[0].brand, strain: xs[0].strain, pack: xs[0].pack, runs: xs.length,
      units: sum(xs, 'unitsInRange'), inG: r2(sum(xs, 'inG')), wasteG: r2(sum(xs, 'wasteG'))
    })).sort((a, b) => b.units - a.units);
    const pcols = [C('kind', 'Type', 'Tipo'), C('brand', 'Brand', 'Marca'), C('strain', 'Strain', 'Variedad'), C('pack', 'Pack', 'Empaque'),
      C('runs', 'Runs', 'Corridas', 'int'), C('units', 'Units in range', 'Unidades', 'int'), C('inG', 'Grams in', 'Gramos', 'g'), C('wasteG', 'Waste g', 'Desecho g', 'g')];
    // Work orders: the shared pre-roll / pouch queue; a run names its order
    // as PQ-<queue no>.
    const runFor = (q) => [...both(D, 'preroll_production'), ...both(D, 'pouch_production')].find((r) => [r.prNum, r.batchId].includes(`PQ-${q.queue_no}`));
    const orders = (ctx.prerollQueue || []).map((q) => {
      const r = runFor(q);
      const created = String(q.created_at || '').slice(0, 10);
      const status = r ? (r.status === 'draft' ? L('In progress', 'En curso') : L('Done', 'Terminado'))
        : q.removed_at ? L('Removed', 'Quitado') : L('Queued', 'En cola');
      return { pq: `PQ-${q.queue_no}`, created, brand: brand(q.brand), product: q.product_bsku || '', strain: q.strain || '', qty: n(q.quantity) || null,
        status, made: r ? (Array.isArray(r.output) ? sum(r.output, 'count') : n(r.totalPrerolls || r.totalPouches)) || null : null,
        open: !r && !q.removed_at, inRange: inRange(created, ctx) || (r && runs.some((x) => x.batch === (r.batchId || r.prNum))) };
    }).filter((o) => o.inRange || o.open).sort((a, b) => String(b.created).localeCompare(String(a.created)));
    const ocols = [C('pq', 'Work order', 'Orden'), C('created', 'Added', 'Agregada', 'date'), C('brand', 'Brand', 'Marca'), C('product', 'Product', 'Producto'),
      C('strain', 'Strain', 'Variedad'), C('qty', 'Ordered', 'Pedido', 'int'), C('made', 'Made', 'Hecho', 'int'), C('status', 'Status', 'Estado')];
    const pre = runs.filter((r) => r.kind.en === 'Pre-roll'), pou = runs.filter((r) => r.kind.en === 'Pouch');
    return {
      tiles: [{ l: L('Pre-rolls made', 'Prerolls hechos'), v: sum(pre, 'unitsInRange'), t: 'int' }, { l: L('Pouches made', 'Bolsas hechas'), v: sum(pou, 'unitsInRange'), t: 'int' },
        { l: L('Runs', 'Corridas'), v: runs.length, t: 'int' }, { l: L('Flower in', 'Flor usada'), v: r2(sum(runs, 'inG') / G_PER_LB), t: 'lb' },
        { l: L('Open work orders', 'Órdenes abiertas'), v: orders.filter((o) => o.open).length, t: 'int' }],
      sections: [
        { key: 'product', title: L('By product', 'Por producto'), cols: pcols, rows: byProduct, total: totalOf(byProduct, pcols) },
        { key: 'runs', title: L('Runs', 'Corridas'), cols: rcols, rows: runs, total: totalOf(runs, rcols) },
        { key: 'orders', title: L('Work orders', 'Órdenes de trabajo'), cols: ocols, rows: orders }
      ],
      notes: [L('Units in range count each output row on the day it was logged, so a run that spans the range edge counts only its days inside. Actual g/unit is grams in less waste over every unit the run made. Work orders: added in the range, or still open.',
                'Las unidades en el rango cuentan cada fila el día que se registró. Real g/u es gramos usados menos desecho entre todas las unidades. Órdenes: agregadas en el rango o aún abiertas.')]
    };
  };

  // ── Drying ──────────────────────────────────────────────────────────────
  R.drying = (D, ctx) => {
    const intakes = sub(D, 'intake_wet');
    const downs = sub(D, 'dry_check');
    const taken = matchTakeDowns(intakes, downs);
    const wetByTd = new Map();
    taken.forEach((td, iid) => { const i = intakes.find((x) => x.id === iid); wetByTd.set(td.id, (wetByTd.get(td.id) || 0) + n(i && i.totalWetLb)); });
    const end = ctx.to < ctx.today ? ctx.to : ctx.today;
    const rows = intakes.filter((i) => !isFreshFrozen(i) && inRange(day(i), ctx)).map((i) => {
      const td = taken.get(i.id);
      const wet = n(i.totalWetLb);
      const dry = td ? n(td.dryWeightLb) * (wetByTd.get(td.id) > 0 ? wet / wetByTd.get(td.id) : 1) : null;
      return {
        farm: ctx.farmName(i.pid) || i.pid || '', license: (i.canixSync || {}).shipperLicense || '', strain: i.strain || '', uid: normUid(i.sourceUid),
        room: i.dryRoom || '', inDate: day(i), wetLb: r2(wet) || null, downDate: td ? day(td) : '',
        days: td ? daysBetween(day(i), day(td)) : daysBetween(day(i), end),
        dryLb: dry != null ? r2(dry) : null, lossPct: dry != null && wet ? 1 - dry / wet : null, onStem: td ? normUid(td.sourceUid) : '',
        status: td ? L('Taken down', 'Bajado') : L('Drying', 'Secando'), drying: !td
      };
    }).sort((a, b) => String(b.inDate).localeCompare(String(a.inDate)));
    const cols = [C('farm', 'Farm', 'Rancho'), C('license', 'License', 'Licencia'), C('strain', 'Strain', 'Variedad'), C('uid', 'Farm UID', 'UID del rancho', 'uid'),
      C('room', 'Dry room', 'Cuarto'), C('inDate', 'In', 'Entró', 'date'), C('wetLb', 'Wet lb', 'Húmedo lb', 'lb'), C('downDate', 'Taken down', 'Bajado', 'date'),
      C('days', 'Days', 'Días', 'int'), C('dryLb', 'Dry lb', 'Seco lb', 'lb'), C('lossPct', 'Weight lost', 'Peso perdido', 'pct'),
      C('onStem', 'On-stem UID', 'UID en tallo', 'uid'), C('status', 'Status', 'Estado')];
    const done = rows.filter((r) => !r.drying);
    const avgDays = done.length ? done.reduce((a, r) => a + n(r.days), 0) / done.length : null;
    const byFarm = [...groupBy(rows, (r) => r.farm || '—')].map(([farm, xs]) => {
      const d = xs.filter((r) => !r.drying);
      return { farm, intakes: xs.length, wetLb: r2(sum(xs, 'wetLb')), downWetLb: r2(sum(d, 'wetLb')), dryLb: r2(sum(d, 'dryLb')),
        lossPct: div(sum(d, 'wetLb') - sum(d, 'dryLb'), sum(d, 'wetLb')), days: d.length ? r2(d.reduce((a, r) => a + n(r.days), 0) / d.length) : null,
        dryingLb: r2(sum(xs.filter((r) => r.drying), 'wetLb')) || null };
    }).sort((a, b) => b.wetLb - a.wetLb);
    const fcols = [C('farm', 'Farm', 'Rancho'), C('intakes', 'Intakes', 'Recepciones', 'int'), C('wetLb', 'Wet in lb', 'Húmedo lb', 'lb'),
      C('downWetLb', 'Taken down (wet lb)', 'Bajado (húmedo lb)', 'lb'), C('dryLb', 'Dry lb', 'Seco lb', 'lb'), C('lossPct', 'Weight lost', 'Peso perdido', 'pct'),
      C('days', 'Avg days drying', 'Días promedio', 'num'), C('dryingLb', 'Still drying (wet lb)', 'Secando (húmedo lb)', 'lb')];
    const ft = totalOf(byFarm, fcols);
    ft.lossPct = div(sum(done, 'wetLb') - sum(done, 'dryLb'), sum(done, 'wetLb'));
    ft.days = avgDays != null ? r2(avgDays) : null;
    return {
      tiles: [{ l: L('Intakes', 'Recepciones'), v: rows.length, t: 'int' }, { l: L('Wet in', 'Húmedo'), v: ft.wetLb, t: 'lb' },
        { l: L('Taken down → dry', 'Bajado → seco'), v: ft.dryLb, t: 'lb' }, { l: L('Weight lost', 'Peso perdido'), v: ft.lossPct, t: 'pct' },
        { l: L('Avg days drying', 'Días promedio'), v: ft.days, t: 'num' }, { l: L('Still drying', 'Secando'), v: ft.dryingLb, t: 'lb' }],
      sections: [
        { key: 'farms', title: L('By farm', 'Por rancho'), cols: fcols, rows: byFarm, total: ft },
        { key: 'intakes', title: L('Intakes', 'Recepciones'), cols, rows, total: totalOf(rows, cols) }
      ],
      notes: [L('Wet Intakes (not fresh frozen) that came in during the range. When several intakes went into one Take Down, its dry weight is split by their wet weight. Days still drying count to the end of the range (or today).',
                'Recepciones (no congeladas) del rango. Si varias van a una bajada, su peso seco se reparte por su peso húmedo. Los días de las que siguen secando cuentan hasta el fin del rango (u hoy).')]
    };
  };

  // ── Fresh frozen & biomass ──────────────────────────────────────────────
  R.fresh_frozen = (D, ctx) => {
    const ff = [
      ...sub(D, 'intake_wet').filter((i) => isFreshFrozen(i) && inRange(day(i), ctx)).map((i) => ({
        date: day(i), source: L('Wet Intake', 'Recepción húmeda'), farm: ctx.farmName(i.pid) || i.pid || '', strain: i.strain || '',
        uid: normUid(i.sourceUid), where: i.dryRoom || '', lb: r2(n(i.totalWetLb)) || null })),
      ...sub(D, 'fresh_frozen').filter((r) => inRange(day(r), ctx)).map((r) => ({
        date: day(r), source: title('fresh_frozen'), farm: ctx.farmName(r.pid) || r.site || '', strain: r.strain || '',
        uid: normUid(r.sourceUid), where: [r.site, r.freezer].filter(Boolean).join(' · '), lb: r2(n(r.totalLb)) || null }))
    ].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const fcols = [C('date', 'Date', 'Fecha', 'date'), C('source', 'Form', 'Formulario'), C('farm', 'Farm', 'Rancho'), C('strain', 'Strain', 'Variedad'),
      C('uid', 'UID', 'UID', 'uid'), C('where', 'Freezer / location', 'Congelador / lugar'), C('lb', 'Lb', 'Lb', 'lb')];
    const byStrain = [...groupBy(ff, (r) => `${r.strain}|${r.farm}`)].map(([, xs]) => ({ strain: xs[0].strain, farm: xs[0].farm, packages: xs.length, lb: r2(sum(xs, 'lb')) }))
      .sort((a, b) => b.lb - a.lb);
    const scols = [C('strain', 'Strain', 'Variedad'), C('farm', 'Farm', 'Rancho'), C('packages', 'Packages', 'Paquetes', 'int'), C('lb', 'Lb', 'Lb', 'lb')];
    const STATUS = Object.fromEntries(((STATION_BY_KEY.biomass_request.fields.find((f) => f.k === 'status') || {}).opts || []).map((o) => [o.v, o.l]));
    const bio = sub(D, 'biomass_request').filter((r) => inRange(day(r), ctx)).map((r) => ({
      date: day(r), strain: r.strain || '', cat: (BIOMASS[r.category] || L(r.category || '')), uid: normUid(r.sourceUid), to: r.destinationDept || r.brand || '',
      requestedLb: r2(n(r.requestedLb)) || null, transferredLb: r2(n(r.transferredLb)) || null, status: STATUS[r.status] || r.status || ''
    }));
    const bcols = [C('date', 'Date', 'Fecha', 'date'), C('strain', 'Strain', 'Variedad'), C('cat', 'Category', 'Categoría'), C('uid', 'UID', 'UID', 'uid'),
      C('to', 'For', 'Para'), C('requestedLb', 'Requested lb', 'Solicitado lb', 'lb'), C('transferredLb', 'Transferred lb', 'Transferido lb', 'lb'), C('status', 'Status', 'Estado')];
    return {
      tiles: [{ l: L('Fresh frozen', 'Fresco congelado'), v: r2(sum(ff, 'lb')), t: 'lb' }, { l: L('Packages', 'Paquetes'), v: ff.length, t: 'int' },
        { l: L('Biomass requested', 'Biomasa solicitada'), v: r2(sum(bio, 'requestedLb')), t: 'lb' }, { l: L('Biomass transferred', 'Biomasa transferida'), v: r2(sum(bio, 'transferredLb')), t: 'lb' }],
      sections: [
        { key: 'ffstrain', title: L('Fresh frozen by strain & farm', 'Congelado por variedad y rancho'), cols: scols, rows: byStrain, total: totalOf(byStrain, scols) },
        { key: 'ff', title: L('Fresh frozen packages', 'Paquetes congelados'), cols: fcols, rows: ff, total: totalOf(ff, fcols) },
        { key: 'bio', title: L('Biomass requests', 'Solicitudes de biomasa'), cols: bcols, rows: bio, total: totalOf(bio, bcols) }
      ],
      notes: [L('Fresh frozen is a Wet Intake ticked Fresh Frozen or put in a freezer location, and Fresh Frozen forms. Weights are wet.',
                'Congelado es una recepción marcada como fresco congelado o en un congelador, y los formularios de fresco congelado. Pesos húmedos.')]
    };
  };

  // ── Trimmer pay ─────────────────────────────────────────────────────────
  R.trimmer_pay = (D, ctx) => {
    const lines = [];
    both(D, 'hand_trim').forEach((r) => (r.weights || []).forEach((w) => {
      const d = String(w.day || day(r));
      const badge = A.badgeKey(w.employeeNo);
      if (!badge || !inRange(d, ctx)) return;
      const lb = n(w.grams) / G_PER_LB;
      const rate = n(r.trimRatePerLb) || null;
      lines.push({ day: d, badge, strain: r.strain || '', uid: normUid(r.sourceUid), lb, rate, pay: rate != null ? lb * rate : null, open: r.status === 'draft', kind: 'flower' });
    }));
    both(D, 'smalls_trim').forEach((r) => (r.weights || []).forEach((w) => {
      const d = String(w.day || day(r));
      const badge = A.badgeKey(w.employeeNo);
      if (!badge || !inRange(d, ctx)) return;
      lines.push({ day: d, badge, strain: r.strain || '', uid: normUid(r.sourceUid), lb: n(w.grams) / G_PER_LB, rate: null, pay: null, open: r.status === 'draft', kind: 'smalls' });
    }));
    const name = (b) => (ctx.personName && ctx.personName(b)) || '';
    // One row per trimmer × day × lot.
    const detail = [...groupBy(lines, (x) => [x.badge, x.day, x.uid, x.kind].join('|'))].map(([, xs]) => {
      const x = xs[0];
      return { day: x.day, badge: x.badge, name: name(x.badge), strain: x.strain, uid: x.uid,
        work: x.kind === 'smalls' ? L('Smalls hand trim', 'Corte de smalls') : L('Hand trim', 'Corte a mano'),
        bags: xs.length, lb: r2(sum(xs, 'lb')), rate: x.rate, pay: x.rate != null ? r2(sum(xs, 'pay')) : null,
        page: xs.some((y) => y.open) ? L('Open page', 'Hoja abierta') : L('Submitted', 'Enviado') };
    }).sort((a, b) => a.day.localeCompare(b.day) || String(a.name || a.badge).localeCompare(String(b.name || b.badge)));
    const people = [...groupBy(lines, (x) => x.badge)].map(([badge, xs]) => {
      const fl = xs.filter((x) => x.kind === 'flower');
      const days = uniq(xs.map((x) => x.day)).length;
      const unpaid = fl.filter((x) => x.rate == null);
      return { badge, name: name(badge), days, lots: uniq(xs.map((x) => x.uid)).length, flowerLb: r2(sum(fl, 'lb')) || null,
        smallsLb: r2(sum(xs.filter((x) => x.kind === 'smalls'), 'lb')) || null,
        pay: r2(sum(fl.filter((x) => x.rate != null), 'pay')) || null, avgRate: div(sum(fl.filter((x) => x.rate != null), 'pay'), sum(fl.filter((x) => x.rate != null), 'lb')),
        perDay: days ? r2(sum(fl, 'lb') / days) : null, noRateLb: r2(sum(unpaid, 'lb')) || null };
    }).sort((a, b) => n(b.pay) - n(a.pay) || n(b.flowerLb) - n(a.flowerLb));
    const pcols = [C('badge', 'Badge #', 'N.º', 'text'), C('name', 'Name', 'Nombre'), C('days', 'Days', 'Días', 'int'), C('lots', 'Lots', 'Lotes', 'int'),
      C('flowerLb', 'Finished lb', 'Terminado lb', 'lb'), C('perDay', 'Lb / day', 'Lb / día', 'lb'), C('avgRate', 'Avg $/lb', '$/lb prom.', 'usd'),
      C('pay', 'Pay', 'Pago', 'usd'), C('noRateLb', 'Lb with no rate', 'Lb sin tarifa', 'lb'), C('smallsLb', 'Smalls trim lb', 'Smalls lb', 'lb')];
    const dcols = [C('day', 'Day', 'Día', 'date'), C('badge', 'Badge #', 'N.º'), C('name', 'Name', 'Nombre'), C('work', 'Work', 'Trabajo'), C('strain', 'Strain', 'Variedad'),
      C('uid', 'Lot UID', 'UID', 'uid'), C('bags', 'Bags', 'Bolsas', 'int'), C('lb', 'Lb', 'Lb', 'lb'), C('rate', '$/lb', '$/lb', 'usd'), C('pay', 'Pay', 'Pago', 'usd'), C('page', 'Page', 'Hoja')];
    const pt = totalOf(people, pcols);
    pt.avgRate = div(n(pt.pay), sum(lines.filter((x) => x.rate != null), 'lb'));
    delete pt.perDay;
    return {
      tiles: [{ l: L('Trimmers', 'Cortadores'), v: people.length, t: 'int' }, { l: L('Finished flower', 'Flor terminada'), v: pt.flowerLb, t: 'lb' },
        { l: L('Trimmer pay', 'Pago a cortadores'), v: pt.pay, t: 'usd' }, { l: L('Avg $/lb', '$/lb prom.'), v: pt.avgRate, t: 'usd' }],
      sections: [
        { key: 'people', title: L('By trimmer', 'Por cortador'), cols: pcols, rows: people, total: pt },
        { key: 'detail', title: L('By day and lot', 'Por día y lote'), cols: dcols, rows: detail, total: totalOf(detail, dcols) }
      ],
      notes: [L('Every bag weighed on a Hand Trim page on its day, open pages included, at that page’s Trimmer Rate ($/lb). Smalls Hand Trim has no rate on its form, so it shows pounds only. Pages still open can change.',
                'Cada bolsa pesada en una hoja de corte a mano el día que se pesó, con hojas abiertas, a la tarifa de esa hoja ($/lb). El corte de smalls no tiene tarifa: solo libras.')]
    };
  };

  // ── Bucker output ───────────────────────────────────────────────────────
  R.bucker_output = (D, ctx) => {
    const lines = [];
    const recovered = [];
    both(D, 'buck').forEach((r) => {
      (r.bucked || []).forEach((w) => {
        const d = String(w.day || day(r));
        const who = String(w.who || '').trim();
        if (!who || !inRange(d, ctx)) return;
        lines.push({ day: d, who: A.badgeKey(who), strain: r.strain || '', uid: normUid(r.sourceUid), lb: n(w.weightLb), open: r.status === 'draft' });
      });
      (r.recovered || []).forEach((w) => { const d = String(w.day || day(r)); if (inRange(d, ctx)) recovered.push({ day: d, lb: n(w.weightLb) }); });
    });
    const name = (b) => (/^\d+$/.test(b) && ctx.personName && ctx.personName(b)) || (/^\d+$/.test(b) ? '' : b);
    const people = [...groupBy(lines, (x) => x.who.toLowerCase().replace(/[^a-z0-9]/g, ''))].map(([, xs]) => {
      const byDay = [...groupBy(xs, (x) => x.day)].map(([d, ys]) => [d, sum(ys, 'lb')]).sort((a, b) => b[1] - a[1]);
      return { who: xs[0].who, name: name(xs[0].who), days: byDay.length, lots: uniq(xs.map((x) => x.uid)).length, lb: r2(sum(xs, 'lb')),
        perDay: r2(sum(xs, 'lb') / byDay.length), best: byDay.length ? r2(byDay[0][1]) : null, bestDay: byDay.length ? byDay[0][0] : '' };
    }).sort((a, b) => b.lb - a.lb);
    const pcols = [C('who', 'Badge # / name', 'N.º / nombre'), C('name', 'Name', 'Nombre'), C('days', 'Days', 'Días', 'int'), C('lots', 'Lots', 'Lotes', 'int'),
      C('lb', 'Bucked lb', 'Desvarado lb', 'lb'), C('perDay', 'Lb / day', 'Lb / día', 'lb'), C('best', 'Best day lb', 'Mejor día lb', 'lb'), C('bestDay', 'Best day', 'Mejor día', 'date')];
    const detail = [...groupBy(lines, (x) => [x.who.toLowerCase(), x.day, x.uid].join('|'))].map(([, xs]) => ({
      day: xs[0].day, who: xs[0].who, name: name(xs[0].who), strain: xs[0].strain, uid: xs[0].uid, weighs: xs.length, lb: r2(sum(xs, 'lb')),
      page: xs.some((y) => y.open) ? L('Open page', 'Hoja abierta') : L('Submitted', 'Enviado') }))
      .sort((a, b) => a.day.localeCompare(b.day) || b.lb - a.lb);
    const dcols = [C('day', 'Day', 'Día', 'date'), C('who', 'Badge # / name', 'N.º / nombre'), C('name', 'Name', 'Nombre'), C('strain', 'Strain', 'Variedad'),
      C('uid', 'Lot UID', 'UID', 'uid'), C('weighs', 'Weigh-ins', 'Pesadas', 'int'), C('lb', 'Lb', 'Lb', 'lb'), C('page', 'Page', 'Hoja')];
    const daily = [...groupBy(lines, (x) => x.day)].map(([d, xs]) => ({ day: d, people: uniq(xs.map((x) => x.who.toLowerCase())).length, lb: r2(sum(xs, 'lb')),
      recovered: r2(sum(recovered.filter((x) => x.day === d), 'lb')) || null })).sort((a, b) => a.day.localeCompare(b.day));
    const ycols = [C('day', 'Day', 'Día', 'date'), C('people', 'People', 'Personas', 'int'), C('lb', 'Bucked lb (by person)', 'Desvarado lb (por persona)', 'lb'),
      C('recovered', 'Recovered from leaf lb', 'Recuperado de la hoja lb', 'lb')];
    return {
      tiles: [{ l: L('Buckers', 'Desvaradores'), v: people.length, t: 'int' }, { l: L('Bucked by person', 'Desvarado por persona'), v: r2(sum(lines, 'lb')), t: 'lb' },
        { l: L('Recovered from leaf', 'Recuperado de la hoja'), v: r2(sum(recovered, 'lb')), t: 'lb' },
        { l: L('Avg lb / person-day', 'Lb prom. por persona-día'), v: div(sum(lines, 'lb'), sum(people, 'days')), t: 'lb' }],
      sections: [
        { key: 'people', title: L('By person', 'Por persona'), cols: pcols, rows: people, total: totalOf(people, pcols) },
        { key: 'daily', title: L('By day', 'Por día'), cols: ycols, rows: daily, total: totalOf(daily, ycols) },
        { key: 'detail', title: L('By person, day and lot', 'Por persona, día y lote'), cols: dcols, rows: detail, total: totalOf(detail, dcols) }
      ],
      notes: [L('Bucking’s by-person log, each weigh-in on its day, open pages included. Recovered from leaf isn’t anyone’s, so it’s counted by day only.',
                'El registro por persona del desvarado, cada pesada en su día, con hojas abiertas. Lo recuperado de la hoja no es de nadie: solo por día.')]
    };
  };

  // ── Labor cost per pound ────────────────────────────────────────────────
  // Hourly time from the Labor Log at each person's rate (laborAllocations),
  // plus Hand Trim's piece pay, over pounds — by station for time in the
  // range, and by lot for every dollar the lot has had.
  R.labor_cost = (D, ctx) => {
    if (!ctx.rates) return { tiles: [], sections: [], notes: [L(`Pay rates couldn’t be loaded${ctx.ratesError ? ` (${ctx.ratesError})` : ''}. This report needs Reports → Labor Cost per Pound ticked for you in the admin panel.`, `No se pudieron cargar las tarifas${ctx.ratesError ? ` (${ctx.ratesError})` : ''}.`)] };
    const stages = { ...D.sub };
    const allocs = A.laborAllocations(stages, ctx.rates);
    // Trimmer piece pay: each bag at its page's $/lb, on the bag's day.
    const pieces = [];
    both(D, 'hand_trim').forEach((r) => (r.weights || []).forEach((w) => {
      const rate = n(r.trimRatePerLb);
      if (!rate) return;
      pieces.push({ day: String(w.day || day(r)), uid: r.sourceUid, cost: n(w.grams) / G_PER_LB * rate, lb: n(w.grams) / G_PER_LB });
    }));
    // By station / process, time and pay in the range.
    const inAl = allocs.filter((a) => inRange(a.date, ctx));
    const st = stationRows(D, ctx);
    const lbFor = (k) => { const r = st.find((x) => x.key === k); return r ? (r.inLb || r.weighedLb || r.outLb || null) : null; };
    const procs = [...groupBy(inAl, (a) => a.process || 'other')].map(([k, xs]) => ({
      process: processTitle(k), key: k, hours: r2(sum(xs, 'hours')), people: uniq(xs.map((x) => x.employeeNo)).length,
      cost: xs.some((x) => x.cost == null) ? null : r2(sum(xs, 'cost')), lb: lbFor(k)
    }));
    const pieceIn = pieces.filter((p) => inRange(p.day, ctx));
    if (pieceIn.length) procs.push({ process: L('Hand trim — trimmer piece pay', 'Corte a mano — pago por pieza'), key: 'hand_trim_piece', hours: null, people: null,
      cost: r2(sum(pieceIn, 'cost')), lb: r2(sum(pieceIn, 'lb')) });
    procs.forEach((p) => { p.perLb = p.cost != null && p.lb ? p.cost / p.lb : null; p.perHour = p.cost != null && p.hours ? p.cost / p.hours : null; });
    procs.sort((a, b) => n(b.cost) - n(a.cost));
    const pcols = [C('process', 'Station / work', 'Estación / trabajo'), C('hours', 'Hours', 'Horas', 'hrs'), C('people', 'People', 'Personas', 'int'),
      C('cost', 'Labor $', 'Mano de obra $', 'usd'), C('perHour', '$ / hour', '$ / hora', 'usd'), C('lb', 'Lb handled', 'Lb trabajadas', 'lb'), C('perLb', '$ / lb', '$ / lb', 'usd')];
    const pt = totalOf(procs, pcols);
    delete pt.lb; delete pt.people;
    pt.perHour = div(n(pt.cost) - r2(sum(pieceIn, 'cost')), n(pt.hours));

    // By lot: all its labor, any date.
    const { lots, keyFor } = lotIndex(stages);
    const lotOf = new Map(lots.map((l) => [l.id, l]));
    const byLot = new Map(A.laborCostByLot(stages, ctx.rates, allocs).map((r) => [r.lotId, r]));
    const pieceByLot = {};
    pieces.forEach((p) => { const k = keyFor(p.uid); pieceByLot[k] = (pieceByLot[k] || 0) + p.cost; });
    const rows = lotRows(D, { ...ctx, params: { basis: (ctx.params || {}).basis || 'start' } }).map((lr) => {
      const c = byLot.get(lr.uid) || { byProcess: {}, hours: 0, cost: 0, farmCost: 0 };
      const piece = r2(pieceByLot[lr.uid] || 0);
      const costs = Object.fromEntries(Object.entries(c.byProcess || {}).map(([k, v]) => [k, v.cost]));
      costs.hand_trim = (costs.hand_trim || 0) + piece;
      const carry = A.carryCost(lotOf.get(lr.uid), costs, ctx.split);
      const g = (k) => (carry.stages.find((s) => s.key === k) || {});
      // No time and no piece pay on the lot yet: blank, not $0.
      const hourly = c.cost == null || !c.hours ? null : r2(c.cost);
      const total = c.cost == null ? null : (hourly || piece) ? r2((hourly || 0) + piece) : null;
      const finished = n(lr.flowerLb) + n(lr.smallsLb) + n(lr.trimLb);
      return { uid: lr.uid, strain: lr.strain, farm: lr.farm, start: lr.start, hours: r2(c.hours) || null, hourly, piece: piece || null, total,
        farmShare: r2(c.farmCost || 0) || null, wetLb: lr.wetLb, finishedLb: r2(finished) || null,
        perWet: total != null && lr.wetLb ? total / lr.wetLb : null, perFinished: total != null && finished ? total / finished : null,
        perFlower: g('a').perLb || null, perSmalls: g('smalls').perLb || null, perTrim: g('trim').perLb || null,
        untrimmed: carry.untrimmedCost || null, stage: lr.stage };
    });
    const lcols = [C('uid', 'Lot UID', 'UID', 'uid'), C('strain', 'Strain', 'Variedad'), C('farm', 'Farm', 'Rancho'), C('start', 'In', 'Entró', 'date'),
      C('hours', 'Hours', 'Horas', 'hrs'), C('hourly', 'Hourly $', 'Por hora $', 'usd'), C('piece', 'Trimmer pay $', 'Pago cortadores $', 'usd'),
      C('total', 'Labor $', 'Mano de obra $', 'usd'), C('farmShare', 'Farm-wide share (est.)', 'Parte del rancho (est.)', 'usd'),
      C('wetLb', 'Wet lb', 'Húmedo lb', 'lb'), C('finishedLb', 'Finished lb', 'Terminado lb', 'lb'), C('perWet', '$ / wet lb', '$ / lb húmedo', 'usd'),
      C('perFinished', '$ / finished lb', '$ / lb terminado', 'usd'), C('perFlower', '$ / lb flower', '$ / lb flor', 'usd'),
      C('perSmalls', '$ / lb smalls', '$ / lb smalls', 'usd'), C('perTrim', '$ / lb trim', '$ / lb recorte', 'usd'),
      C('untrimmed', '$ still on bucked', '$ en desvarado', 'usd'), C('stage', 'Where it is', 'Dónde está')];
    const lt = totalOf(rows, lcols);
    lt.perFinished = div(n(lt.total), n(lt.finishedLb));
    lt.perWet = div(n(lt.total), n(lt.wetLb));
    // Time on no lot yet (no UID, a project or farm with no pounds yet).
    const loose = inAl.filter((a) => !a.lotId || a.basis === 'project-pending' || a.basis === 'farm-pending' || a.basis === 'none');
    const sp = ctx.split || A.DEFAULT_TRIM_SPLIT;
    return {
      tiles: [{ l: L('Hours', 'Horas'), v: r2(sum(inAl, 'hours')), t: 'hrs' }, { l: L('Hourly labor', 'Mano de obra por hora'), v: r2(sum(inAl, 'cost')), t: 'usd' },
        { l: L('Trimmer piece pay', 'Pago por pieza'), v: r2(sum(pieceIn, 'cost')), t: 'usd' }, { l: L('Total labor', 'Mano de obra total'), v: pt.cost, t: 'usd' },
        { l: L('Not on a lot yet', 'Sin lote todavía'), v: r2(sum(loose, 'cost')), t: 'usd' }],
      sections: [
        { key: 'process', title: L('By station — time in the range', 'Por estación — tiempo en el rango'), cols: pcols, rows: procs, total: pt },
        { key: 'lots', title: L('By lot — all its labor', 'Por lote — toda su mano de obra'), cols: lcols, rows, total: lt }
      ],
      notes: [L(`Hourly time is the Labor Log at each person’s rate on that day, split over UIDs by pounds the same way the Labor Log does. Trimmer pay is each bag × its page’s $/lb. $/lb by output carries the cost down the stages (water, stems and waste carry none) and splits what reaches trim ${sp.a} / ${sp.smalls} / ${sp.trim} between flower, smalls and trim (Labor Log → Cost / lb). Farm-wide time is an estimate and isn’t in Labor $. Lb handled by station is its input weight in the range (or what it weighed).`,
                `El tiempo por hora es el Registro de Mano de Obra a la tarifa de cada persona, repartido por libras. El pago a cortadores es cada bolsa × $/lb de su hoja. El $/lb por producto reparte lo que llega a corte ${sp.a} / ${sp.smalls} / ${sp.trim} entre flor, smalls y recorte.`)]
    };
  };

  // ── Wet Intake log ──────────────────────────────────────────────────────
  R.intake_log = (D, ctx) => {
    const rows = sub(D, 'intake_wet').filter((i) => inRange(day(i), ctx)).map((i) => {
      const asRow = { station_key: 'intake_wet', status: 'submitted', strain: i.strain, fields: i };
      const cs = i.canixSync || {};
      const metrc = n(cs.metrcLb) || null;
      const wet = n(i.totalWetLb) || null;
      const flags = [];
      if (awaitingCanix(asRow)) flags.push(L('Waiting for Metrc sync', 'Esperando sincronización'));
      if (canixNoManifest(asRow)) flags.push(L('No manifest in Canix', 'Sin manifiesto en Canix'));
      const mismatch = canixStrainMismatch(asRow, ctx.reference);
      if (mismatch) flags.push(L(`Check strain (Canix: ${mismatch})`, `Revisar variedad (Canix: ${mismatch})`));
      if (metrc && wet && Math.abs(wet - metrc) / metrc > 0.02) flags.push(L('Scale ≠ Metrc by >2%', 'Báscula ≠ Metrc por >2%'));
      return {
        date: day(i), time: i.submittedAt ? new Date(i.submittedAt).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }) : '',
        uid: normUid(i.sourceUid), strain: i.strain || '', canixStrain: cs.strain || '', farm: ctx.farmName(i.pid) || i.pid || '',
        license: cs.shipperLicense || '', cid: i.cid || '', manifest: i.manifestNo || cs.manifestNo || '', driver: i.driver || '', truck: i.truckNo || '',
        bins: n(i.binCount) || (i.lines || []).length || null, wetLb: wet, metrcLb: metrc, diffLb: metrc && wet ? r2(wet - metrc) : null,
        room: i.dryRoom || '', ff: isFreshFrozen(i) ? L('Yes', 'Sí') : '', weighmaster: i.weighmaster || '',
        flags: { en: flags.map((f) => f.en).join('; '), es: flags.map((f) => f.es).join('; ') }, flagged: flags.length > 0
      };
    }).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.time).localeCompare(String(a.time)));
    const cols = [C('date', 'Date', 'Fecha', 'date'), C('time', 'Submitted', 'Enviado'), C('uid', 'Package UID', 'UID', 'uid'), C('strain', 'Strain', 'Variedad'),
      C('canixStrain', 'Canix strain', 'Variedad Canix'), C('farm', 'Farm', 'Rancho'), C('license', 'License', 'Licencia'), C('cid', 'CID', 'CID'),
      C('manifest', 'Manifest #', 'Manifiesto', 'uid'), C('driver', 'Driver', 'Chofer'), C('truck', 'Truck', 'Camión'), C('bins', 'Bins', 'Bins', 'int'),
      C('wetLb', 'Scale lb', 'Báscula lb', 'lb'), C('metrcLb', 'Metrc lb', 'Metrc lb', 'lb'), C('diffLb', 'Scale − Metrc', 'Báscula − Metrc', 'lb'),
      C('room', 'Dry room / freezer', 'Cuarto / congelador'), C('ff', 'Fresh frozen', 'Congelado'), C('weighmaster', 'Weighmaster', 'Pesador'), C('flags', 'Needs checking', 'Revisar')];
    const byFarm = [...groupBy(rows, (r) => r.farm || '—')].map(([farm, xs]) => ({ farm, intakes: xs.length, wetLb: r2(sum(xs, 'wetLb')),
      metrcLb: r2(sum(xs, 'metrcLb')) || null, flagged: xs.filter((x) => x.flagged).length || null })).sort((a, b) => b.wetLb - a.wetLb);
    const fcols = [C('farm', 'Farm', 'Rancho'), C('intakes', 'Intakes', 'Recepciones', 'int'), C('wetLb', 'Scale lb', 'Báscula lb', 'lb'),
      C('metrcLb', 'Metrc lb', 'Metrc lb', 'lb'), C('flagged', 'Need checking', 'Por revisar', 'int')];
    return {
      tiles: [{ l: L('Intakes', 'Recepciones'), v: rows.length, t: 'int' }, { l: L('Scale weight', 'Peso de báscula'), v: r2(sum(rows, 'wetLb')), t: 'lb' },
        { l: L('Metrc weight', 'Peso de Metrc'), v: r2(sum(rows, 'metrcLb')), t: 'lb' }, { l: L('Need checking', 'Por revisar'), v: rows.filter((r) => r.flagged).length, t: 'int' }],
      sections: [
        { key: 'farms', title: L('By farm', 'Por rancho'), cols: fcols, rows: byFarm, total: totalOf(byFarm, fcols) },
        { key: 'intakes', title: L('Intakes', 'Recepciones'), cols, rows, total: totalOf(rows, cols) }
      ],
      notes: [L('Farm, license, manifest #, Canix strain and Metrc weight come from the Canix sync. “Check strain” uses Strain Library aliases, like Harvest Intakes.',
                'Rancho, licencia, manifiesto, variedad y peso de Metrc vienen de la sincronización de Canix.')]
    };
  };

  // ── Metrc ───────────────────────────────────────────────────────────────
  const METRC_STATIONS = ['intake_wet', 'dry_check', 'buck', 'hand_trim', 'trim_package', 'preroll_production', 'pouch_production', 'transfer_out'];
  const NEW_TAGS = {
    buck: (r) => [['newBuckedUid', 'buckedFlowerLb', L('Bucked flower', 'Flor desvarada'), r.holdBucked === true || r.holdBucked === 'true']],
    hand_trim: (r) => STATION_BY_KEY.hand_trim.metrcTags.map((x) => [x.k, x.from, x.l, !x.when || x.when(r)]),
    trim_package: () => [['newMixedTrimUid', 'totalLb', L('Mixed trim', 'Recorte mixto'), true]],
    preroll_production: () => [['newPrerollUid', 'totalPrerolls', L('Pre-rolls', 'Prerolls'), true], ['newWasteUid', 'totalWasteG', L('Waste', 'Desecho'), false]],
    pouch_production: () => [['newPouchUid', 'totalPouches', L('Pouches', 'Bolsas'), true], ['newWasteUid', 'totalWasteG', L('Waste', 'Desecho'), false]],
    smalls_trim: () => [['newFinishedUid', 'finishedSmallsLb', L('Finished smalls', 'Smalls terminados'), false]]
  };
  const MQ = { todo: L('To do', 'Por hacer'), in_progress: L('In progress', 'En curso'), done: L('Done', 'Hecho'), not_needed: L('Not needed', 'No necesario') };
  R.metrc_activity = (D, ctx) => {
    const q = ctx.metrcQueue || new Map();
    const forms = METRC_STATIONS.flatMap((k) => sub(D, k).filter((r) => r.owner !== 'paper_import' && inRange(day(r), ctx)));
    const statusOf = (r) => (q.get(r.id) || {}).status || 'todo';
    const byStation = METRC_STATIONS.map((k) => {
      const xs = forms.filter((r) => r.stationKey === k);
      const row = { station: title(k), forms: xs.length };
      Object.keys(MQ).forEach((s) => { row[s] = xs.filter((r) => statusOf(r) === s).length || null; });
      return row;
    }).filter((r) => r.forms);
    const scols = [C('station', 'Form', 'Formulario'), C('forms', 'Submitted', 'Enviados', 'int'), ...Object.entries(MQ).map(([k, l]) => ({ k, l, t: 'int' }))];
    const tags = [];
    Object.entries(NEW_TAGS).forEach(([k, list]) => sub(D, k).filter((r) => r.owner !== 'paper_import' && inRange(day(r), ctx)).forEach((r) => {
      list(r).forEach(([field, from, label, needed]) => {
        const has = String(r[field] || '').trim();
        if (!has && !(needed && n(r[from]) > 0)) return;
        tags.push({ date: day(r), form: title(k), strain: r.strain || '', source: normUid(r.sourceUid || ((r.lines || [])[0] || {}).sourceUid), output: label,
          tag: normUid(has), state: has ? L('Made', 'Hecha') : L('Missing', 'Falta'), missing: !has });
      });
    }));
    tags.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const tcols = [C('date', 'Date', 'Fecha', 'date'), C('form', 'Form', 'Formulario'), C('strain', 'Strain', 'Variedad'), C('source', 'Source UID', 'UID origen', 'uid'),
      C('output', 'Output', 'Producto'), C('tag', 'New tag', 'Etiqueta nueva', 'uid'), C('state', 'Tag', 'Etiqueta')];
    const pending = forms.filter((r) => ['todo', 'in_progress'].includes(statusOf(r))).map((r) => ({
      date: day(r), form: title(r.stationKey), strain: r.strain || '', uid: normUid(r.sourceUid || ((r.lines || [])[0] || {}).sourceUid || r.manifestNo),
      status: MQ[statusOf(r)], age: daysBetween(day(r), ctx.today), note: (q.get(r.id) || {}).note || '', by: (q.get(r.id) || {}).updated_by || ''
    })).sort((a, b) => n(b.age) - n(a.age));
    const pcols = [C('date', 'Date', 'Fecha', 'date'), C('form', 'Form', 'Formulario'), C('strain', 'Strain', 'Variedad'), C('uid', 'UID / manifest', 'UID / manifiesto', 'uid'),
      C('status', 'Status', 'Estado'), C('age', 'Days waiting', 'Días esperando', 'int'), C('note', 'Note', 'Nota'), C('by', 'Last update by', 'Actualizado por')];
    return {
      tiles: [{ l: L('Forms', 'Formularios'), v: forms.length, t: 'int' }, { l: L('Done in Metrc', 'Hecho en Metrc'), v: forms.filter((r) => statusOf(r) === 'done').length, t: 'int' },
        { l: L('Still pending', 'Pendientes'), v: pending.length, t: 'int' }, { l: L('New tags made', 'Etiquetas hechas'), v: tags.filter((x) => !x.missing).length, t: 'int' },
        { l: L('Tags missing', 'Etiquetas faltantes'), v: tags.filter((x) => x.missing).length, t: 'int' }],
      sections: [
        { key: 'status', title: L('Metrc Queue status by form', 'Estado en la Cola de Metrc'), cols: scols, rows: byStation, total: totalOf(byStation, scols) },
        { key: 'pending', title: L('Still pending', 'Pendientes'), cols: pcols, rows: pending },
        { key: 'tags', title: L('New Metrc tags', 'Etiquetas Metrc nuevas'), cols: tcols, rows: tags }
      ],
      notes: [L('Forms submitted in the range on the Metrc Queue’s stations (paper-sheet imports left out), with their status now. A tag is missing when the form made that output and the Metrc Queue hasn’t had its new tag entered.',
                'Formularios del rango en las estaciones de la Cola de Metrc, con su estado actual. Falta una etiqueta cuando el formulario hizo ese producto y no se ha ingresado su etiqueta nueva.')]
    };
  };

  // ── Hand Trim — Metrc reconciliation ────────────────────────────────────
  // What the trimmers weighed (and are paid on) against the finished flower
  // and smalls packages made in Metrc from the same lot: the tag the Metrc
  // Queue entered (newFinishedUid / newSmallsUid) looked up in the Canix
  // packages, at the weight the package was created with. With no tag
  // entered, a Canix Flower / Smalls package made from the lot's UID is
  // shown as found. ctx.packages: canix_packages_recent.json +
  // canix_inventory.json rows.
  const TO_LB = { pounds: 1, lb: 1, lbs: 1, kilograms: 2.20462, kg: 2.20462, grams: 1 / G_PER_LB, g: 1 / G_PER_LB, ounces: 0.0625, oz: 0.0625 };
  const pkgLb = (p, w) => n(p[w]) * (TO_LB[String(p.weight_unit || 'pounds').toLowerCase()] || 1);
  const pkgItem = (p) => String((p.item && p.item.name) || '');
  const PKG_KIND = { flower: (p) => /^\s*flower\b/i.test(pkgItem(p)), smalls: (p) => /^\s*smalls\b/i.test(pkgItem(p)) };
  const RECON = {
    open: L('Still trimming (page open)', 'Aún cortando (hoja abierta)'),
    nobags: L('No bags weighed', 'Sin bolsas pesadas'),
    notNeeded: L('Marked “Not needed” in Metrc Queue — no package', 'Marcado “No necesario” en la Cola de Metrc — sin paquete'),
    nopkg: L('No Metrc package yet', 'Sin paquete en Metrc'),
    found: L('Package in Canix, tag not entered in Metrc Queue', 'Paquete en Canix, etiqueta sin ingresar'),
    notInCanix: L('Tag entered, not in Canix data', 'Etiqueta ingresada, no está en Canix'),
    over: L('Weights differ — over tolerance', 'Pesos no cuadran — fuera de tolerancia'),
    ok: L('Matches', 'Cuadra')
  };
  const SIGNOFF = { waiting: L('Not signed off', 'Sin confirmar'), changed: L('Changed after sign-off', 'Cambió después de confirmar'), confirmed: L('Signed off', 'Confirmado') };
  R.trim_metrc_recon = (D, ctx) => {
    const p = ctx.params || {};
    const tol = (p.tol != null && p.tol !== '' ? Number(p.tol) : 1) / 100;
    const q = ctx.metrcQueue || new Map();
    const pkgs = new Map();
    (ctx.packages || []).forEach((x) => { const t = normUid(x.tag); if (t && !pkgs.has(t)) pkgs.set(t, x); });
    const pkgList = [...pkgs.values()];
    const findTag = (tag) => {
      const t = normUid(tag);
      if (!t) return null;
      if (pkgs.has(t)) return pkgs.get(t);
      return t.length >= 4 && t.length < 24 ? pkgList.find((x) => normUid(x.tag).endsWith(t)) || null : null;
    };
    const fromLot = (uid, kind) => {
      const u = normUid(uid);
      if (u.length < 4) return [];
      return pkgList.filter((x) => PKG_KIND[kind](x) && (x.source_packages || []).some((s) => {
        const t = normUid(s && s.tag);
        return t && (t === u || (Math.min(t.length, u.length) >= 4 && (t.endsWith(u) || u.endsWith(t))));
      }));
    };
    const station = STATION_BY_KEY.hand_trim;
    const recs = (p.open === false ? sub(D, 'hand_trim') : both(D, 'hand_trim')).filter((r) => r.owner !== 'paper_import');
    const name = (b) => (ctx.personName && ctx.personName(b)) || '';
    const lots = [];
    const bagLines = [];
    recs.forEach((r) => {
      const bags = (r.weights || []).map((w) => ({ day: String(w.day || day(r)), badge: A.badgeKey(w.employeeNo), lb: n(w.grams) / G_PER_LB }));
      const inR = bags.filter((b) => inRange(b.day, ctx));
      const isOpen = r.status === 'draft';
      if (!inR.length && !(bags.length === 0 && !isOpen && inRange(day(r), ctx))) return;
      const trimmerLb = sum(bags, 'lb');
      const rate = n(r.trimRatePerLb) || null;
      const days = uniq(bags.map((b) => b.day)).sort();
      const out = (kind, tagField, formLb) => {
        const tag = String(r[tagField] || '').trim();
        let list = [], how = '';
        if (tag) { const hit = findTag(tag); if (hit) list = [hit]; how = hit ? 'tag' : 'missing'; }
        else { list = isOpen ? [] : fromLot(r.sourceUid, kind); how = list.length ? 'found' : 'none'; }
        const created = list.length ? sum(list, (x) => pkgLb(x, x.original_weight != null && x.original_weight !== '' ? 'original_weight' : 'weight')) : null;
        return { tag: tag || list.map((x) => x.tag).join(', '), how, list, metrcLb: created != null ? r2(created) : null,
          nowLb: list.length ? r2(sum(list, (x) => pkgLb(x, 'weight'))) : null,
          diff: created != null ? r2(created - formLb) : null, diffPct: created != null && formLb > 0 ? (created - formLb) / formLb : null,
          date: uniq(list.map((x) => String(x.packaged_date || '').slice(0, 10))).sort().join(', ') };
      };
      const fl = out('flower', 'newFinishedUid', trimmerLb);
      const sm = out('smalls', 'newSmallsUid', n(r.smallsLb));
      const qs = (q.get(r.id) || {}).status || (isOpen ? '' : 'todo');
      const sign = weightCheckState(station, r);
      const c = r.weightsConfirmed || {};
      let res;
      if (isOpen) res = 'open';
      else if (!bags.length) res = 'nobags';
      else if (fl.how === 'missing') res = 'notInCanix';
      else if (fl.how === 'none') res = qs === 'not_needed' ? 'notNeeded' : 'nopkg';
      else if (fl.diffPct != null && Math.abs(fl.diffPct) > tol) res = 'over';
      else if (fl.how === 'found') res = 'found';
      else res = 'ok';
      const lot = {
        id: r.id, uid: normUid(r.sourceUid), strain: r.strain || '', cid: r.cid || '',
        trimmed: days.length ? (days[0] === days[days.length - 1] ? days[0] : `${days[0]} – ${days[days.length - 1]}`) : day(r),
        lastDay: days[days.length - 1] || day(r), submitted: isOpen ? '' : String(r.submittedAt || '').slice(0, 10),
        trimmers: uniq(bags.map((b) => b.badge)).length, bags: bags.length, trimmerLb: r2(trimmerLb) || null,
        rangeLb: r2(sum(inR, 'lb')) || null, rate, pay: rate != null ? r2(trimmerLb * rate) : null,
        signoff: sign && !isOpen ? SIGNOFF[sign] : '', signedBy: c.by ? `${c.by}${c.at ? ' · ' + String(c.at).slice(0, 10) : ''}` : '',
        confirmedLb: c.lbs && c.lbs.finishedFlowerLb != null ? r2(n(c.lbs.finishedFlowerLb)) : null,
        queue: qs ? MQ[qs] || qs : '',
        flowerTag: fl.tag, flowerDate: fl.date, metrcLb: fl.metrcLb, metrcNowLb: fl.nowLb, diffLb: fl.diff, diffPct: fl.diffPct,
        smallsLb: r2(n(r.smallsLb)) || null, smallsTag: sm.tag, smallsMetrcLb: sm.metrcLb, smallsDiffLb: sm.diff,
        result: RECON[res], res, isOpen, flPkgs: fl.list, smPkgs: sm.list, flHow: fl.how, smHow: sm.how,
        ratio: fl.metrcLb != null && trimmerLb > 0 ? fl.metrcLb / trimmerLb : null
      };
      lots.push(lot);
      inR.forEach((b) => bagLines.push({ ...b, lot }));
    });
    lots.sort((a, b) => String(b.lastDay).localeCompare(String(a.lastDay)) || a.strain.localeCompare(b.strain));
    const lcols = [C('trimmed', 'Trimmed', 'Cortado'), C('submitted', 'Submitted', 'Enviado', 'date'), C('strain', 'Strain', 'Variedad'),
      C('uid', 'Lot UID (batch)', 'UID del lote', 'uid'), C('trimmers', 'Trimmers', 'Cortadores', 'int'), C('bags', 'Bags', 'Bolsas', 'int'),
      C('trimmerLb', 'Trimmer flower lb', 'Flor de cortadores lb', 'lb'), C('rate', '$/lb', '$/lb', 'usd'), C('pay', 'Trimmer pay', 'Pago', 'usd'),
      C('signoff', 'Weight sign-off', 'Confirmación de peso'), C('signedBy', 'Signed off by', 'Confirmado por'), C('confirmedLb', 'Signed-off flower lb', 'Flor confirmada lb', 'lb'),
      C('queue', 'Metrc Queue', 'Cola de Metrc'), C('flowerTag', 'Finished flower tag', 'Etiqueta flor terminada', 'uid'), C('flowerDate', 'Packaged in Metrc', 'Empacado en Metrc'),
      C('metrcLb', 'Metrc flower lb (created)', 'Flor Metrc lb (al crear)', 'lb'), C('diffLb', 'Metrc − trimmers lb', 'Metrc − cortadores lb', 'lb'),
      C('diffPct', 'Difference %', 'Diferencia %', 'pct'), C('smallsLb', 'Smalls on form lb', 'Smalls en hoja lb', 'lb'), C('smallsTag', 'Smalls tag', 'Etiqueta smalls', 'uid'),
      C('smallsMetrcLb', 'Metrc smalls lb', 'Smalls Metrc lb', 'lb'), C('smallsDiffLb', 'Smalls Metrc − form lb', 'Smalls Metrc − hoja lb', 'lb'), C('result', 'Result', 'Resultado')];
    const lt = totalOf(lots, lcols, L(`Total — ${lots.length} lots`, `Total — ${lots.length} lotes`));
    ['diffLb', 'smallsDiffLb'].forEach((k) => { lt[k] = r2(sum(lots, k)); });
    const packed = lots.filter((x) => x.metrcLb != null);
    lt.diffPct = div(sum(packed, 'metrcLb') - sum(packed, 'trimmerLb'), sum(packed, 'trimmerLb'));

    // By date: what was weighed (paid) that day, and what was packaged in
    // Metrc that day from these lots.
    const pkgRows = [];
    lots.forEach((x) => [['flPkgs', L('Finished flower', 'Flor terminada')], ['smPkgs', L('Smalls', 'Smalls')]].forEach(([k, what]) => x[k].forEach((pk) => {
      pkgRows.push({ date: String(pk.packaged_date || '').slice(0, 10), tag: normUid(pk.tag), what, item: pkgItem(pk), metrcLb: r2(pkgLb(pk, pk.original_weight != null && pk.original_weight !== '' ? 'original_weight' : 'weight')),
        nowLb: r2(pkgLb(pk, 'weight')), status: pk.status || '', facility: pk._facility_name || '', uid: x.uid, strain: x.strain,
        formLb: k === 'flPkgs' ? x.trimmerLb : x.smallsLb,
        entered: x[k === 'flPkgs' ? 'flHow' : 'smHow'] === 'tag' ? L('Tag entered in Metrc Queue', 'Etiqueta ingresada en la Cola') : L('Found from the lot UID', 'Encontrada por el UID del lote') });
    })));
    pkgRows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.uid.localeCompare(b.uid));
    const kcols = [C('date', 'Packaged', 'Empacado', 'date'), C('tag', 'Metrc package tag', 'Etiqueta Metrc', 'uid'), C('what', 'Output', 'Producto'), C('item', 'Metrc item', 'Artículo Metrc'),
      C('strain', 'Strain', 'Variedad'), C('uid', 'From lot UID', 'Del lote UID', 'uid'), C('metrcLb', 'Created lb', 'Lb al crear', 'lb'), C('nowLb', 'On hand now lb', 'Disponible lb', 'lb'),
      C('formLb', 'Hand Trim form lb', 'Hoja de corte lb', 'lb'), C('status', 'Metrc status', 'Estado Metrc'), C('facility', 'License', 'Licencia'), C('entered', 'How matched', 'Cómo se encontró')];
    const daily = [...groupBy(bagLines, (b) => b.day)].map(([d, xs]) => {
      const pk = pkgRows.filter((x) => x.date === d && x.what.en === 'Finished flower');
      const paid = xs.filter((b) => b.lot.rate != null);
      return { day: d, lots: uniq(xs.map((b) => b.lot.id)).length, trimmers: uniq(xs.map((b) => b.badge)).length, bags: xs.length,
        lb: r2(sum(xs, 'lb')), pay: paid.length ? r2(sum(paid, (b) => b.lb * b.lot.rate)) : null,
        pkgs: pk.length || null, metrcLb: pk.length ? r2(sum(pk, 'metrcLb')) : null };
    });
    // Package days with no trimming that day still show.
    uniq(pkgRows.filter((x) => x.what.en === 'Finished flower' && inRange(x.date, ctx)).map((x) => x.date)).forEach((d) => {
      if (daily.some((x) => x.day === d)) return;
      const pk = pkgRows.filter((x) => x.date === d && x.what.en === 'Finished flower');
      daily.push({ day: d, lots: null, trimmers: null, bags: null, lb: null, pay: null, pkgs: pk.length, metrcLb: r2(sum(pk, 'metrcLb')) });
    });
    daily.sort((a, b) => a.day.localeCompare(b.day));
    const ycols = [C('day', 'Day', 'Día', 'date'), C('lots', 'Lots trimmed', 'Lotes cortados', 'int'), C('trimmers', 'Trimmers', 'Cortadores', 'int'), C('bags', 'Bags', 'Bolsas', 'int'),
      C('lb', 'Trimmer flower lb weighed', 'Flor pesada lb', 'lb'), C('pay', 'Trimmer pay', 'Pago', 'usd'),
      C('pkgs', 'Flower packages made in Metrc', 'Paquetes de flor en Metrc', 'int'), C('metrcLb', 'Metrc flower lb packaged', 'Flor empacada en Metrc lb', 'lb')];

    // By trimmer: each person's pounds, and the share of the lot's Metrc
    // package those pounds stand for (their lb × Metrc lb ÷ trimmers' lb).
    const detail = [...groupBy(bagLines, (b) => [b.badge, b.day, b.lot.id].join('|'))].map(([, xs]) => {
      const x = xs[0], lot = x.lot, lb = sum(xs, 'lb');
      return { day: x.day, badge: x.badge, name: name(x.badge), strain: lot.strain, uid: lot.uid, bags: xs.length, lb: r2(lb),
        rate: lot.rate, pay: lot.rate != null ? r2(lb * lot.rate) : null,
        metrcShare: lot.ratio != null ? r2(lb * lot.ratio) : null, result: lot.result, _ok: lot.ratio != null };
    }).sort((a, b) => a.day.localeCompare(b.day) || String(a.name || a.badge).localeCompare(String(b.name || b.badge)));
    const dcols = [C('day', 'Day', 'Día', 'date'), C('badge', 'Badge #', 'N.º'), C('name', 'Name', 'Nombre'), C('strain', 'Strain', 'Variedad'),
      C('uid', 'Lot UID', 'UID', 'uid'), C('bags', 'Bags', 'Bolsas', 'int'), C('lb', 'Lb weighed', 'Lb pesadas', 'lb'), C('rate', '$/lb', '$/lb', 'usd'),
      C('pay', 'Pay', 'Pago', 'usd'), C('metrcShare', 'Share of Metrc lb', 'Parte de lb Metrc', 'lb'), C('result', 'Lot result', 'Resultado del lote')];
    const people = [...groupBy(detail, (x) => x.badge)].map(([badge, xs]) => {
      const ok = xs.filter((x) => x._ok);
      return { badge, name: name(badge), days: uniq(xs.map((x) => x.day)).length, lots: uniq(xs.map((x) => x.uid)).length,
        lb: r2(sum(xs, 'lb')), pay: r2(sum(xs, 'pay')) || null, okLb: r2(sum(ok, 'lb')) || null, metrcShare: r2(sum(ok, 'metrcShare')) || null,
        diffLb: ok.length ? r2(sum(ok, 'metrcShare') - sum(ok, 'lb')) : null, waitLb: r2(sum(xs.filter((x) => !x._ok), 'lb')) || null };
    }).sort((a, b) => n(b.lb) - n(a.lb));
    const pcols = [C('badge', 'Badge #', 'N.º'), C('name', 'Name', 'Nombre'), C('days', 'Days', 'Días', 'int'), C('lots', 'Lots', 'Lotes', 'int'),
      C('lb', 'Lb weighed (paid)', 'Lb pesadas (pagadas)', 'lb'), C('pay', 'Pay', 'Pago', 'usd'), C('okLb', 'Lb on lots packaged in Metrc', 'Lb en lotes empacados', 'lb'),
      C('metrcShare', 'Share of Metrc lb', 'Parte de lb Metrc', 'lb'), C('diffLb', 'Metrc share − weighed', 'Parte Metrc − pesado', 'lb'),
      C('waitLb', 'Lb not in Metrc yet', 'Lb aún no en Metrc', 'lb')];
    const pt = totalOf(people, pcols);
    pt.diffLb = r2(sum(people, 'diffLb'));

    const attention = lots.filter((x) => !['ok', 'open'].includes(x.res) || (x.res === 'ok' && x.signoff && x.signoff.en !== 'Signed off'));
    return {
      tiles: [{ l: L('Lots', 'Lotes'), v: lots.length, t: 'int' },
        { l: L('Trimmer flower weighed', 'Flor pesada por cortadores'), v: r2(sum(bagLines, 'lb')), t: 'lb' },
        { l: L('Trimmer pay', 'Pago a cortadores'), v: r2(sum(detail, 'pay')), t: 'usd' },
        { l: L('Lots packaged in Metrc', 'Lotes empacados en Metrc'), v: packed.length, t: 'int' },
        { l: L('Metrc flower lb (packaged lots)', 'Flor Metrc lb (lotes empacados)'), v: r2(sum(packed, 'metrcLb')), t: 'lb' },
        { l: L('Metrc − trimmers (packaged lots)', 'Metrc − cortadores (lotes empacados)'), v: r2(sum(packed, 'metrcLb') - sum(packed, 'trimmerLb')), t: 'lb' },
        { l: L('Lots needing attention', 'Lotes por revisar'), v: attention.length, t: 'int' }],
      sections: [
        { key: 'lots', title: L('By lot (batch / UID) — trimmers vs Metrc', 'Por lote (UID) — cortadores contra Metrc'), cols: lcols, rows: lots, total: lt },
        { key: 'daily', title: L('By date', 'Por fecha'), cols: ycols, rows: daily, total: totalOf(daily, ycols) },
        { key: 'packages', title: L('Finished packages made in Metrc from these lots', 'Paquetes terminados creados en Metrc de estos lotes'), cols: kcols, rows: pkgRows },
        { key: 'people', title: L('By trimmer', 'Por cortador'), cols: pcols, rows: people, total: pt },
        { key: 'detail', title: L('By trimmer, day and lot', 'Por cortador, día y lote'), cols: dcols, rows: detail, total: totalOf(detail, dcols) }
      ],
      notes: [
        L(`Hand Trim lots with a bag weighed in the range (open pages included unless unticked; paper-sheet imports left out). Trimmer lb is every bag on the lot — what the trimmers are paid on; By date and By trimmer count only the bags weighed in the range.`,
          'Lotes de corte a mano con una bolsa pesada en el rango (con hojas abiertas salvo que se desmarque). Lb de cortadores es cada bolsa del lote — lo que se paga; Por fecha y Por cortador cuentan solo las bolsas del rango.'),
        L(`Metrc lb is the weight the package was created with in Metrc (Canix sync), so later sales don’t change it. The package is the tag entered in the Metrc Queue; with none, a Canix “Flower …” / “Smalls …” package made from the lot’s UID. A lot matches when Metrc is within ${(tol * 100).toFixed(1)}% of the trimmers’ weight.`,
          `Lb de Metrc es el peso con que se creó el paquete en Metrc (sincronización de Canix). Un lote cuadra cuando Metrc está dentro del ${(tol * 100).toFixed(1)}% del peso de los cortadores.`),
        L('Share of Metrc lb splits a lot’s Metrc package across its trimmers by the pounds each weighed, to check payroll against what was packaged.',
          'Parte de lb Metrc reparte el paquete de Metrc del lote entre sus cortadores según lo que pesó cada uno, para cotejar la nómina con lo empacado.')
      ]
    };
  };

  // ── Transfers ───────────────────────────────────────────────────────────
  R.transfers = (D, ctx) => {
    const out = [];
    sub(D, 'transfer_out').forEach((r) => {
      const d = String(r.actualDate || r.date || '').slice(0, 10);
      if (!inRange(d, ctx)) return;
      (r.lines || []).forEach((x) => {
        const ty = TRANSFER_TYPES[x.productType] || {};
        out.push({ date: d, manifest: r.manifestNo || '', customer: r.customer || '', license: r.dccLicense || '', product: ty.l || L(String(x.productType || '')),
          strain: x.strain || '', uid: normUid(x.sourceUid), cid: x.cid || '', farm: ctx.farmName(x.pid) || x.pid || '',
          lb: ty.pieces ? null : r2(n(x.weight)) || null, pieces: ty.pieces ? n(x.weight) || null : null });
      });
    });
    out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const ocols = [C('date', 'Date', 'Fecha', 'date'), C('manifest', 'Manifest #', 'Manifiesto', 'uid'), C('customer', 'Customer', 'Cliente'), C('license', 'Their license', 'Su licencia'),
      C('product', 'Product', 'Producto'), C('strain', 'Strain', 'Variedad'), C('uid', 'UID', 'UID', 'uid'), C('cid', 'CID', 'CID'), C('farm', 'Farm', 'Rancho'),
      C('lb', 'Lb', 'Lb', 'lb'), C('pieces', 'Pieces', 'Piezas', 'int')];
    const byCust = [...groupBy(out, (x) => x.customer || '—')].map(([customer, xs]) => ({ customer, transfers: uniq(xs.map((x) => x.date + x.manifest)).length,
      lines: xs.length, lb: r2(sum(xs, 'lb')) || null, pieces: sum(xs, 'pieces') || null })).sort((a, b) => n(b.lb) - n(a.lb));
    const ccols = [C('customer', 'Customer', 'Cliente'), C('transfers', 'Transfers', 'Transferencias', 'int'), C('lines', 'Packages', 'Paquetes', 'int'),
      C('lb', 'Lb', 'Lb', 'lb'), C('pieces', 'Pieces', 'Piezas', 'int')];
    const byProd = [...groupBy(out, (x) => x.product.en)].map(([, xs]) => ({ product: xs[0].product, lines: xs.length, lb: r2(sum(xs, 'lb')) || null, pieces: sum(xs, 'pieces') || null }));
    const prcols = [C('product', 'Product', 'Producto'), C('lines', 'Packages', 'Paquetes', 'int'), C('lb', 'Lb', 'Lb', 'lb'), C('pieces', 'Pieces', 'Piezas', 'int')];

    // Incoming, from the Canix sync: a destination that's one of our
    // licenses. Accepted at ≈ when Canix last updated the last package to
    // turn Accepted (Canix gives no accept time of its own).
    const ours = new Map(((ctx.canix || {}).facilities || []).filter((f) => f && f.license_number).map((f) => [f.license_number, f.name || f.license_number]));
    const inc = [];
    let earliest = null;
    ((ctx.canix || {}).transfers || []).forEach((t) => (t.destinations || []).forEach((d) => {
      if (!ours.has(d.destination_facility)) return;
      const left = MetrcTransfers.pacificTime(d.departure_time);
      if (left == null) return;
      const dd = new Date(left).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      if (!earliest || dd < earliest) earliest = dd;
      if (!inRange(dd, ctx)) return;
      const c = (d.contents || []).filter((x) => x && x.status !== 'Voided');
      if (!c.length) return;
      const allAcc = c.every((x) => x.status === 'Accepted');
      const accAt = allAcc ? Math.max(...c.map((x) => Date.parse(x.updated_at) || 0)) : null;
      const hrs = accAt ? (accAt - left) / 3600000 : null;
      const lbs = c.reduce((a, x) => a + (String(x.shipped_weight_unit || 'Pounds').toLowerCase().startsWith('pound') ? n(x.shipped_weight) : 0), 0);
      inc.push({ date: dd, manifest: t.manifest_number || '', from: t._facility_name || t._facility_license_number || '', to: ours.get(d.destination_facility),
        packages: c.length, lb: r2(lbs) || null, status: allAcc ? L('Accepted', 'Aceptado') : c.some((x) => x.status === 'Rejected') ? L('Rejected', 'Rechazado') : L('Not accepted yet', 'Sin aceptar'),
        hours: hrs != null ? r2(hrs) : null, late: hrs != null ? (hrs > MetrcTransfers.ACCEPT_WITHIN_H ? L('Maybe late — check Metrc', 'Quizá tarde — revisar Metrc') : L('Within 24 h', 'En 24 h')) : '',
        isLate: hrs != null && hrs > MetrcTransfers.ACCEPT_WITHIN_H });
    }));
    inc.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const icols = [C('date', 'Departed', 'Salió', 'date'), C('manifest', 'Manifest #', 'Manifiesto', 'uid'), C('from', 'From', 'De'), C('to', 'To (ours)', 'A (nuestra)'),
      C('packages', 'Packages', 'Paquetes', 'int'), C('lb', 'Lb', 'Lb', 'lb'), C('status', 'Status', 'Estado'), C('hours', 'Hours to Canix update (≈ accept)', 'Horas a la actualización de Canix (≈ aceptar)', 'hrs'), C('late', '24-hour rule', 'Regla de 24 h')];
    const notes = [L('Outgoing: Product Transfer — Outgoing forms by their actual ship date. Incoming: transfers to our licenses from the Canix sync, which keeps the last 30 days; an outside farm’s transfer isn’t in Canix until it’s accepted. Canix doesn’t give the accept time, so the hours run from departure to when Canix last updated the accepted packages — that can be later than the accept. “Maybe late” means check the transfer in Metrc, not that it was late.',
                   'Salida: formularios de transferencia por su fecha real. Entrada: transferencias a nuestras licencias de la sincronización de Canix (últimos 30 días). Las horas para aceptar van de la salida a la última actualización de Canix.')];
    if (earliest && ctx.from < earliest) notes.push(L(`Canix transfers on file start ${earliest}; earlier incoming transfers aren’t shown.`, `Las transferencias de Canix empiezan el ${earliest}.`));
    return {
      tiles: [{ l: L('Outgoing transfers', 'Transferencias de salida'), v: uniq(out.map((x) => x.date + x.manifest + x.customer)).length, t: 'int' },
        { l: L('Shipped', 'Enviado'), v: r2(sum(out, 'lb')), t: 'lb' }, { l: L('Incoming transfers', 'Transferencias de entrada'), v: inc.length, t: 'int' },
        { l: L('Maybe accepted late', 'Quizá aceptadas tarde'), v: inc.filter((x) => x.isLate).length, t: 'int' }],
      sections: [
        { key: 'customers', title: L('Outgoing by customer', 'Salida por cliente'), cols: ccols, rows: byCust, total: totalOf(byCust, ccols) },
        { key: 'products', title: L('Outgoing by product', 'Salida por producto'), cols: prcols, rows: byProd, total: totalOf(byProd, prcols) },
        { key: 'outgoing', title: L('Outgoing packages', 'Paquetes enviados'), cols: ocols, rows: out, total: totalOf(out, ocols) },
        { key: 'incoming', title: L('Incoming transfers', 'Transferencias de entrada'), cols: icols, rows: inc, total: totalOf(inc, icols) }
      ],
      notes
    };
  };

  // ── Waste ───────────────────────────────────────────────────────────────
  R.waste_log = (D, ctx) => {
    const rows = [];
    const unweighed = [];
    OPERATIONS_STATIONS.forEach((s) => {
      const outs = ((s.flow && s.flow.outputs) || []).filter((o) => NOT_PRODUCT.includes(o.category));
      const label = (field) => { const f = s.fields.find((x) => x.k === field); return f ? f.l : L(field); };
      sub(D, s.key).filter((r) => inRange(day(r), ctx)).forEach((r) => {
        outs.forEach((o) => {
          const lb = n(r[o.field]);
          if (lb > 0.004) rows.push({ date: day(r), station: s.title, strain: r.strain || '', uid: normUid(r.sourceUid), reason: label(o.field),
            cat: BIOMASS[o.category] || L(o.category), lb: r2(lb), tag: normUid(r.newWasteUid) });
        });
        // Pre-roll / pouch waste is in grams on the output rows.
        if (['preroll_production', 'pouch_production'].includes(s.key) && n(r.totalWasteG) > 0) {
          rows.push({ date: day(r), station: s.title, strain: r.strain || '', uid: normUid(r.sourceUid || ((r.lines || [])[0] || {}).sourceUid),
            reason: L('Production waste', 'Desecho de producción'), cat: BIOMASS.waste, lb: r2(n(r.totalWasteG) / G_PER_LB), tag: normUid(r.newWasteUid) });
        }
        if (s.flow && s.flow.lossKind === 'conserving') {
          const inLb = inLbOf(s, r), outLb = outLbOf(s, r);
          if (inLb > 0 && inLb - outLb > 0.004) unweighed.push({ station: s.title, key: s.key, lb: inLb - outLb, inLb });
        }
      });
    });
    rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const cols = [C('date', 'Date', 'Fecha', 'date'), C('station', 'Station', 'Estación'), C('strain', 'Strain', 'Variedad'), C('uid', 'UID', 'UID', 'uid'),
      C('reason', 'What', 'Qué'), C('cat', 'Category', 'Categoría'), C('lb', 'Lb', 'Lb', 'lb'), C('tag', 'Waste tag', 'Etiqueta de desecho', 'uid')];
    const byReason = [...groupBy(rows, (x) => x.station.en + '|' + x.reason.en)].map(([, xs]) => ({ station: xs[0].station, reason: xs[0].reason, records: xs.length, lb: r2(sum(xs, 'lb')) }))
      .sort((a, b) => b.lb - a.lb);
    const rcols = [C('station', 'Station', 'Estación'), C('reason', 'What', 'Qué'), C('records', 'Forms', 'Formularios', 'int'), C('lb', 'Lb', 'Lb', 'lb')];
    const unw = [...groupBy(unweighed, (x) => x.key)].map(([, xs]) => ({ station: xs[0].station, forms: xs.length, inLb: r2(sum(xs, 'inLb')), lb: r2(sum(xs, 'lb')),
      pct: div(sum(xs, 'lb'), sum(xs, 'inLb')) }));
    const ucols = [C('station', 'Station', 'Estación'), C('forms', 'Forms', 'Formularios', 'int'), C('inLb', 'In lb', 'Entrada lb', 'lb'),
      C('lb', 'Not weighed out lb', 'Sin pesar lb', 'lb'), C('pct', '% of input', '% de la entrada', 'pct')];
    return {
      tiles: [{ l: L('Weighed waste & stems', 'Desecho y tallos pesados'), v: r2(sum(rows, 'lb')), t: 'lb' },
        { l: L('Stems', 'Tallos'), v: r2(sum(rows.filter((x) => x.cat === BIOMASS.stems), 'lb')), t: 'lb' },
        { l: L('Waste', 'Desecho'), v: r2(sum(rows.filter((x) => x.cat === BIOMASS.waste), 'lb')), t: 'lb' },
        { l: L('Not weighed out', 'Sin pesar'), v: r2(sum(unweighed, 'lb')), t: 'lb' }],
      sections: [
        { key: 'reasons', title: L('By station and kind', 'Por estación y tipo'), cols: rcols, rows: byReason, total: totalOf(byReason, rcols) },
        { key: 'records', title: L('Every waste record', 'Cada registro de desecho'), cols, rows, total: totalOf(rows, cols) },
        { key: 'unweighed', title: L('Input not weighed out (shrink)', 'Entrada sin pesar (merma)'), cols: ucols, rows: unw, total: totalOf(unw, ucols) }
      ],
      notes: [L('Weighed waste, mold, floor waste, stems and big leaf on submitted forms, by the form’s date. “Not weighed out” is input minus everything weighed out on Bucking and trim forms — moisture and anything not put on a scale; it isn’t waste for Metrc.',
                'Desecho, moho, desecho del piso, tallos y hoja grande pesados en formularios enviados. “Sin pesar” es la entrada menos todo lo pesado — humedad y lo no pesado; no es desecho para Metrc.')]
    };
  };

  // ── Customer / farm summary ─────────────────────────────────────────────
  function customerOptions(D, ctx) {
    const pids = uniq([...sub(D, 'intake_wet'), ...sub(D, 'dry_check')].map((r) => r.pid));
    const cids = uniq([...sub(D, 'intake_wet'), ...sub(D, 'dry_check'), ...sub(D, 'hand_trim'), ...sub(D, 'transfer_out').flatMap((r) => r.lines || [])].map((r) => r.cid));
    return [
      ...pids.map((p) => ({ v: `pid:${p}`, l: L(`Farm: ${ctx.farmName(p) ? `${ctx.farmName(p)} (${p})` : p}`, `Rancho: ${ctx.farmName(p) ? `${ctx.farmName(p)} (${p})` : p}`) })),
      ...cids.map((c) => ({ v: `cid:${c}`, l: L(`Customer ID: ${c}`, `ID de cliente: ${c}`) }))
    ].sort((a, b) => a.l.en.localeCompare(b.l.en));
  }
  R.customer_summary = (D, ctx) => {
    const who = String((ctx.params || {}).who || '');
    if (!who) return { tiles: [], sections: [], notes: [L('Pick a farm or customer above.', 'Elija un rancho o cliente arriba.')] };
    const [kind, val] = [who.slice(0, 3), who.slice(4)];
    const match = (r) => kind === 'pid' ? String(r.pid || '').trim() === val : String(r.cid || r.pidCustomer || '').split(',').map((s) => s.trim()).includes(val);
    const lots = lotRows(D, { ...ctx, params: { ...ctx.params, basis: 'any' } }, (r) => kind === 'pid' ? r.pid === val : r.cid.split(', ').includes(val));
    const intakes = sub(D, 'intake_wet').filter((i) => inRange(day(i), ctx) && match(i)).map((i) => ({ date: day(i), uid: normUid(i.sourceUid), strain: i.strain || '',
      manifest: i.manifestNo || (i.canixSync || {}).manifestNo || '', wetLb: r2(n(i.totalWetLb)) || null, ff: isFreshFrozen(i) ? L('Fresh frozen', 'Congelado') : L('Drying', 'Secado') }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const icols = [C('date', 'Date', 'Fecha', 'date'), C('uid', 'UID', 'UID', 'uid'), C('strain', 'Strain', 'Variedad'), C('manifest', 'Manifest #', 'Manifiesto', 'uid'),
      C('wetLb', 'Wet lb', 'Húmedo lb', 'lb'), C('ff', 'For', 'Para')];
    const shipped = [];
    sub(D, 'transfer_out').forEach((r) => {
      const d = String(r.actualDate || r.date || '').slice(0, 10);
      if (!inRange(d, ctx)) return;
      (r.lines || []).filter(match).forEach((x) => {
        const ty = TRANSFER_TYPES[x.productType] || {};
        shipped.push({ date: d, customer: r.customer || '', product: ty.l || L(String(x.productType || '')), strain: x.strain || '', uid: normUid(x.sourceUid),
          lb: ty.pieces ? null : r2(n(x.weight)) || null, pieces: ty.pieces ? n(x.weight) || null : null });
      });
    });
    const scols = [C('date', 'Date', 'Fecha', 'date'), C('customer', 'Shipped to', 'Enviado a'), C('product', 'Product', 'Producto'), C('strain', 'Strain', 'Variedad'),
      C('uid', 'UID', 'UID', 'uid'), C('lb', 'Lb', 'Lb', 'lb'), C('pieces', 'Pieces', 'Piezas', 'int')];
    // Lots with any form in the range; their stage weights are lifetime.
    const lcols = LOT_COLS.filter((c) => !['farm', 'cid'].includes(c.k));
    const t = lotTotals(lots);
    return {
      tiles: [{ l: L('Intakes', 'Recepciones'), v: intakes.length, t: 'int' }, { l: L('Wet received', 'Húmedo recibido'), v: r2(sum(intakes, 'wetLb')), t: 'lb' },
        { l: L('Lots worked', 'Lotes trabajados'), v: lots.length, t: 'int' }, { l: L('Dry', 'Seco'), v: t.dryLb, t: 'lb' }, { l: L('Flower', 'Flor'), v: t.flowerLb, t: 'lb' },
        { l: L('Smalls', 'Smalls'), v: t.smallsLb, t: 'lb' }, { l: L('Trim', 'Recorte'), v: t.trimLb, t: 'lb' }, { l: L('Shipped', 'Enviado'), v: r2(sum(shipped, 'lb')), t: 'lb' }],
      sections: [
        { key: 'lots', title: L('Lots', 'Lotes'), cols: lcols, rows: lots, total: t },
        { key: 'intakes', title: L('Received', 'Recibido'), cols: icols, rows: intakes, total: totalOf(intakes, icols) },
        { key: 'shipped', title: L('Shipped', 'Enviado'), cols: scols, rows: shipped, total: totalOf(shipped, scols) }
      ],
      notes: [L('Lots: every lot of this farm or customer with a form in the range, each with all its stage weights. Received and shipped: in the range.', 'Lotes: cada lote con un formulario en el rango, con todos sus pesos. Recibido y enviado: en el rango.'), OPEN_NOTE]
    };
  };

  // ── Operations summary ──────────────────────────────────────────────────
  R.ops_summary = (D, ctx) => {
    const st = stationRows(D, ctx);
    const get = (k) => st.find((r) => r.key === k) || {};
    const scols = [C('station', 'Station', 'Estación'), C('forms', 'Submitted', 'Enviados', 'int'), C('open', 'Open pages', 'Hojas abiertas', 'int'),
      C('shownLb', 'Lb', 'Lb', 'lb'), C('units', 'Units', 'Unidades', 'int'), C('strains', 'Strains', 'Variedades')];
    // The emailed report's rule: a station's pounds are what was weighed in
    // the range when it keeps a daily tally, else pounds out on its forms.
    st.forEach((r) => { r.shownLb = r.weighedLb || r.outLb || null; r.strains = uniq(r.recs.map((x) => x.strain)).join(', '); });
    const shipped = sub(D, 'transfer_out').filter((r) => inRange(String(r.actualDate || r.date || '').slice(0, 10), ctx));
    // Staff hours: Connecteam shifts (the file keeps the last 14 days).
    const sh = (ctx.shifts && ctx.shifts.shifts) || [];
    const local = (s) => new Date(s).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const firstDay = sh.length ? sh.map((s) => local(s.start)).sort()[0] : null;
    const shifts = sh.filter((s) => inRange(local(s.start), ctx)).map((s) => {
      const end = s.end ? Date.parse(s.end) : (local(s.start) === ctx.today ? Date.now() : null);
      return { ...s, hours: end ? Math.max(0, (end - Date.parse(s.start)) / 3600000) : 0, act: String(s.activity || '').split(' · ')[0].trim() || '—' };
    });
    const acts = [...groupBy(shifts, (s) => s.act)].map(([act, xs]) => ({ act, people: uniq(xs.map((x) => x.userId)).length, hours: r2(sum(xs, 'hours')) }))
      .sort((a, b) => b.hours - a.hours);
    const jobs = [...groupBy(shifts, (s) => s.job || '—')].map(([job, xs]) => ({ job, people: uniq(xs.map((x) => x.userId)).length, hours: r2(sum(xs, 'hours')) }))
      .sort((a, b) => b.hours - a.hours);
    const acols = [C('act', 'Activity', 'Actividad'), C('people', 'People', 'Personas', 'int'), C('hours', 'Hours', 'Horas', 'hrs')];
    const jcols = [C('job', 'Site / job', 'Sitio'), C('people', 'People', 'Personas', 'int'), C('hours', 'Hours', 'Horas', 'hrs')];
    const notes = [L('Pounds by station follow the emailed report: what was weighed in the range on a station that keeps a daily tally (open pages included), otherwise pounds out on forms dated in the range.',
                     'Las libras siguen el reporte del correo: lo pesado en el rango en estaciones con resumen diario (con hojas abiertas), si no, libras de salida en formularios del rango.')];
    if (firstDay && ctx.from < firstDay) notes.push(L(`Staff hours only go back to ${firstDay} (the Connecteam sync keeps 14 days).`, `Las horas solo llegan al ${firstDay} (la sincronización guarda 14 días).`));
    return {
      tiles: [
        { l: L('Wet received', 'Húmedo recibido'), v: get('intake_wet').outLb || 0, t: 'lb' },
        { l: L('Taken down (dry)', 'Bajado (seco)'), v: get('dry_check').outLb || 0, t: 'lb' },
        { l: L('Bucked', 'Desvarado'), v: get('buck').weighedLb || get('buck').productLb || 0, t: 'lb' },
        { l: L('Hand trimmed (finished)', 'Corte a mano (terminado)'), v: get('hand_trim').weighedLb || 0, t: 'lb' },
        { l: L('Pre-rolls', 'Prerolls'), v: get('preroll_production').units || 0, t: 'int' },
        { l: L('Pouches', 'Bolsas'), v: get('pouch_production').units || 0, t: 'int' },
        { l: L('Shipped out', 'Enviado'), v: r2(sum(shipped, 'totalLb')), t: 'lb' },
        { l: L('Staff hours', 'Horas del personal'), v: r2(sum(shifts, 'hours')), t: 'hrs' }
      ],
      sections: [
        { key: 'stations', title: L('Stations', 'Estaciones'), cols: scols, rows: st, total: totalOf(st, scols) },
        { key: 'activities', title: L('Staff hours by activity', 'Horas por actividad'), cols: acols, rows: acts, total: totalOf(acts, acols) },
        { key: 'jobs', title: L('Staff hours by site', 'Horas por sitio'), cols: jcols, rows: jobs, total: totalOf(jobs, jcols) }
      ],
      notes
    };
  };

  // ── UID flow (the Sankey) ──────────────────────────────────────────
  // The page draws the diagram from `flow`; the tables are what it exports.
  R.uid_flow = (D, ctx) => {
    const p = ctx.params || {};
    const S = withOpen(D, ['buck', 'hand_trim', 'machine_trim'], p.open);
    const G = OpsFlow.buildFlow(S);
    // A typed UID can match a lot at several stages (its on-stem tag is
    // also its bucked lot's and its outputs' lot UID): keep the earliest,
    // since everything after it is downstream anyway.
    const typed = OpsFlow.findUnits(G, p.uids || []).map((x) => x.id);
    const below = new Set();
    typed.forEach((id) => {
      const stack = [id];
      while (stack.length) (G.childrenOf.get(stack.pop()) || []).forEach((c) => { if (!below.has(c)) { below.add(c); stack.push(c); } });
    });
    const seeds = [...new Set([...(p.nodes || []), ...typed.filter((id) => !below.has(id))])];
    const flow = OpsFlow.selectFlow(G, { seeds, direction: p.direction || 'down', start: Number(p.start) || 0, combine: p.combine !== false });
    const label = (x) => (typeof x.label === 'string' ? L(x.label) : x.label || L(x.id));
    const byId = new Map(flow.nodes.map((x) => [x.id, x]));
    const nodeName = (x) => {
      const l = label(x);
      return x.unit && !x.combined && x.kind !== 'flow' ? { en: `${l.en} · ${x.strain || ''} …${tagTail(x.uid).slice(-5)}`, es: `${l.es} · ${x.strain || ''} …${tagTail(x.uid).slice(-5)}` } : l;
    };
    const ncols = [C('phase', 'Stage', 'Etapa'), C('name', 'Node', 'Nodo'), C('uid', 'UID', 'UID', 'uid'), C('date', 'Date', 'Fecha', 'date'),
      C('inLb', 'Lb in', 'Lb entra', 'lb'), C('outLb', 'Lb out', 'Lb sale', 'lb')];
    const nrows = flow.nodes.slice().sort((a, b) => a.phase - b.phase || b.value - a.value).map((x) => ({
      phase: OpsFlow.PHASES[x.phase].l, name: nodeName(x), uid: x.combined ? '' : x.uid || '', date: x.combined ? '' : x.date || '', inLb: x.inLb || null, outLb: x.outLb || null }));
    const lcols = [C('from', 'From', 'De'), C('to', 'To', 'A'), C('lb', 'Lb', 'Lb', 'lb')];
    const lrows = flow.links.map((l) => ({ from: nodeName(byId.get(l.source)), to: nodeName(byId.get(l.target)), lb: l.value, _p: byId.get(l.source).phase }))
      .sort((a, b) => a._p - b._p || b.lb - a.lb);
    const seedNodes = seeds.map((id) => G.nodes.get(id)).filter(Boolean);
    const at = (kind) => r2(flow.nodes.filter((x) => x.terminal && x.kind === kind).reduce((a, x) => a + x.inLb, 0));
    const firstPhase = flow.nodes.length ? Math.min(...flow.nodes.map((x) => x.phase)) : 0;
    const startLb = r2(flow.nodes.filter((x) => x.phase === firstPhase && x.unit).reduce((a, x) => a + x.value, 0));
    return {
      flow, graph: G, seeds: seedNodes,
      tiles: seedNodes.length ? [
        { l: L('Packages picked', 'Paquetes elegidos'), v: seedNodes.length, t: 'int' },
        { l: { en: `At ${OpsFlow.PHASES[firstPhase].l.en.toLowerCase()}`, es: `En ${OpsFlow.PHASES[firstPhase].l.es.toLowerCase()}` }, v: startLb, t: 'lb' },
        { l: L('Flower & smalls', 'Flor y smalls'), v: r2(flow.nodes.filter((x) => x.kind === 'product').reduce((a, x) => a + x.inLb, 0)), t: 'lb' },
        { l: L('Trim & by-products', 'Recorte y subproductos'), v: r2(flow.nodes.filter((x) => x.kind === 'byproduct').reduce((a, x) => a + x.inLb, 0)), t: 'lb' },
        { l: L('Water lost', 'Agua perdida'), v: at('water'), t: 'lb' }, { l: L('Stems, waste & loss', 'Tallos, desecho y pérdida'), v: at('loss'), t: 'lb' },
        { l: L('Still on hand', 'Aún disponible'), v: at('onhand'), t: 'lb' }, { l: L('Used / shipped', 'Usado / enviado'), v: at('use'), t: 'lb' }] : [],
      sections: seedNodes.length ? [
        { key: 'links', title: L('Every flow', 'Cada flujo'), cols: lcols, rows: lrows },
        { key: 'nodes', title: L('Every node', 'Cada nodo'), cols: ncols, rows: nrows }
      ] : [],
      notes: [L('Built from the station forms: Wet Intake → Take Down → Bucking → Hand / Machine Trim → the pre-roll, pouch or trim run, smalls trim or outgoing transfer that named the output’s tag or its lot. Water lost is wet minus dry; unweighed loss is input minus everything weighed out.',
                'Hecho con los formularios: recepción → bajada → desvarado → corte → la corrida, el corte de smalls o la transferencia que usó la etiqueta del producto o de su lote.'), OPEN_NOTE]
    };
  };

  root.OpsReports = { BUILDERS: R, NEEDS, PARAMS, lotIndex, lotRows, customerOptions };
}(typeof self !== 'undefined' ? self : this));
