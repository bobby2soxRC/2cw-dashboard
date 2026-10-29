// Raw Materials Inventory's stock math — what's on hand at each stage, built
// from the station forms — shared by raw_inventory.html and the batch picker
// on Product Transfer — Outgoing (ops_form.html), so both see the same
// available pounds. Needs operations_stations.js, ops_common.js and
// ops_data.js loaded first.
//
// RawStock.load(client, { skipId }) loads every form it needs and returns
// { d, rows, marks, paperIds, handPast, ref }: `rows` is what's on hand
// (paper-import records left out), one row per package with its tab, uid,
// lb, strain, farm/code/license, cid, used… `skipId` leaves that form out of
// what was taken (a transfer being fixed doesn't count against itself).
const RawStock = (function () {
  const r2 = (x) => Math.round(x * 100) / 100;
  const uniq = (a) => [...new Set(a.map((x) => String(x == null ? '' : x).trim()).filter(Boolean))];
  // Which tab a biomass category's stock sits on, for what a downstream form took.
  const CAT_TAB = { flower_a: 'flower', smalls_b: 'smalls', trim: 'trim', trim_a_plus: 'trim', trim_a: 'trim', trim_b: 'trim',
                    sugar_trim: 'trim', shake: 'trim', fresh_frozen: 'frozen' };

  // Used-up marks: one shared operations_forms row (station_key
  // 'raw_inventory_marks', fixed id). Raw Inventory writes them.
  const MARKS_ID = '72617769-6e76-4000-8000-000000000001';
  async function getMarks(client) {
    const { data, error } = await client.from('operations_forms').select('fields').eq('id', MARKS_ID).maybeSingle();
    if (error) throw error;
    return ((data && data.fields) || {}).marks || {};
  }

  // ── Farm names, codes and licenses ────────────────────────────────────────
  // A form's Farm License (`pid`) is usually the short code from the
  // Information Hub ("027", Comstock), sometimes the full license. The full
  // license is the Canix sync's shipper license, else the Canix facility whose
  // license number ends in the code.
  let pidCodes = [], facilities = [];
  const digits = (s) => String(s || '').replace(/\D/g, '');
  function farmOf(pid, shipperLicense) {
    const p = String(pid || '').trim();
    let code = '', license = String(shipperLicense || '').trim();
    if (p && pidCodes.some((r) => r.code === p)) code = p;
    else if (p && !license) license = p;
    if (!code && license) {
      const d = digits(license.split('-').pop());
      const hit = pidCodes.find((r) => /^\d+$/.test(r.code) && Number(r.code) === Number(d)) ||
        pidCodes.filter((r) => /^\d+$/.test(r.code) && d.endsWith(r.code)).sort((a, b) => b.code.length - a.code.length)[0];
      if (hit) code = hit.code;
    }
    if (!license && code && /^\d+$/.test(code)) {
      const tail = (f) => digits(String(f.license_number || '').split('-').pop());
      const fac = facilities.find((f) => Number(tail(f)) === Number(code)) ||
        (() => { const m = facilities.filter((f) => tail(f).endsWith(code)); return m.length === 1 ? m[0] : null; })();
      if (fac) license = fac.license_number;
    }
    const ref = pidCodes.find((r) => r.code === code);
    const fac = license && facilities.find((f) => f.license_number === license);
    return { code: code || (p && p !== license ? p : ''), license, name: (ref && ref.name) || (fac && fac.farm_group) || '' };
  }

  function tracer(d) {
    const groups = takeDownGroups(d.downs);
    // The Take Downs behind an on-stem tag or a part released off one.
    const downsFor = (uid) => {
      if (!uid) return [];
      for (const [u, members] of groups) if (uidTailMatch(u, uid)) return members;
      for (const [, members] of groups) {
        const part = members.filter((r) => (r.releases || []).some((x) => uidTailMatch(x.uid, uid)));
        if (part.length) return part;
      }
      return [];
    };
    const intakeFor = (farmUid) => {
      if (!farmUid) return null;
      return d.intakes.find((i) => normUid(i.sourceUid) === normUid(farmUid)) ||
        [...d.intakes].reverse().find((i) => uidTailMatch(i.sourceUid, farmUid)) || null;
    };
    // Farm, license, CID and farm UIDs for a record, from itself, its Take
    // Downs (by `uid`, the on-stem or lot tag) and their Wet Intakes.
    function origin(rec, uid, intakesIn) {
      const tds = intakesIn ? [] : downsFor(uid);
      const ins = intakesIn || tds.map((x) => intakeFor(x.incomingUid)).filter(Boolean);
      const pids = uniq([rec.pid, ...tds.map((x) => x.pid), ...ins.map((i) => i.pid)]);
      const lic = (pid) => { const i = ins.find((x) => x.pid === pid && x.canixSync && x.canixSync.shipperLicense); return i ? i.canixSync.shipperLicense : ''; };
      const farms = pids.length ? pids.map((p) => farmOf(p, lic(p)))
        : uniq(ins.map((i) => i.canixSync && i.canixSync.shipperLicense)).map((l) => farmOf('', l));
      return {
        farm: uniq(farms.map((f) => f.name)).join(', '), code: uniq(farms.map((f) => f.code)).join(', '),
        license: uniq(farms.map((f) => f.license)).join(', '),
        cid: uniq([rec.cid]).join(', ') || uniq([...tds.map((x) => x.cid), ...ins.map((i) => i.cid)]).join(', '),
        farmUids: uniq([...tds.map((x) => x.incomingUid), ...ins.map((i) => i.sourceUid)])
      };
    }
    // The on-stem UID a lot (or a part released off one) was bucked from.
    const groupOf = (uid) => {
      if (!uid) return null;
      for (const [u, members] of groups) {
        if (uidTailMatch(u, uid) || members.some((r) => (r.releases || []).some((x) => uidTailMatch(x.uid, uid)))) return u;
      }
      return null;
    };
    return { groups, origin, groupOf };
  }
  const adder = (out) => (tab, rec, x) => out.push({
    tab, recId: rec.id, station: rec.stationKey, strain: rec.strain || '', date: String(rec.date || '').slice(0, 10), location: '',
    ownUid: true, used: [], ...x, lb: r2(Number(x.lb) || 0), startLb: r2(Number(x.lb) || 0)
  });

  const HAND_OUT = [
    ['finishedFlowerLb', 'flower_a'], ['smallsLb', 'smalls_b'], ['normTrimLb', 'trim', { en: 'Normal', es: 'Normal' }],
    ['aPlusTrimLb', 'trim_a_plus', { en: 'A+', es: 'A+' }], ['sugarTrimLb', 'sugar_trim', { en: 'Sugar', es: 'Azucarada' }]];
  // Open Hand Trim pages, shaped like submitted records (finished flower from
  // the bags weighed so far).
  const handDrafts = (d) => ((d.tq && d.tq.openTrims) || []).filter((x) => x.fields && x.fields.sourceUid).map((x) => {
    const r = flattenRecord(x);
    return { ...r, finishedFlowerLb: (r.weights || []).reduce((a, w) => a + (Number(w.grams) || 0), 0) / G_PER_LB };
  });

  // Flower / Smalls / Trim — what each finishing form made. `lotUid` is the
  // lot it came off: a form downstream may name that instead of the new tag.
  function finishedRows(d, tr, add) {
    // ownTag: output field -> the field holding its own new tag. wip: weighed
    // on a Hand Trim page that's still open.
    const outputs = (rec, typeKey, list, ownTag, wip) => {
      const lotUid = normUid(rec.sourceUid);
      const o = tr.origin(rec, rec.sourceUid);
      list.forEach(([field, cat, label]) => {
        const lb = Number(rec[field]);
        if (!(lb > 0.005)) return;
        const tagged = ownTag && ownTag[field] && rec[ownTag[field]];
        add(CAT_TAB[cat], rec, { key: `${rec.id}:${field}`, uid: tagged ? normUid(tagged) : lotUid, lotUid, ownUid: !!tagged,
          lb, cat, catLabel: label, type: typeKey, ...(wip ? { wip: true } : {}), ...o });
      });
    };
    d.hand.forEach((r) => outputs(r, 'tHand', HAND_OUT,
      Object.fromEntries(STATION_BY_KEY.hand_trim.metrcTags.map((x) => [x.from, x.k]))));
    // An open Hand Trim page's weighed outputs are stock already, under the
    // lot UID: product picked up mid-run can go on an outgoing transfer before
    // the page is submitted (Material Flow change request from Harley,
    // 2026-10-28). The page keeps its id when it's submitted, so its rows keep
    // their keys (and any Used up mark).
    handDrafts(d).forEach((r) => outputs(r, 'tHand', HAND_OUT, null, true));
    d.machine.forEach((r) => outputs(r, 'tMachine', [
      ['flowerALb', 'flower_a'], ['smallsBLb', 'smalls_b'], ['sugarTrimLb', 'sugar_trim', { en: 'Sugar', es: 'Azucarada' }],
      ['machineShakeLb', 'shake', { en: 'Shake', es: 'Shake' }]]));
    d.smallsT.forEach((r) => outputs(r, 'tSmalls', [
      ['finishedSmallsLb', 'smalls_b', { en: 'Finished', es: 'Terminados' }], ['shakeLb', 'shake', { en: 'Shake', es: 'Shake' }]], { finishedSmallsLb: 'newFinishedUid' }));
    d.bucks.forEach((r) => outputs(r, 'tBuck', [['trimLb', 'trim', { en: 'Bucking trim', es: 'Recorte de desvarado' }]]));
    // Mixed Trim Packages: one package of many lots' trim, under its new tag
    // (blank until the Metrc Queue fills it in).
    const pkgType = STATION_BY_KEY.trim_package.fields.find((f) => f.k === 'packageType');
    d.mixed.forEach((r) => {
      const cat = r.packageType || 'trim';
      const opt = pkgType.opts.find((o) => o.v === cat);
      add('trim', r, { key: `${r.id}:mixed`, uid: normUid(r.newMixedTrimUid), lb: r.totalLb,
        strain: t({ en: 'Mixed', es: 'Mixto' }), cat, catLabel: opt ? opt.l : null, type: 'tMixed',
        farm: '', code: '', license: '', cid: '', farmUids: [] });
    });
    // Product Transfer — Incoming: each package received from another
    // facility (a return, product trimmed at another site), under its own UID.
    const trimOpts = STATION_BY_KEY.transfer_in.fields.find((f) => f.k === 'lines').cols.find((c) => c.k === 'trimType').opts;
    (d.received || []).forEach((r) => (r.lines || []).forEach((x, i) => {
      const ty = TRANSFER_TYPES[x.productType] || {};
      if (!ty.tab || ty.pieces || !(Number(x.weight) > 0.005)) return;
      const cat = ty.tab === 'trim' ? (x.trimType || null) : ty.cat;
      const opt = ty.tab === 'trim' && trimOpts.find((t) => t.v === cat);
      const o = tr.origin({ pid: x.pid, cid: x.cid }, null, []);
      add(ty.tab, r, { key: `${r.id}:in:${i}`, uid: normUid(x.uid), lb: x.weight, strain: x.strain || '', cat, catLabel: opt ? opt.l : null, type: 'tIn',
        location: x.location || '', ...(ty.tab === 'frozen' ? { wet: true } : {}), ...o, farm: o.farm || r.fromFacility || '' });
    }));
  }

  // What downstream forms took, and off which UID. A Smalls Hand Trim doesn't
  // take from its own output.
  function takersOf(d) {
    const run = (key, r, x) => ({ id: r.id, station: key, date: String(r.date || '').slice(0, 10), what: t(STATION_BY_KEY[key].title), ...x });
    return [
      ...d.prerolls.map((r) => run('preroll_production', r, { uid: r.sourceUid, cat: r.inputCategory, lb: r.startingLb })),
      // Ground Flower Pouches: each input row (flower, smalls, trim…) off its own UID.
      ...d.pouches.flatMap((r) => (r.lines || []).map((x) => run('pouch_production', r, { uid: x.sourceUid, cat: x.material, lb: num(x.weightG) / G_PER_LB }))),
      ...d.mfg.map((r) => run('mfg_output', r, { uid: r.sourceUid, cat: r.inputCategory, lb: r.inputLb })),
      ...d.biomass.filter((r) => r.status === 'transferred').map((r) => run('biomass_request', r, { uid: r.sourceUid, cat: r.category, lb: r.transferredLb })),
      ...d.smallsT.map((r) => run('smalls_trim', r, { uid: r.sourceUid, cat: 'smalls_b', lb: r.startingLb })),
      // Each row of a Mixed Trim Package, and of an outgoing transfer (by its
      // product type code: TRANSFER_TYPES' tab, and category when it has one).
      ...d.mixed.flatMap((r) => (r.lines || []).map((x) => run('trim_package', r, { uid: x.sourceUid, cat: x.trimType || null, tab: 'trim', lb: x.weightLb }))),
      ...d.shipped.flatMap((r) => (r.lines || []).filter((x) => (TRANSFER_TYPES[x.productType] || {}).tab).map((x) => run('transfer_out', r, {
        uid: x.sourceUid, cat: TRANSFER_TYPES[x.productType].cat || null, tab: TRANSFER_TYPES[x.productType].tab, lb: x.weight,
        date: String(r.actualDate || r.date || '').slice(0, 10), customer: r.customer || '', sale: true })))
    ];
  }
  // Takes each one off the rows with its UID (or their lot's), oldest stock first.
  function applyTakers(out, takers) {
    takers.forEach((c) => {
      let left = Number(c.lb) || 0;
      const tab = c.tab || CAT_TAB[c.cat];
      if (!(left > 0) || !tab || !c.uid) return;
      out.filter((r) => r.tab === tab && r.recId !== c.id && r.lb > 0 && (uidTailMatch(r.uid, c.uid) || uidTailMatch(r.lotUid, c.uid)) &&
          (!r.cat || !c.cat || r.cat === c.cat || tab !== 'trim'))
        .sort((a, b) => a.date.localeCompare(b.date))
        .forEach((r) => {
          if (left <= 0) return;
          const take = Math.min(left, r.lb);
          r.lb = r2(r.lb - take); left -= take;
          r.used.push({ ...c, lb: r2(take) });
        });
    });
  }

  function build(d) {
    const out = [], add = adder(out), tr = tracer(d), { groups, origin } = tr;

    // Drying / Fresh Frozen — Wet Intakes (wet weight).
    const drying = new Set(currentlyDrying(d.intakes, d.downs).map((i) => i.id));
    d.intakes.forEach((i) => {
      const ff = isFreshFrozen(i);
      if (!ff && !drying.has(i.id)) return;
      add(ff ? 'frozen' : 'drying', i, { key: `${i.id}:intake`, uid: normUid(i.sourceUid), lb: i.totalWetLb, wet: true,
        status: ff ? 'sFreezer' : 'sDrying', pill: ff ? 'go' : 'work', type: 'tIntake', location: i.dryRoom || '',
        ...origin(i, null, [i]) });
    });
    d.frozen.forEach((r) => add('frozen', r, { key: `${r.id}:ff`, uid: normUid(r.sourceUid), lb: r.totalLb, wet: true,
      status: 'sFreezer', pill: 'go', type: 'tFF', location: [r.site, r.freezer].filter(Boolean).join(' · '),
      ...origin(r, r.sourceUid) }));

    // On-Stem — what's ready to buck (less boxes pulled on an open bucking
    // page) and what's on hold.
    const bucked = (uid) => d.bucks.some((b) => uidTailMatch(b.sourceUid, uid));
    d.bq.items.forEach((p) => {
      const lb = p.leftLb != null ? p.leftLb : p.unbuckedLb;
      add('onstem', p, { key: `${p.id}:onstem:${normUid(p.sourceUid)}`, uid: normUid(p.sourceUid), lb,
        status: p.draftId ? 'sBucking' : 'sReady', pill: p.draftId ? 'work' : 'go', type: 'tTake',
        location: p.storageLocation || p.dryRoom || '', ...origin(p, p.sourceUid) });
    });
    groups.forEach((members, uid) => members.filter((r) => r.result !== 'pass').forEach((r) => {
      if (bucked(uid)) return;
      const lb = Number(r.dryWeightLb || 0) - (r.releases || []).reduce((a, x) => a + (Number(x.lb) || 0), 0);
      if (lb <= 0.005) return;
      add('onstem', r, { key: `${r.id}:onstem:${uid}`, uid, lb, status: r.result === 'hold_order' ? 'sHoldO' : 'sHoldQ', pill: 'hold',
        type: 'tTake', location: r.storageLocation || r.dryRoom || '', ...origin(r, uid) });
    }));

    // Bucked — lots with no Hand Trim (or Machine Trim) submitted yet, less
    // what's already weighed on an open Hand Trim page: the finished flower,
    // and any smalls, trim and waste put in before it's submitted.
    const drafts = handDrafts(d);
    d.tq.items.forEach((l) => {
      if (d.machine.some((m) => uidTailMatch(m.sourceUid, l.sourceUid))) return;
      const dr = l.draftId && drafts.find((x) => x.id === l.draftId);
      const rest = dr ? ['smallsLb', 'normTrimLb', 'aPlusTrimLb', 'sugarTrimLb', 'wasteLb'].reduce((a, k) => a + (Number(dr[k]) || 0), 0) : 0;
      const lb = Number(l.buckedFlowerLb || 0) - Number(l.trimmedLb || 0) - rest;
      // A lot held as bucked flower is under its own bucked tag once it has one.
      add('bucked', l, { key: `${l.buckDraftId || l.id}:bucked`, recId: l.buckDraftId || l.id, uid: normUid(l.newBuckedUid || l.sourceUid),
        lotUid: normUid(l.sourceUid), lb, buckedLb: Number(l.buckedFlowerLb || 0), doneLb: Number(l.trimmedLb || 0), status: l.inProgress ? 'sBucking' : l.draftId ? 'sTrimming' : 'sToTrim', pill: l.inProgress || l.draftId ? 'work' : 'go',
        type: 'tBuck', ...origin(l, l.sourceUid) });
    });

    finishedRows(d, tr, add);
    applyTakers(out, takersOf(d));
    out.forEach((r) => {
      if (r.status) return;
      r.status = r.lb <= 0.005 ? 'usedUp' : r.wip ? 'sWeighed' : r.used.length ? 'sPart' : 'sOnHand';
      r.pill = r.lb <= 0.005 ? 'used' : r.wip ? 'work' : 'go';
    });
    return out;
  }

  async function load(client, opts = {}) {
    const [intakes, downs, bucks, hand, machine, smallsT, frozen, prerolls, pouches, mfg, biomass, mixed, shipped, received, bq, tq, codes, fac, marks, paper, handPast, ref] = await Promise.all([
      loadSubmitted('intake_wet'), loadSubmitted('dry_check'), loadSubmitted('buck'), loadSubmitted('hand_trim'),
      loadSubmitted('machine_trim'), loadSubmitted('smalls_trim'), loadSubmitted('fresh_frozen'),
      loadSubmitted('preroll_production'), loadSubmitted('pouch_production'), loadSubmitted('mfg_output'), loadSubmitted('biomass_request'),
      loadSubmitted('trim_package'), loadSubmitted('transfer_out'), loadSubmitted('transfer_in'),
      loadBuckingQueue(), loadTrimQueue(), getRefCodes(),
      client.from('canix_facilities').select('license_number,farm_group').then((r) => r.data || []),
      getMarks(client),
      client.from('operations_forms').select('id').eq('owner_user', 'paper_import').limit(10000).then((r) => r.data || []),
      loadSubmitted('hand_trim_history'), loadReference()
    ]);
    pidCodes = (codes || []).filter((r) => r.kind === 'pid');
    facilities = fac;
    const d = { intakes, downs, bucks, hand, machine, smallsT, frozen, prerolls, pouches, mfg, biomass, mixed,
      shipped: shipped.filter((r) => r.id !== opts.skipId), received, bq, tq };
    // Records loaded from the old paper sheets (Aug–Sep 2026, owner_user
    // 'paper_import') still trace lots, but their output isn't stock any more.
    const paperIds = new Set(paper.map((r) => r.id));
    const rows = build(d).filter((r) => !paperIds.has(r.recId));
    return { d, rows, marks, paperIds, handPast, ref };
  }

  return { CAT_TAB, MARKS_ID, getMarks, load, build, tracer, adder, finishedRows, takersOf, applyTakers };
})();
if (typeof module !== 'undefined') module.exports = RawStock;
