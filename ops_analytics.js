// ─────────────────────────────────────────────────────────────────────────────
// 2CW Operations — analytics.
//
// Turns the raw per-stage record files into the four things operations actually
// asks for: where every lot currently is, what each stage yields, how much
// biomass is on hand and where, and who trimmed how much.
//
// Pure functions over plain data, so the same code runs in the dashboard page
// and under node for the tests in scripts/test_ops_analytics.js.
// ─────────────────────────────────────────────────────────────────────────────

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./operations_stations.js'));
  } else {
    root.OpsAnalytics = factory({ OPERATIONS_STATIONS, STATION_BY_KEY, BIOMASS, SELLABLE, PIPELINE_ORDER, G_PER_LB });
  }
}(typeof self !== 'undefined' ? self : this, function (S) {

const { OPERATIONS_STATIONS, STATION_BY_KEY, BIOMASS, SELLABLE, PIPELINE_ORDER } = S;

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };
const normUid = (u) => String(u || '').toUpperCase().replace(/\s/g, '');
const dayOf = (r) => String(r.date || r.submittedAt || '').slice(0, 10);

// ── Lot identity ────────────────────────────────────────────────────────────
// A lot keeps one identity from farm to finished flower even though its Metrc
// tag changes at bucking: the buck record names both the tag it consumed and
// the tag it created, which is the link we follow back to the root.
function buildAliasMap(stages) {
  const alias = {};
  // Take Down retags the farm package as a new on-stem package.
  (stages.dry_check || []).forEach((r) => {
    const src = normUid(r.incomingUid);
    const n = normUid(r.sourceUid);
    if (src && n && n !== src) alias[n] = src;
  });
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
  // A short key is itself a root when the short form was all a record had
  // (e.g. Take Down's farm UID written as the last 5) — still prefer the
  // full tag it abbreviates, so both halves land on one lot.
  if (u.length < 8) {
    const hit = [...roots].find((r) => r !== u && r.endsWith(u));
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

  // A station can declare `flow.perLine` (Fresh Plant Intake: one truck, many
  // batches) — walk its records as a set of {sourceUid, strain, weight} rows
  // pulled out of the line-items array instead of one row per record.
  const contributionsFor = (station, r) => {
    const perLine = station.flow && station.flow.perLine;
    if (!perLine) return [{ sourceUid: r.sourceUid, strain: r.strain, harvestBatchName: r.harvestBatchName, record: r }];
    return (r[perLine.arrayField] || []).map((line) => ({
      sourceUid: line[perLine.uidCol], strain: line[perLine.strainCol] || r.strain,
      harvestBatchName: r.harvestBatchName, record: r, line, category: perLine.category
    }));
  };

  PIPELINE_ORDER.forEach((key) => {
    const station = STATION_BY_KEY[key];
    (stages[key] || []).forEach((r) => {
      contributionsFor(station, r).forEach((c) => roots.add(rootUid(alias, c.sourceUid)));
    });
  });

  PIPELINE_ORDER.forEach((key) => {
    const station = STATION_BY_KEY[key];
    (stages[key] || []).forEach((r) => {
      contributionsFor(station, r).forEach((c, idx) => {
        const id = resolveKey(roots, rootUid(alias, c.sourceUid)) || `batch:${c.harvestBatchName || r.id + '-' + idx}`;
        if (!lots.has(id)) {
          lots.set(id, { id, uid: id, strain: '', site: '', pid: '', harvestBatchName: '', stages: {}, currentStage: null, lastDate: '' });
        }
        const lot = lots.get(id);
        if (c.strain && !lot.strain) lot.strain = c.strain;
        if (r.site && !lot.site) lot.site = r.site;
        // Farm license — Harvest and Wet Intake both carry it.
        if (r.pid && !lot.pid) lot.pid = String(r.pid).trim();
        if (c.harvestBatchName && !lot.harvestBatchName) lot.harvestBatchName = c.harvestBatchName;

        const outputs = {};
        let outTotal = 0;
        let inLb = null;
        if (c.line) {
          const v = num(c.line[station.flow.perLine.weightCol]);
          outputs[c.category] = v; outTotal = v;
        } else {
          ((station.flow && station.flow.outputs) || []).forEach((o) => {
            const v = num(r[o.field]);
            outputs[o.category] = (outputs[o.category] || 0) + v;
            outTotal += v;
          });
          inLb = station.flow && station.flow.input ? num(r[station.flow.input.field]) : null;
        }

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
  return OPERATIONS_STATIONS.filter((s) => s.flow && s.flow.outputs && s.flow.outputs.length).map((station) => {
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

// ── Daily output by process ─────────────────────────────────────────────────
// One number per (day, station): total lbs weighed out that day at that
// station, regardless of what stage the lot is at overall — the rollup view
// answers "how much did each process put out today/this week", not "where is
// each lot now" (that's buildLots) or "what did a stage lose" (stageYields).
function dailyOutput(stages, filter) {
  const byDateStation = {};
  const stationKeys = [];

  OPERATIONS_STATIONS.forEach((station) => {
    if (!station.flow || !station.flow.outputs || !station.flow.outputs.length) return;
    let used = false;
    (stages[station.key] || []).filter((r) => matches(r, filter)).forEach((r) => {
      const day = dayOf(r);
      if (!day) return;
      const out = station.flow.outputs.reduce((a, o) => a + num(r[o.field]), 0);
      if (!out) return;
      used = true;
      byDateStation[day] = byDateStation[day] || {};
      byDateStation[day][station.key] = round2((byDateStation[day][station.key] || 0) + out);
    });
    if (used) stationKeys.push(station.key);
  });

  const dates = Object.keys(byDateStation).sort();
  return {
    dates,
    stationKeys,
    byDateStation,
    totalsByDate: dates.map((d) => round2(Object.values(byDateStation[d]).reduce((a, b) => a + b, 0))),
    totalsByStation: stationKeys.map((k) => round2(dates.reduce((a, d) => a + (byDateStation[d][k] || 0), 0)))
  };
}

// ── Biomass ledger ──────────────────────────────────────────────────────────
// Material sits in one of two places. Processing produces it and consumes it
// stage to stage; an approved biomass request is what moves it across to
// manufacturing, where a manufacturing run consumes it. Keeping the two
// locations separate is what stops a transfer being counted as a loss.
function biomassLedger(stages, filter) {
  const processing = {}, manufacturing = {}, produced = {}, consumed = {}, transferred = {};
  const add = (obj, cat, v) => { if (cat) obj[cat] = (obj[cat] || 0) + v; };

  OPERATIONS_STATIONS.forEach((station) => {
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
        // Manufacturing stations (Manufacturing Run, Pre-Roll Production) draw
        // on material already transferred to manufacturing.
        if (cat && station.dept.en === 'Manufacturing') { add(manufacturing, cat, -v); add(consumed, cat, v); }
        else if (cat) { add(processing, cat, -v); add(consumed, cat, v); }
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
  return OPERATIONS_STATIONS.filter((s) => s.flow && s.flow.input).map((station) => {
    const rows = (stages[station.key] || []).filter((r) => matches(r, filter) && num(r.laborHours) > 0);
    const lb = rows.reduce((a, r) => a + num(r[station.flow.input.field]), 0);
    const hrs = rows.reduce((a, r) => a + num(r.laborHours) * Math.max(1, num(r.crewSize) || 1), 0);
    return { key: station.key, title: station.title, records: rows.length, lb: round2(lb),
             laborHours: round2(hrs), lbPerLaborHour: hrs > 0 ? round2(lb / hrs) : null };
  }).filter((s) => s.records > 0);
}

// The per-employee crew log, flattened across every station that has a
// `crew` lineitems field (plus hand_trim's per-bag weighing worksheet, which
// already ties an employee number to a batch the same way). This is the seam
// for a future payroll/timeclock join: match employeeNo + date here against
// employeeNo + date in a timeclock export to get real labor cost per batch —
// nothing here knows an hourly rate, it only knows who worked what, when.
function crewLaborLog(stages, filter) {
  const out = [];
  OPERATIONS_STATIONS.forEach((station) => {
    const hasCrew = station.fields.some((f) => f.k === 'crew' && f.t === 'lineitems');
    (stages[station.key] || []).forEach((r) => {
      if (!matches(r, filter)) return;
      if (hasCrew) {
        (r.crew || []).forEach((c) => {
          const emp = String(c.employeeNo || '').trim();
          if (!emp || !num(c.hours)) return;
          // A multi-day batch logs each shift with its own date (workDate).
          out.push({ employeeNo: emp, hours: num(c.hours), date: c.workDate || dayOf(r), stationKey: station.key,
                     stationTitle: station.title, uid: r.sourceUid || r.batchTag || '',
                     batch: r.harvestBatchName || r.batchId || '', strain: r.strain || '' });
        });
      }
      if (station.key === 'hand_trim') {
        (r.weights || []).forEach((w) => {
          const emp = String(w.employeeNo || '').trim();
          if (!emp) return;
          // No hours captured on the weighing worksheet today (grams only) —
          // record the touch so the batch/employee link exists; hours stays
          // null until the worksheet captures time, or payroll supplies it.
          out.push({ employeeNo: emp, hours: null, date: dayOf(r), stationKey: station.key,
                     stationTitle: station.title, uid: r.sourceUid || '', batch: '', strain: r.strain || '' });
        });
      }
    });
  });
  // Labor Log entries (labor_log.html, station_key 'labor_entry'), already
  // spread across their UIDs by laborAllocations.
  laborAllocations(stages).forEach((a) => {
    if (!matches({ date: a.date, strain: a.strain }, filter)) return;
    out.push({ employeeNo: a.employeeNo, name: a.name, hours: a.hours, date: a.date, stationKey: a.process,
               stationTitle: (STATION_BY_KEY[a.process] || {}).title || null,
               uid: a.uid, batch: '', strain: a.strain });
  });
  return out;
}

// ── Labor cost by UID / lot ─────────────────────────────────────────────────
// The pounds a process handled for one lot — what a Labor Log entry's hours
// are split by when it covers several UIDs. The stage's own input weight
// first (Take Down's wet intake lb, Bucking's starting dry lb, …); a stage
// with no input of its own (Harvest, Wet Intake) uses what it weighed in;
// otherwise what the stage before it put out, which is how bucking labor
// logged before the batch is closed still splits by dry weight.
function lotLbForProcess(lot, process) {
  if (!lot) return 0;
  const st = lot.stages[process];
  const station = STATION_BY_KEY[process];
  // Not a station (Transportation, Other / general): split by the lot's wet
  // lb, or its weight at the latest stage it has a weight for.
  if (!station) {
    const wet = (lot.stages.intake_wet || {}).outputLb || (lot.stages.harvest || {}).outputLb || 0;
    if (wet > 0) return wet;
    for (let i = PIPELINE_ORDER.length - 1; i >= 0; i--) {
      const s = lot.stages[PIPELINE_ORDER[i]];
      if (s && s.outputLb > 0) return s.outputLb;
    }
    return 0;
  }
  if (st && st.inputLb > 0) return st.inputLb;
  if (st && st.outputLb > 0 && station && station.flow && !station.flow.input) return st.outputLb;
  for (let i = PIPELINE_ORDER.indexOf(process) - 1; i >= 0; i--) {
    const prev = lot.stages[PIPELINE_ORDER[i]];
    if (prev && prev.outputLb > 0) return prev.outputLb;
  }
  if (st && st.outputLb > 0) return st.outputLb;
  // Nothing at or before this process — e.g. Harvest labor on a lot that
  // only has a Wet Intake record. Use the first weight recorded after it, so
  // the split still follows pounds instead of falling back to even.
  for (let i = PIPELINE_ORDER.indexOf(process) + 1; i > 0 && i < PIPELINE_ORDER.length; i++) {
    const next = lot.stages[PIPELINE_ORDER[i]];
    if (next && next.inputLb > 0) return next.inputLb;
    if (next && next.outputLb > 0) return next.outputLb;
  }
  return 0;
}

// Per-person labor rates, from netlify/functions/labor-rates.js:
// [{employeeId, rate, from}], '*' being the default for anyone without their
// own. An entry is costed at the person's latest rate effective on or before
// its date, else the default's; null when neither applies (no cost shown).
// A plain number is taken as one default rate for everyone.
function rateFor(rates, employeeId, date) {
  if (rates == null) return null;
  if (typeof rates === 'number') return rates > 0 ? rates : null;
  const pick = (id) => {
    let best = null;
    rates.forEach((r) => {
      if (String(r.employeeId) !== id || String(r.from || '') > String(date || '')) return;
      if (!best || String(r.from) > String(best.from)) best = r;
    });
    return best ? num(best.rate) : null;
  };
  const own = employeeId ? pick(String(employeeId)) : null;
  return own != null ? own : pick('*');
}

// The farm licenses a farm-wide entry covers, sorted: `farms` (one farm can
// hold several licenses), or the single `farm` older entries saved.
function entryFarms(r) {
  const list = Array.isArray(r && r.farms) && r.farms.length ? r.farms : (r && r.farm ? [r.farm] : []);
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))].sort();
}

// Every Labor Log entry spread over its UIDs: one row per entry × UID with
// that UID's share of the hours (and cost, at the person's rate on that
// date — see rateFor). Shares follow the pounds each UID's lot had at that process
// (2,000 wet lb over three packages: the 1,000 lb one carries half the
// hours). If any UID on the entry has no weight yet, the entry is split
// evenly instead and marked basis 'even' — it re-splits by weight on its own
// once the weights are recorded. No UIDs keeps the hours on one row with a
// blank UID. Voided entries count for nothing. `lotId` is the lot's root UID
// (Take Down's on-stem tag rolls back to the farm package), so labor at every
// stage of one lot adds up in one place.
function laborAllocations(stages, rates) {
  const entries = (stages.labor_entry || []).filter((r) => r && !r.voided);
  if (!entries.length) return [];
  const alias = buildAliasMap(stages);
  const lots = new Map(buildLots(stages).map((l) => [l.id, l]));
  const roots = new Set(lots.keys());
  const lotFor = (uid) => lots.get(resolveKey(roots, rootUid(alias, uid))) || null;
  // A farm's lots for one year (any of the given licenses), by wet lb in
  // (Wet Intake, else Harvest) — the pounds farm-wide labor is spread over.
  // Dated by when the lot came in.
  const farmCache = {};
  const farmLots = (pids, year) => farmCache[pids.join(',') + '|' + year] || (farmCache[pids.join(',') + '|' + year] = [...lots.values()]
    .filter((l) => pids.includes(l.pid))
    .map((l) => {
      const st = l.stages.intake_wet || l.stages.harvest || null;
      return { lot: l, lb: st ? st.outputLb : 0, date: st ? st.date : '' };
    })
    .filter((x) => x.lb > 0 && String(x.date).slice(0, 4) === year));
  const out = [];
  entries.forEach((r) => {
    const hours = num(r.hours);
    const rate = rateFor(rates, r.employeeId, dayOf(r));
    const base = { entryId: r.id, date: dayOf(r), process: r.process || '',
                   employeeNo: String(r.employeeId || r.employeeName || '').trim(), name: r.employeeName || '' };
    const uids = (r.uids || []).filter((u) => u && u.uid);
    // General work at a farm: spread over the pounds the farm brings in that
    // year under any of its licenses (`farms`; older entries have a single
    // `farm`) — see farmLots. Until it has any, it waits as the farm's pool.
    const farms = entryFarms(r);
    if (!uids.length && farms.length) {
      if (!hours) return;
      const fl = farmLots(farms, dayOf(r).slice(0, 4));
      const totalLb = fl.reduce((a, x) => a + x.lb, 0);
      const farmKey = farms.join(',');
      if (!totalLb) {
        out.push({ ...base, uid: '', lotId: 'farm:' + farmKey, farm: farmKey, strain: '', lb: null, share: 1, basis: 'farm-pending',
                   hours: round2(hours), cost: rate != null ? round2(hours * rate) : null });
        return;
      }
      fl.forEach((x) => {
        const share = x.lb / totalLb;
        out.push({ ...base, uid: x.lot.id, lotId: x.lot.id, farm: farmKey, strain: x.lot.strain || '', lb: x.lb, share, basis: 'farm',
                   hours: Math.round(hours * share * 1000) / 1000, cost: rate != null ? Math.round(hours * share * rate * 100) / 100 : null });
      });
      return;
    }
    if (!uids.length) {
      if (hours) out.push({ ...base, uid: '', lotId: '', strain: r.strain || '', lb: null, share: 1, basis: 'none',
                            hours: round2(hours), cost: rate != null ? round2(hours * rate) : null });
      return;
    }
    const parts = uids.map((u) => {
      const lot = lotFor(u.uid);
      return { u, lot, lb: lotLbForProcess(lot, r.process) };
    });
    const byWeight = parts.every((p) => p.lb > 0);
    const totalLb = parts.reduce((a, p) => a + p.lb, 0);
    parts.forEach((p) => {
      const share = byWeight ? p.lb / totalLb : 1 / parts.length;
      const h = hours * share;
      out.push({ ...base, uid: normUid(p.u.uid), lotId: p.lot ? p.lot.id : normUid(p.u.uid),
                 strain: p.u.strain || (p.lot && p.lot.strain) || '', lb: p.lb || null, share,
                 basis: parts.length === 1 ? 'single' : byWeight ? 'weight' : 'even',
                 hours: Math.round(h * 1000) / 1000, cost: rate != null ? Math.round(h * rate * 100) / 100 : null });
    });
  });
  return out;
}

// Labor rolled up per lot. Direct labor (time logged on the lot's UIDs) is
// kept apart from its share of farm-wide work: that share keeps moving until
// every harvest on the farm is in, so it's an estimate and never folded into
// the firm numbers.
//   byProcess, hours, cost        direct labor only
//   costPerWetLb, costPerCurrentLb direct cost per wet lb in / per lb at the
//                                  lot's latest stage
//   farmHours, farmCost,           this lot's current share of farm-wide work
//   farmCostPerWetLb               (estimate)
// Farm-wide time with no pounds yet comes back as the farm's own pool row
// (pending, lotId 'farm:<license>'); time with no UID at all as lotId ''.
function laborCostByLot(stages, rates, allocs) {
  const lots = new Map(buildLots(stages).map((l) => [l.id, l]));
  const by = new Map();
  (allocs || laborAllocations(stages, rates)).forEach((a) => {
    let row = by.get(a.lotId);
    if (!row) {
      const lot = lots.get(a.lotId) || null;
      const wet = lot ? ((lot.stages.intake_wet || {}).outputLb || (lot.stages.harvest || {}).outputLb || 0) : 0;
      const cur = lot && lot.currentStage ? lot.stages[lot.currentStage].outputLb : 0;
      row = { lotId: a.lotId, strain: a.strain || (lot && lot.strain) || '', currentStage: lot ? lot.currentStage : null,
              farm: lot ? lot.pid : (a.farm || ''), pending: a.basis === 'farm-pending',
              wetLb: wet || null, currentLb: cur || null, uids: new Set(), byProcess: {}, hours: 0, cost: 0,
              costKnown: true, farmHours: 0, farmCost: 0, farmCostKnown: true, evenSplit: false };
      by.set(a.lotId, row);
    }
    if (!row.strain && a.strain) row.strain = a.strain;
    if (a.basis === 'farm') {
      row.farmHours += a.hours;
      if (a.cost == null) row.farmCostKnown = false; else row.farmCost += a.cost;
      return;
    }
    if (a.uid) row.uids.add(a.uid);
    const p = row.byProcess[a.process] || (row.byProcess[a.process] = { hours: 0, cost: 0 });
    p.hours += a.hours; row.hours += a.hours;
    if (a.cost == null) row.costKnown = false; else { p.cost += a.cost; row.cost += a.cost; }
    if (a.basis === 'even') row.evenSplit = true;
  });
  return [...by.values()].map((r) => ({
    ...r, uids: [...r.uids], hours: round2(r.hours), cost: r.costKnown ? round2(r.cost) : null,
    costPerWetLb: r.costKnown && r.wetLb ? r.cost / r.wetLb : null,
    costPerCurrentLb: r.costKnown && r.currentLb ? r.cost / r.currentLb : null,
    farmHours: Math.round(r.farmHours * 1000) / 1000,
    farmCost: r.farmHours && r.farmCostKnown ? round2(r.farmCost) : (r.farmHours ? null : 0),
    farmCostPerWetLb: r.farmHours && r.farmCostKnown && r.wetLb ? r.farmCost / r.wetLb : null
  })).sort((a, b) => (!a.lotId) - (!b.lotId) || a.pending - b.pending || (b.hours + b.farmHours) - (a.hours + a.farmHours));
}

// ── Cost carried forward through the stages ────────────────────────────────
// Labor follows the material: water lost at Take Down carries no cost, so
// everything spent up to then lands on the dry lb; bucking waste, stems and
// big leaf carry none, so it all lands on the bucked flower lb; at trim the
// cost of the bucked flower that went in (plus trim labor) is divided between
// A flower, Smalls and Trim by a set % split — not by weight — and each
// category's share over its own pounds is its $/lb.
//
//   lot       a buildLots() lot
//   costs     {process: $} of labor on the lot (laborCostByLot's byProcess
//             costs for direct labor, or {other: farmCost} for the farm
//             estimate). Anything not Take Down / Bucking / a trim counts
//             toward the wet stage.
//   split     {a, smalls, trim} percentages; categories this lot didn't
//             produce are dropped and the rest re-scaled to 100.
// Returns [{key, lb, cost, perLb}] for wet, dry, bucked, a, smalls, trim
// (stages the lot hasn't reached are left out) and `untrimmedCost`, the part
// of the bucked cost still sitting on bucked flower that hasn't gone
// through a trim run.
const TRIM_CATEGORY = { flower_a: 'a', smalls_b: 'smalls', sugar_trim: 'trim', trim: 'trim', shake: 'trim',
                        trim_a_plus: 'trim', trim_a: 'trim', trim_b: 'trim' };
const DEFAULT_TRIM_SPLIT = { a: 70, smalls: 20, trim: 10 };
function carryCost(lot, costs, split) {
  const c = (k) => num((costs || {})[k]);
  const late = ['dry_check', 'buck', 'machine_trim', 'hand_trim'];
  let carry = Object.keys(costs || {}).filter((k) => !late.includes(k)).reduce((a, k) => a + c(k), 0);
  const out = [];
  const st = lot ? lot.stages : {};
  const per = (cost, lb) => (lb > 0 ? cost / lb : null);
  const wetLb = (st.intake_wet || {}).outputLb || (st.harvest || {}).outputLb || 0;
  out.push({ key: 'wet', lb: wetLb || null, cost: round2(carry), perLb: per(carry, wetLb) });
  if (st.dry_check || c('dry_check')) {
    carry += c('dry_check');
    const dryLb = st.dry_check ? (st.dry_check.outputs.dry_whole_plant || st.dry_check.outputLb) : 0;
    out.push({ key: 'dry', lb: dryLb || null, cost: round2(carry), perLb: per(carry, dryLb) });
  }
  let untrimmedCost = 0;
  if (st.buck || c('buck')) {
    carry += c('buck');
    const buckedLb = st.buck ? num(st.buck.outputs.bucked_flower) : 0;
    out.push({ key: 'bucked', lb: buckedLb || null, cost: round2(carry), perLb: per(carry, buckedLb) });
    const trims = ['machine_trim', 'hand_trim'].filter((k) => st[k] || c(k));
    if (trims.length) {
      const trimIn = trims.reduce((a, k) => a + num((st[k] || {}).inputLb), 0);
      // Share of the bucked cost that went into trim runs, by bucked lb.
      const frac = buckedLb > 0 && trimIn > 0 ? Math.min(1, trimIn / buckedLb) : 1;
      const into = carry * frac + trims.reduce((a, k) => a + c(k), 0);
      untrimmedCost = carry * (1 - frac);
      const lbs = { a: 0, smalls: 0, trim: 0 };
      trims.forEach((k) => Object.entries((st[k] || {}).outputs || {}).forEach(([cat, lb]) => {
        const g = TRIM_CATEGORY[cat];
        if (g) lbs[g] += num(lb);
      }));
      const sp = split || DEFAULT_TRIM_SPLIT;
      const live = ['a', 'smalls', 'trim'].filter((g) => lbs[g] > 0 && num(sp[g]) > 0);
      const pctTotal = live.reduce((a, g) => a + num(sp[g]), 0);
      ['a', 'smalls', 'trim'].forEach((g) => {
        if (!lbs[g]) return;
        const share = live.includes(g) && pctTotal ? num(sp[g]) / pctTotal : 0;
        const cost = into * share;
        out.push({ key: g, lb: round2(lbs[g]), cost: round2(cost), perLb: per(cost, lbs[g]), pct: round2(share * 100) });
      });
    }
  }
  return { stages: out, untrimmedCost: round2(untrimmedCost) };
}

// Rolled up by employee: total logged hours, distinct batches/UIDs touched,
// and which stations — the view that answers "what has employee #79 been
// working on."
function crewLaborByEmployee(stages, filter) {
  const by = {};
  crewLaborLog(stages, filter).forEach((e) => {
    const row = by[e.employeeNo] || (by[e.employeeNo] = {
      employeeNo: e.employeeNo, name: '', hours: 0, touches: 0, batches: new Set(), stations: new Set()
    });
    if (e.name) row.name = e.name;
    row.hours += e.hours || 0;
    row.touches += 1;
    if (e.uid || e.batch) row.batches.add(e.uid || e.batch);
    row.stations.add(e.stationKey);
  });
  return Object.values(by).map((r) => ({
    employeeNo: r.employeeNo, name: r.name, hours: round2(r.hours), touches: r.touches,
    batchCount: r.batches.size, stations: [...r.stations]
  })).sort((a, b) => b.hours - a.hours || b.touches - a.touches);
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

  // Fresh Plant Intake no longer carries a single farm-reported number to
  // check the scale against — a truck can hold several batches now. A
  // per-line reconciliation against Harvest is a reasonable follow-up once
  // that matching exists in this layer (findUpstream already does it for the
  // live form's prefill), not invented here as a guess.

  OPERATIONS_STATIONS.forEach((station) => {
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

return { buildLots, stageYields, strainYields, dailyOutput, biomassLedger, trimmerStats, crewThroughput, crewLaborLog, crewLaborByEmployee, laborAllocations, laborCostByLot, lotLbForProcess, rateFor, carryCost, entryFarms, DEFAULT_TRIM_SPLIT,
         requestSummary, exceptions, buildAliasMap, rootUid, daysBetween };
}));
