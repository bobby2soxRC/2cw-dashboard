// ─────────────────────────────────────────────────────────────────────────────
// 2CW Operations — where a package's pounds went, stage by stage (the
// Reports page's UID Flow Sankey, reports.html?r=uid_flow). Not the Material
// Flow page (material_flow.html), which charts the forms themselves.
//
// buildFlow() turns the station forms into one graph of packages and where
// their pounds went:
//
//   phase 0  Wet intake      each Wet Intake (one farm package)
//   phase 1  Dry / on-stem   each on-stem package Take Down made (several
//                            farm packages can be taken down into one)
//   phase 2  Bucked          each bucked lot, and the trim Bucking made
//   phase 3  Trimmed         each output of a Hand Trim / Machine Trim run
//                            (finished flower, smalls, trims, kief)
//   phase 4  Used / shipped  the run, package or transfer that took it
//
// Pounds that leave along the way — water at Take Down, stems and waste at
// Bucking, trim waste, unweighed loss — and what's still there (still
// drying, not bucked, not trimmed, on hand) are terminal nodes one phase to
// the right of the package they left. The links follow the same matching as
// Raw Materials Inventory's History view: an intake to its Take Down
// (matchTakeDowns), an on-stem package or a part released off it to its
// Bucking page (takeDownGroups), a bucked lot to its trim runs, and an
// output to whatever named its new tag or its lot's UID, oldest first.
//
// selectFlow() cuts it down to the packages someone picked: downstream of
// them, or upstream and downstream; from a starting phase on; with like
// outputs of several lots combined.
//
// Plain browser script over ops_common.js / operations_stations.js globals
// (normUid, uidTailMatch, isFreshFrozen, matchTakeDowns, takeDownGroups,
// TRANSFER_TYPES, G_PER_LB). Tests: node scripts/test_ops_reports.js.
// ─────────────────────────────────────────────────────────────────────────────

