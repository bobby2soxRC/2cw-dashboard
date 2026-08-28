// ─────────────────────────────────────────────────────────────────────────────
// 2CW Production — analytics.
//
// Turns the raw per-stage record files into the four things operations actually
// asks for: where every lot currently is, what each stage yields, how much
// biomass is on hand and where, and who trimmed how much.
//
// Pure functions over plain data, so the same code runs in the dashboard page
// and under node for the tests in scripts/test_prod_analytics.js.
// ─────────────────────────────────────────────────────────────────────────────

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./production_stations.js'));
  } else {
    root.ProdAnalytics = factory({ PROD_STATIONS, STATION_BY_KEY, BIOMASS, SELLABLE, PIPELINE_ORDER, G_PER_LB });
  }
}(typeof self !== 'undefined' ? self : this, function (S) {

const { PROD_STATIONS, STATION_BY_KEY, BIOMASS, SELLABLE, PIPELINE_ORDER } = S;

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };
const normUid = (u) => String(u || '').toUpperCase().replace(/\s/g, '');
const dayOf = (r) => String(r.date || r.submittedAt || '').slice(0, 10);

// ── Lot identity ────────────────────────────────────────────────────────────
// A lot keeps one identity from farm to finished flower even though its Metrc
// tag changes at bucking: the buck record names both the tag it consumed and
// the tag it created, which is the link we follow back to the root.
function buildAliasMap(stages) {
  const alias = {};
  (stages.buck || []).forEach((r) => {
    const src = normUid(r.sourceUid);
    if (!src) return;
    [r.newBuckedUid, r.newBigLeafUid].forEach((u) => {
      const n = normUid(u);
      if (n && n !== src) alias[n] = src;
    });
  });
  return alias;
}

function rootUid(alias, uid) {
  let u = normUid(uid);
  const seen = new Set();
  while (alias[u] && !seen.has(u)) { seen.add(u); u = alias[u]; }
  return u;
}

// Records are keyed on the full tag, but operators often write only the last 4.
// Resolve a short key against the known roots before giving up on it.
function resolveKey(roots, uid) {
  const u = normUid(uid);
  if (!u) return '';
  if (roots.has(u)) return u;
  if (u.length < 8) {
    const hit = [...roots].find((r) => r.endsWith(u));
    if (hit) return hit;
  }
  return u;
}

// ── Lots ────────────────────────────────────────────────────────────────────
// One row per lot: which stages it has cleared, how much weight survived each,
// and how long it has been sitting where it is.
function buildLots(stages, asOf) {
  const alias = buildAliasMap(stages);
  const lots = new Map();
  const roots = new Set();

  PIPELINE_ORDER.forEach((key) => {
    (stages[key] || []).forEach((r) => roots.add(rootUid(alias, r.sourceUid)));
  });

  PIPELINE_ORDER.forEach((key) => {
    const station = STATION_BY_KEY[key];
    (stages[key] || []).forEach((r) => {
      const id = resolveKey(roots, rootUid(alias, r.sourceUid)) || `batch:${r.harvestBatchName || r.id}`;
      if (!lots.has(id)) {
        lots.set(id, { id, uid: id, strain: '', site: '', harvestBatchName: '', stages: {}, currentStage: null, lastDate: '' });
      }
      const lot = lots.get(id);
      if (r.strain && !lot.strain) lot.strain = r.strain;
      if (r.site && !lot.site) lot.site = r.site;
      if (r.harvestBatchName && !lot.harvestBatchName) lot.harvestBatchName = r.harvestBatchName;

      const outputs = {};
      let outTotal = 0;
      ((station.flow && station.flow.outputs) || []).forEach((o) => {
        const v = num(r[o.field]);
        outputs[o.category] = (outputs[o.category] || 0) + v;
        outTotal += v;
      });
      const inLb = station.flow && station.flow.input ? num(r[station.flow.input.field]) : null;

      // A lot can be bucked or trimmed over several days; roll the runs up.
      const prev = lot.stages[key];
      lot.stages[key] = {
        date: dayOf(r),
        runs: (prev ? prev.runs : 0) + 1,
        inputLb: (prev ? prev.inputLb : 0) + (inLb || 0),
        outputLb: (prev ? prev.outputLb : 0) + outTotal,
        outputs: mergeSums(prev ? prev.outputs : {}, outputs),
        result: r.result || null
      };
      if (dayOf(r) >= lot.lastDate) { lot.lastDate = dayOf(r); }
    });
  });

  const today = asOf || new Date().toISOString().slice(0, 10);
  lots.forEach((lot) => {
    // The furthest stage the lot has reached is where it is sitting now.
    for (let i = PIPELINE_ORDER.length - 1; i >= 0; i--) {
      if (lot.stages[PIPELINE_ORDER[i]]) { lot.currentStage = PIPELINE_ORDER[i]; break; }
    }
    lot.daysInStage = lot.currentStage ? daysBetween(lot.stages[lot.currentStage].date, today) : null;
    lot.complete = lot.currentStage === PIPELINE_ORDER[PIPELINE_ORDER.length - 1];
  });

  return [...lots.values()].sort((a, b) => String(b.lastDate).localeCompare(String(a.lastDate)));
}

function mergeSums(a, b) {
  const out = { ...a };
  Object.entries(b || {}).forEach(([k, v]) => { out[k] = (out[k] || 0) + v; });
  return out;
}

function daysBetween(from, to) {
  if (!from || !to) return null;
  const d = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000;
  return Number.isFinite(d) ? Math.max(0, Math.round(d)) : null;
}

// ── Stage yields ────────────────────────────────────────────────────────────
// Loss is measured against what went in, so a stage with no recorded input
// weight contributes to the totals but not to the loss average.
function stageYields(stages, filter) {
  return PROD_STATIONS.filter((s) => s.flow && s.flow.outputs && s.flow.outputs.length).map((station) => {
    const rows = (stages[station.key] || []).filter((r) => matches(r, filter));
    let inputLb = 0, outputLb = 0, withInput = 0;
    const outputs = {};
    rows.forEach((r) => {
      const inLb = station.flow.input ? num(r[station.flow.input.field]) : 0;
      if (inLb > 0) { inputLb += inLb; withInput++; }
      station.flow.outputs.forEach((o) => {
        const v = num(r[o.field]);
        outputs[o.category] = (outputs[o.category] || 0) + v;
        if (inLb > 0 || !station.flow.input) outputLb += v;
      });
    });
    return {
      key: station.key,
      title: station.title,
      lossKind: station.flow.lossKind || 'conserving',
      records: rows.length,
      inputLb,
      outputLb,
      outputs,
      lossLb: withInput ? inputLb - outputLb : null,
      lossPct: inputLb > 0 ? (inputLb - outputLb) / inputLb : null
    };
  });
}

function matches(r, filter) {
  if (!filter) return true;
  if (filter.strain && r.strain !== filter.strain) return false;
  if (filter.site && r.site !== filter.site) return false;
  if (filter.from && dayOf(r) < filter.from) return false;
  if (filter.to && dayOf(r) > filter.to) return false;
  return true;
}

// Yield per strain, end to end: wet in at the farm vs finished flower out.
function strainYields(stages, filter) {
  const alias = buildAliasMap(stages);
  const by = {};
  const bump = (strain, key, v) => {
    if (!strain) return;
    by[strain] = by[strain] || { strain, wetLb: 0, dryLb: 0, buckedLb: 0, flowerLb: 0, smallsLb: 0, trimLb: 0 };
    by[strain][key] += v;
  };
  (stages.harvest || []).filter((r) => matches(r, filter)).forEach((r) => bump(r.strain, 'wetLb', num(r.wetWeightLb)));
  (stages.dry_check || []).filter((r) => matches(r, filter)).forEach((r) => bump(r.strain, 'dryLb', num(r.dryWeightLb)));
  (stages.buck || []).filter((r) => matches(r, filter)).forEach((r) => bump(r.strain, 'buckedLb', num(r.buckedFlowerLb)));
  (stages.machine_trim || []).filter((r) => matches(r, filter)).forEach((r) => {
    bump(r.strain, 'flowerLb', num(r.flowerALb));
    bump(r.strain, 'smallsLb', num(r.smallsBLb));
    bump(r.strain, 'trimLb', num(r.sugarTrimLb) + num(r.machineShakeLb));
  });
  (stages.hand_trim || []).filter((r) => matches(r, filter)).forEach((r) => {
    bump(r.strain, 'flowerLb', num(r.finishedFlowerLb));
    bump(r.strain, 'smallsLb', num(r.smallsLb));
    bump(r.strain, 'trimLb', num(r.sugarTrimLb));
  });
  void alias;
  return Object.values(by).map((s) => ({
    ...s,
    dryPctOfWet: s.wetLb > 0 ? s.dryLb / s.wetLb : null,
    flowerPctOfDry: s.dryLb > 0 ? s.flowerLb / s.dryLb : null,
    flowerPctOfWet: s.wetLb > 0 ? s.flowerLb / s.wetLb : null
  })).sort((a, b) => b.flowerLb - a.flowerLb);
}

// ── Biomass ledger ──────────────────────────────────────────────────────────
// Material sits in one of two places. Processing produces it and consumes it
// stage to stage; an approved biomass request is what moves it across to
// manufacturing, where a manufacturing run consumes it. Keeping the two
// locations separate is what stops a transfer being counted as a loss.
function biomassLedger(stages, filter) {
  const processing = {}, manufacturing = {}, produced = {}, consumed = {}, transferred = {};
  const add = (obj, cat, v) => { if (cat) obj[cat] = (obj[cat] || 0) + v; };

  PROD_STATIONS.forEach((station) => {
    const flow = station.flow;
    if (!flow) return;
    (stages[station.key] || []).filter((r) => matches(r, filter)).forEach((r) => {
      (flow.outputs || []).forEach((o) => {
        if (o.pending) return;                       // wet weight isn't inventory yet
        const v = num(r[o.field]);
        add(processing, o.category, v); add(produced, o.category, v);
      });
      if (flow.input) {
        const cat = flow.input.categoryField ? r[flow.input.categoryField] : flow.input.category;
        const v = num(r[flow.input.field]);
        if (station.key === 'mfg_output') { add(manufacturing, cat, -v); add(consumed, cat, v); }
        else { add(processing, cat, -v); add(consumed, cat, v); }
      }
      if (flow.transfer && r.status === flow.transfer.whenStatus) {
        const cat = r[flow.transfer.categoryField];
        const v = num(r[flow.transfer.field]);
        add(processing, cat, -v); add(manufacturing, cat, v); add(transferred, cat, v);
      }
    });
  });

  const cats = new Set([...Object.keys(processing), ...Object.keys(manufacturing)]);
  return [...cats].map((cat) => ({
    category: cat,
    label: BIOMASS[cat] || { en: cat, es: cat },
    sellable: SELLABLE.includes(cat),
    processingLb: round2(processing[cat] || 0),
    manufacturingLb: round2(manufacturing[cat] || 0),
    totalLb: round2((processing[cat] || 0) + (manufacturing[cat] || 0)),
    producedLb: round2(produced[cat] || 0),
    consumedLb: round2(consumed[cat] || 0),
    transferredLb: round2(transferred[cat] || 0)
  })).sort((a, b) => b.totalLb - a.totalLb);
}

const round2 = (x) => Math.round(x * 100) / 100;

// ── Labor ───────────────────────────────────────────────────────────────────
// The hand-trim worksheet is the only place we capture per-person output, so
// trimmer productivity comes straight off those rows.
function trimmerStats(stages, filter) {
  const by = {};
  (stages.hand_trim || []).filter((r) => matches(r, filter)).forEach((r) => {
    const day = dayOf(r);
    (r.weights || []).forEach((w) => {
      const emp = String(w.employeeNo || '').trim();
      if (!emp) return;
      by[emp] = by[emp] || { employeeNo: emp, grams: 0, bags: 0, days: new Set(), strains: new Set() };
      by[emp].grams += num(w.grams);
      by[emp].bags += 1;
      if (day) by[emp].days.add(day);
      if (r.strain) by[emp].strains.add(r.strain);
    });
  });
  return Object.values(by).map((e) => ({
    employeeNo: e.employeeNo,
    grams: Math.round(e.grams),
    lb: round2(e.grams / S.G_PER_LB),
    bags: e.bags,
    days: e.days.size,
    gramsPerDay: e.days.size ? Math.round(e.grams / e.days.size) : null,
    strains: [...e.strains]
  })).sort((a, b) => b.grams - a.grams);
}

// Crew throughput per stage — lbs of input processed per labor hour.
function crewThroughput(stages, filter) {
  return PROD_STATIONS.filter((s) => s.flow && s.flow.input).map((station) => {
    const rows = (stages[station.key] || []).filter((r) => matches(r, filter) && num(r.laborHours) > 0);
    const lb = rows.reduce((a, r) => a + num(r[station.flow.input.field]), 0);
    const hrs = rows.reduce((a, r) => a + num(r.laborHours) * Math.max(1, num(r.crewSize) || 1), 0);
    return { key: station.key, title: station.title, records: rows.length, lb: round2(lb),
             laborHours: round2(hrs), lbPerLaborHour: hrs > 0 ? round2(lb / hrs) : null };
  }).filter((s) => s.records > 0);
}

// ── Requests ────────────────────────────────────────────────────────────────
function requestSummary(stages, asOf) {
  const today = asOf || new Date().toISOString().slice(0, 10);
  return (stages.biomass_request || []).map((r) => ({
    ...r,
    ageDays: daysBetween(dayOf(r), today),
    open: r.status === 'requested' || r.status === 'approved',
    shortLb: r.status === 'transferred' ? round2(num(r.requestedLb) - num(r.transferredLb)) : null
  })).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

// Rows worth an operator's attention: weights that do not reconcile, dry
// batches sitting too long, requests nobody has actioned.
function exceptions(stages, asOf) {
  const out = [];
  const today = asOf || new Date().toISOString().slice(0, 10);

  (stages.intake_wet || []).forEach((r) => {
    const net = num(r.scaleWeightLb) - num(r.tareLb);
    const farm = num(r.farmReportedLb);
    if (farm > 0 && Math.abs(net - farm) / farm > 0.02) {
      out.push({ kind: 'intake_variance', stage: 'intake_wet', date: dayOf(r), uid: r.sourceUid, strain: r.strain,
                 detail: { en: `Intake weight is ${((net - farm) / farm * 100).toFixed(1)}% off the farm's number`,
                           es: `El peso de recepción difiere ${((net - farm) / farm * 100).toFixed(1)}% del número del rancho` } });
    }
  });

  PROD_STATIONS.forEach((station) => {
    if (!station.flow || !station.flow.input || !station.flow.outputs) return;
    if (station.flow.lossKind !== 'conserving') return;
    (stages[station.key] || []).forEach((r) => {
      const inLb = num(r[station.flow.input.field]);
      if (inLb <= 0) return;
      const outLb = station.flow.outputs.reduce((a, o) => a + num(r[o.field]), 0);
      const loss = (inLb - outLb) / inLb;
      if (Math.abs(loss) > 0.05) {
        out.push({ kind: 'unbalanced', stage: station.key, date: dayOf(r), uid: r.sourceUid, strain: r.strain,
                   detail: { en: `${(loss * 100).toFixed(1)}% of the input weight is unaccounted for`,
                             es: `${(loss * 100).toFixed(1)}% del peso de entrada no está contabilizado` } });
      }
    });
  });

  (stages.dry_check || []).forEach((r) => {
    if (r.result === 'hold' || r.result === 'rework') {
      out.push({ kind: 'dry_hold', stage: 'dry_check', date: dayOf(r), uid: r.sourceUid, strain: r.strain,
                 detail: { en: `Held at post-dry check (${r.result})`, es: `Retenido en verificación post-secado (${r.result})` } });
    }
  });

  (stages.biomass_request || []).forEach((r) => {
    const age = daysBetween(dayOf(r), today);
    if (r.status === 'requested' && age !== null && age >= 3) {
      out.push({ kind: 'stale_request', stage: 'biomass_request', date: dayOf(r), uid: '', strain: r.strain,
                 detail: { en: `Biomass request open ${age} days (${r.requestedLb} lb for ${r.destinationDept})`,
                           es: `Solicitud de biomasa abierta ${age} días (${r.requestedLb} lb para ${r.destinationDept})` } });
    }
  });

  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

return { buildLots, stageYields, strainYields, biomassLedger, trimmerStats, crewThroughput,
         requestSummary, exceptions, buildAliasMap, rootUid, daysBetween };
}));
