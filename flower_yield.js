// A-flower estimates for material not trimmed yet — what the bulk menu's
// "Flower — 5-day lead" section offers and Raw Inventory's Est. A Flower
// column shows. Three yields, each learned from the submitted forms:
//   dry:  Take Down's dryWeightLb ÷ wetIntakeLb       (drying → on-stem)
//   buck: Bucking's buckedFlowerLb ÷ startingDryLb   (on-stem → bucked)
//   trim: Hand Trim's finishedFlowerLb ÷ startingBuckedLb (bucked → A flower)
// Drying material gets all three (dry × buck × trim), on-stem buck × trim,
// bucked just trim. Take Downs are keyed by their farm UID (incomingUid).
//
// The forms (paper imports especially) often split one lot over several
// records — inputs on one, outputs on another — or repeat one, so records
// are added up per lot first (strain + the last 4 digits of its UID, which
// survives "0392" / "392" / "49C1A-0392"), identical records counted once.
// A lot needs both weights and a believable yield (OK below) to count.
//
// Each estimate leans on the closest data there is, more as there's more of
// it: the all-lots average (pooled by pounds), pulled toward the strain's own
// lots (strain lbs vs PRIOR_LB of the average), pulled toward this very lot's
// earlier records (lot lbs vs BATCH_PRIOR_LB of the strain estimate) when part
// of it was already bucked or trimmed. Strains match through the Strain
// Library's names and aliases ("Gelato #41" = "Gelato 41" = "G41").
(function (root) {
  const DEFAULT = { dry: 0.25, buck: 0.55, trim: 0.65 };   // until there's any data at all
  const OK = { dry: [0.1, 0.6], buck: [0.2, 0.9], trim: [0.25, 0.95] };
  const PRIOR_LB = 100;
  const BATCH_PRIOR_LB = 20;
  const FIELDS = { dry: ['wetIntakeLb', 'dryWeightLb'], buck: ['startingDryLb', 'buckedFlowerLb'], trim: ['startingBuckedLb', 'finishedFlowerLb'] };

  const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
  // "Gelato #41 (grade noted …)" → "gelato41"
  const squash = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').split(' -- ')[0].replace(/[^a-z0-9]/g, '');

  function aliasMap(strains) {
    const m = new Map();
    (strains || []).forEach((s) => {
      const canon = squash(s.name);
      if (!canon) return;
      [s.name, ...(s.aliases || [])].forEach((n) => { const k = squash(n); if (k && !m.has(k)) m.set(k, canon); });
    });
    return m;
  }
  const lotTail = (uid) => { const d = String(uid || '').replace(/\D/g, ''); return d.length >= 3 ? d.slice(-4).padStart(4, '0') : ''; };

  // Records → lots: { key, strain, in, out } per lot, summed.
  function lotsOf(records, stage, keyOf) {
    const [inF, outF] = FIELDS[stage];
    const lots = new Map();
    (records || []).forEach((r, i) => {
      const inLb = num(r[inF]), outLb = num(r[outF]);
      if (!(inLb > 0) && !(outLb > 0)) return;
      const strain = keyOf.strain(r.strain);
      const tail = lotTail(stage === 'dry' ? r.incomingUid : r.sourceUid);
      const key = tail ? `${strain}|${tail}` : `#${i}`;
      if (!lots.has(key)) lots.set(key, { key, strain, in: 0, out: 0, seen: new Set() });
      const lot = lots.get(key);
      const sig = `${inLb.toFixed(2)}|${outLb.toFixed(2)}`;
      if (lot.seen.has(sig)) return;
      lot.seen.add(sig);
      lot.in += inLb; lot.out += outLb;
    });
    const [lo, hi] = OK[stage];
    return [...lots.values()].filter((l) => l.in > 0 && l.out > 0 && l.out / l.in >= lo && l.out / l.in <= hi)
      .map(({ key, strain, in: i, out }) => ({ key, strain, in: i, out }));
  }

  function stageModel(lots, stage) {
    const tot = lots.reduce((a, l) => ({ in: a.in + l.in, out: a.out + l.out }), { in: 0, out: 0 });
    const strains = new Map(), byLot = new Map();
    lots.forEach((l) => {
      const s = strains.get(l.strain) || { in: 0, out: 0, lots: 0 };
      s.in += l.in; s.out += l.out; s.lots++;
      strains.set(l.strain, s);
      byLot.set(l.key, l);
    });
    return { all: tot.in > 0 ? tot.out / tot.in : DEFAULT[stage], allLots: lots.length, allLb: tot.in, strains, byLot };
  }

  // records: { downs, bucks, trims } (submitted Take Down, Bucking and Hand
  // Trim records), strains: the Strain Library (loadReference().strains).
  function buildModel({ downs, bucks, trims, strains }) {
    const aliases = aliasMap(strains);
    const keyOf = { strain: (s) => { const k = squash(s); return aliases.get(k) || k; } };
    return {
      keyOf,
      dry: stageModel(lotsOf(downs, 'dry', keyOf), 'dry'),
      buck: stageModel(lotsOf(bucks, 'buck', keyOf), 'buck'),
      trim: stageModel(lotsOf(trims, 'trim', keyOf), 'trim')
    };
  }

  // One stage's yield for a strain (and lot): { pct, basis, lots, lb }.
  // basis: 'batch' | 'strain' | 'all' | 'default' — the closest data used.
  function rate(model, stage, strain, uid) {
    const m = model[stage], sk = model.keyOf.strain(strain);
    let pct = m.all, basis = m.allLots ? 'all' : 'default', lots = m.allLots, lb = m.allLb;
    const s = sk && m.strains.get(sk);
    if (s) { pct = (s.out + PRIOR_LB * pct) / (s.in + PRIOR_LB); basis = 'strain'; lots = s.lots; lb = s.in; }
    const tail = lotTail(uid), b = tail && m.byLot.get(`${sk}|${tail}`);
    if (b) { pct = (b.out + BATCH_PRIOR_LB * pct) / (b.in + BATCH_PRIOR_LB); basis = 'batch'; lots = 1; lb = b.in; }
    return { pct, basis, lots, lb };
  }

  // Estimated A flower from `lb` of drying (stage 'drying', wet lb), on-stem
  // ('onstem') or bucked ('bucked') material. `doneLb`: A flower already weighed off it (an open
  // Hand Trim page), taken off the estimate. → { lb, pct, steps }
  function estimate(model, { stage, strain, uid, lb, startLb, doneLb }) {
    const steps = [];
    if (stage === 'drying') steps.push({ stage: 'dry', ...rate(model, 'dry', strain, uid) });
    if (stage === 'onstem' || stage === 'drying') steps.push({ stage: 'buck', ...rate(model, 'buck', strain, uid) });
    steps.push({ stage: 'trim', ...rate(model, 'trim', strain, uid) });
    const pct = steps.reduce((a, x) => a * x.pct, 1);
    const base = startLb != null ? num(startLb) : num(lb);
    const out = Math.max(0, base * pct - num(doneLb));
    return { lb: Math.round(out * 10) / 10, pct, steps };
  }

  const api = { DEFAULT, OK, PRIOR_LB, BATCH_PRIOR_LB, squash, lotTail, lotsOf, buildModel, rate, estimate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlowerYield = api;
})(this);