(function (root) {
  const n = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : 0; };
  const r2 = (x) => Math.round(x * 100) / 100;
  const day = (r) => String((r && (r.date || r.submittedAt)) || '').slice(0, 10);
  const L = (en, es) => ({ en, es });

  const PHASES = [
    { key: 'intake', l: L('Wet intake', 'Recepción húmeda') },
    { key: 'onstem', l: L('Dry / on-stem', 'Seco / en tallo') },
    { key: 'bucked', l: L('Bucked', 'Desvarado') },
    { key: 'outputs', l: L('Trimmed', 'Cortado') },
    { key: 'used', l: L('Used / shipped', 'Usado / enviado') }
  ];

  // Trim run outputs: field, category, kind, label.
  const HAND_OUT = [
    ['finishedFlowerLb', 'flower_a', 'product', L('Flower', 'Flor')],
    ['smallsLb', 'smalls_unfinished', 'product', L('Unfinished smalls', 'Smalls sin terminar')],
    ['normTrimLb', 'trim', 'byproduct', L('Normal trim', 'Recorte normal')],
    ['aPlusTrimLb', 'trim_a_plus', 'byproduct', L('A+ trim', 'Recorte A+')],
    ['sugarTrimLb', 'sugar_trim', 'byproduct', L('Sugar trim', 'Recorte azucarado')],
    ['kiefLb', 'kief', 'byproduct', L('Kief', 'Kief')]
  ];
  const MACHINE_OUT = [
    ['flowerALb', 'flower_a', 'product', L('Flower', 'Flor')],
    ['smallsBLb', 'smalls_b', 'product', L('Smalls', 'Smalls')],
    ['machineShakeLb', 'shake', 'byproduct', L('Shake', 'Shake')],
    ['sugarTrimLb', 'sugar_trim', 'byproduct', L('Sugar trim', 'Recorte azucarado')]
  ];
  // Which pile a category sits in, for what a downstream form took — the
  // same tabs Raw Materials Inventory uses.
  const CAT_TAB = { flower_a: 'flower', smalls_b: 'smalls', smalls_unfinished: 'smalls_unf', trim: 'trim', trim_a_plus: 'trim', trim_a: 'trim', trim_b: 'trim',
                    sugar_trim: 'trim', shake: 'trim', kief: 'kief' };

  // S: {stationKey: [flat records]} — submitted, plus open pages when the
  // caller wants them (each record's `status`).
  function buildFlow(S) {
    const get = (k) => (S && S[k]) || [];
    const nodes = new Map();
    const links = new Map();   // "a|b" → {source, target, value}
    const node = (id, x) => { if (!nodes.has(id)) nodes.set(id, { id, out: 0, in: 0, ...x }); return nodes.get(id); };
    const link = (a, b, v) => {
      v = r2(v);
      if (!a || !b || !(v > 0.004)) return;
      const k = `${a.id}|${b.id}`;
      const had = links.get(k);
      if (had) had.value = r2(had.value + v); else links.set(k, { source: a.id, target: b.id, value: v });
      a.out = r2(a.out + v); b.in = r2(b.in + v);
    };
    // A terminal one phase right of its parent: water, stems, still drying…
    const term = (parent, key, kind, label, v) => {
      if (!parent || !(v > 0.004)) return;
      const t = node(`${parent.id}>${key}`, { phase: parent.phase + 1, kind, key, label, terminal: true, strain: parent.strain });
      link(parent, t, v);
    };
    const tail = (u) => String(u || '').slice(-5);
    const lotLabel = (strain, uid) => `${strain || '—'} · …${tail(uid)}`;

    // ── Wet intake → on-stem ──────────────────────────────────────────────
    const intakes = get('intake_wet');
    const downs = get('dry_check');
    const groups = takeDownGroups(downs);
    groups.forEach((members, uid) => {
      const first = members[members.length - 1];
      node(`os:${uid}`, { phase: 1, kind: 'flow', unit: true, uid, strain: first.strain || '', date: day(members[0]),
        lb: r2(members.reduce((a, r) => a + n(r.dryWeightLb), 0)), label: lotLabel(first.strain, uid),
        parts: members.flatMap((r) => (r.releases || []).map((x) => normUid(x.uid))).filter(Boolean),
        pid: first.pid || '', cid: first.cid || '', recIds: members.map((r) => r.id) });
    });
    // The on-stem package an on-stem tag or a released part belongs to.
    const osFor = (uid) => {
      if (!uid) return null;
      for (const [u] of groups) if (uidTailMatch(u, uid)) return nodes.get(`os:${u}`);
      for (const [u, members] of groups) {
        if (members.some((r) => (r.releases || []).some((x) => uidTailMatch(x.uid, uid)))) return nodes.get(`os:${u}`);
      }
      return null;
    };

    intakes.forEach((i) => {
      const uid = normUid(i.sourceUid);
      node(`in:${i.id}`, { phase: 0, kind: 'flow', unit: true, uid, strain: i.strain || '', date: day(i),
        lb: r2(n(i.totalWetLb)), label: lotLabel(i.strain, uid), pid: i.pid || '', cid: i.cid || '', recIds: [i.id] });
    });
    const taken = matchTakeDowns(intakes.filter((i) => !isFreshFrozen(i)), downs);
    const wetByTd = new Map();
    taken.forEach((td, iid) => {
      const i = intakes.find((x) => x.id === iid);
      wetByTd.set(td.id, (wetByTd.get(td.id) || 0) + n(i && i.totalWetLb));
    });
    intakes.forEach((i) => {
      const nIn = nodes.get(`in:${i.id}`);
      const wet = n(i.totalWetLb);
      if (isFreshFrozen(i)) { term(nIn, 'ff', 'onhand', L('Fresh frozen', 'Fresco congelado'), wet); return; }
      const td = taken.get(i.id);
      if (!td) { term(nIn, 'drying', 'onhand', L('Still drying', 'Secando'), wet); return; }
      const os = nodes.get(`os:${normUid(td.sourceUid)}`);
      const share = wetByTd.get(td.id) > 0 ? wet / wetByTd.get(td.id) : 1;
      const dry = Math.min(wet, n(td.dryWeightLb) * share);
      link(nIn, os, dry);
      term(nIn, 'water', 'water', L('Water lost drying', 'Agua perdida al secar'), wet - dry);
    });

    // ── On-stem → bucked ──────────────────────────────────────────────────
    const bucks = get('buck');
    const bkNodes = [];
    bucks.forEach((b) => {
      const src = normUid(b.sourceUid);
      if (!src) return;
      const os = osFor(src);
      const id = `bk:${src}`;
      const bucked = n(b.buckedFlowerLb) || (Array.isArray(b.bucked) ? buckedLb(b) : 0);
      const fresh = !nodes.has(id);
      const bk = node(id, { phase: 2, kind: 'flow', unit: true, uid: normUid(b.newBuckedUid) || src, srcUid: src,
        strain: b.strain || (os && os.strain) || '', date: day(b), lb: 0, label: lotLabel(b.strain || (os && os.strain), src),
        held: b.holdBucked === true || b.holdBucked === 'true', open: b.status === 'draft', recIds: [], pid: os ? os.pid : '', cid: b.pidCustomer || (os && os.cid) || '' });
      if (fresh) bkNodes.push(bk);
      bk.lb = r2(bk.lb + bucked);
      bk.recIds.push(b.id);
      if (day(b) > bk.date) bk.date = day(b);
      const trimLb = n(b.trimLb) + n(b.aPlusTrimLb) + n(b.aTrimLb) + n(b.bTrimLb);
      const stems = n(b.stemLb), waste = n(b.moldLb) + n(b.floorWasteLb) + n(b.wasteLb), leaf = n(b.bigLeafLb);
      const outSum = bucked + trimLb + stems + waste + leaf;
      const inLb = n(b.startingDryLb) || outSum;
      const from = os || node(`os?:${src}`, { phase: 1, kind: 'flow', unit: true, uid: src, strain: b.strain || '', date: day(b),
        lb: 0, label: lotLabel(b.strain, src), noRecord: true, recIds: [] });
      if (from.noRecord) from.lb = r2(from.lb + inLb);
      link(from, bk, bucked);
      if (trimLb > 0.004) {
        const bt = node(`bt:${b.id}`, { phase: 2, kind: 'byproduct', unit: true, uid: src, lotUid: src, cat: 'trim', strain: bk.strain,
          date: day(b), lb: r2(trimLb), label: L('Bucking trim', 'Recorte de desvarado'), recIds: [b.id] });
        link(from, bt, trimLb);
      }
      term(from, 'stems', 'loss', L('Stems', 'Tallos'), stems);
      term(from, 'waste', 'loss', L('Mold & floor waste', 'Moho y desecho del piso'), waste);
      term(from, 'leaf', 'byproduct', L('Big leaf', 'Hoja grande'), leaf);
      term(from, 'shrink', 'loss', L('Unweighed / shrink', 'Sin pesar / merma'), inLb - outSum);
    });

    // ── Bucked → trimmed outputs ──────────────────────────────────────────
    const tags = Object.fromEntries(((STATION_BY_KEY.hand_trim || {}).metrcTags || []).map((x) => [x.from, x.k]));
    const trims = [...get('hand_trim').map((r) => [r, HAND_OUT, true]), ...get('machine_trim').map((r) => [r, MACHINE_OUT, false])];
    trims.forEach(([r, outs, hand]) => {
      const src = normUid(r.sourceUid);
      let parent = bkNodes.find((b) => uidTailMatch(b.srcUid, src) || uidTailMatch(b.uid, src)) || null;
      if (!parent) {
        const os = osFor(src);
        parent = node(`bk?:${src}`, { phase: 2, kind: 'flow', unit: true, uid: src, srcUid: src, strain: r.strain || (os && os.strain) || '',
          date: day(r), lb: 0, label: lotLabel(r.strain, src), noRecord: true, recIds: [] });
        if (!bkNodes.includes(parent)) bkNodes.push(parent);
        if (os) link(os, parent, n(hand ? r.startingBuckedLb : r.inputBuckedLb));
      }
      const inLb = n(hand ? r.startingBuckedLb : r.inputBuckedLb);
      if (parent.noRecord) parent.lb = r2(parent.lb + inLb);
      let made = 0;
      outs.forEach(([field, cat, kind, label]) => {
        const lb = n(r[field]);
        if (!(lb > 0.004)) return;
        made += lb;
        const own = hand && tags[field] ? normUid(r[tags[field]]) : '';
        const o = node(`o:${r.id}:${field}`, { phase: 3, kind, unit: true, cat, uid: own || src, lotUid: src, ownTag: !!own,
          strain: r.strain || parent.strain, date: day(r), lb: r2(lb), label, open: r.status === 'draft', recIds: [r.id],
          pid: parent.pid || '', cid: r.cid || parent.cid || '' });
        link(parent, o, lb);
      });
      const waste = n(r.wasteLb);
      term(parent, `tw:${r.id}`, 'loss', L('Trim waste', 'Desecho de corte'), waste);
      if (inLb > 0) term(parent, `tl:${r.id}`, 'loss', L('Trim loss (unweighed)', 'Pérdida de corte (sin pesar)'), inLb - made - waste);
    });

    // ── Outputs → whatever took them ──────────────────────────────────────
    const takers = [];
    const run = (key, r, x) => takers.push({ id: r.id, station: key, date: day(r), ...x });
    get('preroll_production').forEach((r) => run('preroll_production', r, { uid: r.sourceUid, cat: r.inputCategory, lb: n(r.startingLb),
      label: L(`Pre-roll ${r.batchId || r.prNum || ''}`.trim(), `Preroll ${r.batchId || r.prNum || ''}`.trim()) }));
    get('pouch_production').forEach((r) => (r.lines || []).forEach((x) => run('pouch_production', r, { uid: x.sourceUid, cat: x.material,
      lb: n(x.weightG) / G_PER_LB, label: L(`Pouches ${r.batchId || r.prNum || ''}`.trim(), `Bolsas ${r.batchId || r.prNum || ''}`.trim()) })));
    get('mfg_output').forEach((r) => run('mfg_output', r, { uid: r.sourceUid, cat: r.inputCategory, lb: n(r.inputLb),
      label: L('Manufacturing run', 'Corrida de manufactura') }));
    get('biomass_request').filter((r) => r.status === 'transferred').forEach((r) => run('biomass_request', r, { uid: r.sourceUid, cat: r.category,
      lb: n(r.transferredLb), label: L('Biomass transfer', 'Transferencia de biomasa') }));
    get('smalls_trim').forEach((r) => run('smalls_trim', r, { uid: r.sourceUid, cat: 'smalls_unfinished', lb: n(r.startingLb),
      label: L('Smalls hand trim', 'Corte a mano de smalls') }));
    get('trim_package').forEach((r) => (r.lines || []).forEach((x) => run('trim_package', r, { uid: x.sourceUid, cat: x.trimType || null, tab: 'trim',
      lb: n(x.weightLb), label: L('Mixed trim package', 'Paquete de recorte mixto') })));
    get('transfer_out').forEach((r) => (r.lines || []).forEach((x) => {
      const ty = TRANSFER_TYPES[x.productType] || {};
      if (!ty.tab || ty.pieces) return;
      takers.push({ id: r.id, station: 'transfer_out', date: String(r.actualDate || r.date || '').slice(0, 10), uid: x.sourceUid, cat: ty.cat || null,
        tab: ty.tab, lb: n(x.weight), label: L(`Shipped → ${r.customer || '—'}`, `Enviado → ${r.customer || '—'}`) });
    }));
    const tabOf = (nd) => (nd.phase === 1 ? 'onstem' : nd.phase === 2 && nd.kind === 'flow' ? 'bucked' : CAT_TAB[nd.cat] || null);
    const units = [...nodes.values()].filter((x) => x.unit && x.phase >= 1);
    const leftOf = (x) => r2(x.lb - x.out);
    takers.sort((a, b) => a.date.localeCompare(b.date)).forEach((c) => {
      let left = c.lb;
      const tab = c.tab || CAT_TAB[c.cat];
      if (!(left > 0) || !tab || !c.uid) return;
      const u = node(`u:${c.station}:${c.id}`, { phase: 4, kind: 'use', label: c.label, station: c.station, date: c.date, recIds: [c.id], terminal: true });
      // Smalls: its own tab first, then the other (as in raw_stock.js).
      const also = { smalls: 'smalls_unf', smalls_unf: 'smalls' }[tab];
      units.filter((x) => (tabOf(x) === tab || (also && tabOf(x) === also)) && !x.recIds.includes(c.id) && leftOf(x) > 0.004 &&
          (uidTailMatch(x.uid, c.uid) || uidTailMatch(x.lotUid, c.uid) || uidTailMatch(x.srcUid, c.uid) || (x.parts || []).some((p) => uidTailMatch(p, c.uid))) &&
          (tab !== 'trim' || !x.cat || !c.cat || x.cat === c.cat))
        .sort((a, b) => (tabOf(a) === tab ? 0 : 1) - (tabOf(b) === tab ? 0 : 1) || String(a.date).localeCompare(String(b.date)))
        .forEach((x) => {
          if (left <= 0.004) return;
          const take = Math.min(left, leftOf(x));
          link(x, u, take);
          left -= take;
        });
    });

    // ── What's still there ────────────────────────────────────────────────
    const REST = {
      1: ['unbucked', L('On stem — not bucked', 'En tallo — sin desvarar')],
      2: ['untrimmed', L('Bucked — not trimmed', 'Desvarado — sin cortar')],
      3: ['onhand', L('On hand', 'Disponible')]
    };
    [...nodes.values()].filter((x) => x.unit && x.phase >= 1).forEach((x) => {
      const rest = x.lb - x.out;
      if (rest <= 0.05) return;
      const [key, label] = x.phase === 2 && x.kind !== 'flow' ? REST[3]
        : x.phase === 2 && x.held ? ['held', L('Held as bucked flower', 'Guardado como flor desvarada')] : REST[Math.min(3, x.phase)];
      term(x, key, 'onhand', label, rest);
    });

    const all = [...links.values()];
    const childrenOf = new Map(), parentsOf = new Map();
    all.forEach((l) => {
      (childrenOf.get(l.source) || childrenOf.set(l.source, []).get(l.source)).push(l.target);
      (parentsOf.get(l.target) || parentsOf.set(l.target, []).get(l.target)).push(l.source);
    });
    return { nodes, links: all, childrenOf, parentsOf };
  }

  // The packages someone can pick: every intake, on-stem package, bucked lot
  // and output, newest first.
  function flowUnits(G) {
    return [...G.nodes.values()].filter((x) => x.unit).sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.phase - b.phase);
  }

  // Packages whose UID (full tag or a tail of 4+) matches one typed.
  function findUnits(G, uids) {
    const qs = (uids || []).map(normUid).filter((q) => q.length >= 4);
    if (!qs.length) return [];
    return flowUnits(G).filter((x) => qs.some((q) => [x.uid, x.srcUid, ...(x.parts || [])].some((u) => u && uidTailMatch(u, q))));
  }

  // The part of the graph for `seeds` (node ids):
  //   direction 'down'   the seeds and everything downstream
  //             'both'   plus everything upstream, with each upstream
  //                      package's other branches shown one step (not
  //                      followed), so every package shown still balances
  //   start              first phase shown (0 = wet intake … 3 = trimmed)
  //   combine            like outputs and endings of several lots as one
  //                      node (all the flower, all the water lost…)
  function selectFlow(G, { seeds, direction, start, combine } = {}) {
    const keep = new Set();
    const walk = (from, next) => {
      const stack = [...from];
      while (stack.length) {
        (next.get(stack.pop()) || []).forEach((k) => { if (!keep.has(k)) { keep.add(k); stack.push(k); } });
      }
    };
    (seeds || []).forEach((id) => { if (G.nodes.has(id)) keep.add(id); });
    const seedList = [...keep];
    walk(seedList, G.childrenOf);
    if (direction === 'both') {
      const up = new Set();
      const stack = [...seedList];
      while (stack.length) {
        const id = stack.pop();
        (G.parentsOf.get(id) || []).forEach((p) => { if (!up.has(p)) { up.add(p); stack.push(p); } });
      }
      up.forEach((p) => { keep.add(p); (G.childrenOf.get(p) || []).forEach((c) => keep.add(c)); });
    }
    const from = Number(start) || 0;
    const shown = new Set([...keep].filter((id) => G.nodes.get(id).phase >= from));
    // Combined: endings by phase and kind of ending, outputs by phase and
    // category. Packages and the runs that took them stay their own.
    const idOf = (id) => {
      const x = G.nodes.get(id);
      if (!combine) return id;
      if (x.terminal && x.kind !== 'use') return `T:${x.phase}:${x.key}`;
      if (x.unit && x.phase >= 2 && x.cat) return `O:${x.phase}:${x.cat}`;
      return id;
    };
    const nodes = new Map();
    shown.forEach((id) => {
      const x = G.nodes.get(id), k = idOf(id);
      const had = nodes.get(k);
      if (had) { had.members.push(x); return; }
      nodes.set(k, { ...x, id: k, members: [x], combined: k !== id });
    });
    const links = new Map();
    G.links.forEach((l) => {
      if (!shown.has(l.source) || !shown.has(l.target)) return;
      const a = idOf(l.source), b = idOf(l.target);
      if (a === b) return;
      const k = `${a}|${b}`;
      const had = links.get(k);
      if (had) had.value = r2(had.value + l.value); else links.set(k, { source: a, target: b, value: l.value });
    });
    const out = [...nodes.values()];
    out.forEach((x) => {
      x.inLb = r2([...links.values()].filter((l) => l.target === x.id).reduce((a, l) => a + l.value, 0));
      x.outLb = r2([...links.values()].filter((l) => l.source === x.id).reduce((a, l) => a + l.value, 0));
      x.value = Math.max(x.inLb, x.outLb);
    });
    // A package with nothing in or out (a lot with one record) still shows.
    return { nodes: out.filter((x) => x.value > 0 || x.unit), links: [...links.values()] };
  }

  const api = { PHASES, buildFlow, flowUnits, findUnits, selectFlow };
  root.OpsFlow = api;
}(typeof self !== 'undefined' ? self : this));
