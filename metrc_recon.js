// ─────────────────────────────────────────────────────────────────────────────
// 2CW Operations — App vs Metrc reconciliation.
//
// Works out which packages the App thinks exist (and how much is in each)
// from the submitted station forms, then lines that up against the Metrc
// package list (metrc_packages, filled by scripts/metrc_sync.py) and returns
// one "issue" per difference:
//   metrc_only — active in Metrc, never seen on any App form
//   app_only   — the App has weight on it, but it isn't active in Metrc
//   weight     — both have it, and the weights differ by more than the tolerance
//
// Pure functions over plain data, like ops_analytics.js, so the same code runs
// in metrc_recon.html / metrc_actions.html and under node for
// scripts/test_metrc_recon.js.
// ─────────────────────────────────────────────────────────────────────────────

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./operations_stations.js'));
  } else {
    root.MetrcRecon = factory({ STATION_BY_KEY, G_PER_LB });
  }
}(typeof self !== 'undefined' ? self : this, function (S) {

const STATION_BY_KEY = S.STATION_BY_KEY || {};
const G_PER_LB = S.G_PER_LB || 453.592;

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };
const normUid = (u) => String(u || '').toUpperCase().replace(/\s/g, '');
const round3 = (x) => Math.round(x * 1000) / 1000;

// Below this many lbs (or 0 each) a package counts as used up in the App.
const EMPTY_LB = 0.005;
const DEFAULT_TOLERANCE_LB = 0.01;

// Metrc quantity → lbs (weight units) or a count ('each').
const UNIT_TO_LB = {
  pounds: 1, pound: 1, lb: 1, lbs: 1,
  grams: 1 / G_PER_LB, gram: 1 / G_PER_LB, g: 1 / G_PER_LB,
  milligrams: 1 / (G_PER_LB * 1000), mg: 1 / (G_PER_LB * 1000),
  kilograms: 1000 / G_PER_LB, kilogram: 1000 / G_PER_LB, kg: 1000 / G_PER_LB,
  ounces: 1 / 16, ounce: 1 / 16, oz: 1 / 16
};
function metrcAmount(pkg) {
  const unit = String(pkg.unit || '').trim().toLowerCase();
  const q = num(pkg.quantity);
  if (UNIT_TO_LB[unit] != null) return { unit: 'lb', value: q * UNIT_TO_LB[unit] };
  return { unit: 'each', value: q };
}

// Calculated fields are saved with the record, but older or imported records
// can be missing them — work them out from the station schema when they are.
function withCalcs(stationKey, r) {
  const st = STATION_BY_KEY[stationKey];
  if (!st) return r;
  const out = { ...r };
  st.fields.filter((f) => f.t === 'calc').forEach((f) => {
    if (out[f.k] == null || out[f.k] === '') {
      try { out[f.k] = f.calc(out); } catch (e) { /* leave it blank */ }
    }
  });
  return out;
}

// ── What each station does to a package ─────────────────────────────────────
// set     — the form names this package and says what's in it now
// consume — the form took this many lbs out of it
// close   — the form used the whole package (retagged under a new UID)
// Stations not listed don't touch package weights.
const STATION_EFFECTS = {
  harvest: (r) => [{ op: 'set', uid: r.sourceUid, lb: num(r.wetWeightLb) }],
  intake_wet: (r) => [{ op: 'set', uid: r.sourceUid, lb: num(r.totalWetLb) }],
  fresh_frozen: (r) => (r.sourceUid ? [{ op: 'set', uid: r.sourceUid, lb: num(r.totalLb) }] : []),
  dry_check: (r) => {
    const releases = Array.isArray(r.releases) ? r.releases : [];
    const released = releases.reduce((a, x) => a + num(x.lb), 0);
    const fx = [];
    if (r.incomingUid && normUid(r.incomingUid) !== normUid(r.sourceUid)) fx.push({ op: 'close', uid: r.incomingUid });
    fx.push({ op: 'set', uid: r.sourceUid, lb: num(r.dryWeightLb) - released });
    releases.forEach((x) => fx.push({ op: 'set', uid: x.uid, lb: num(x.lb) }));
    return fx;
  },
  // Bucking keeps the Take Down's tag; what's left under it is the bucked flower.
  buck: (r) => [{ op: 'set', uid: r.sourceUid, lb: num(r.buckedFlowerLb) }],
  machine_trim: (r) => [{ op: 'consume', uid: r.sourceUid, lb: num(r.inputBuckedLb) }],
  hand_trim: (r) => [{ op: 'consume', uid: r.sourceUid, lb: num(r.startingBuckedLb) }],
  smalls_trim: (r) => [{ op: 'consume', uid: r.sourceUid, lb: num(r.startingLb) }],
  mfg_output: (r) => [{ op: 'consume', uid: r.sourceUid, lb: num(r.inputLb) }],
  preroll_production: (r) => {
    const fx = [{ op: 'consume', uid: r.sourceUid, lb: num(r.startingWtG) / G_PER_LB }];
    if (r.newPrerollUid) fx.push({ op: 'set', uid: r.newPrerollUid, each: num(r.totalPrerolls) });
    if (r.newWasteUid) fx.push({ op: 'set', uid: r.newWasteUid, lb: num(r.totalWasteG) / G_PER_LB });
    return fx;
  }
};
const APP_STATIONS = Object.keys(STATION_EFFECTS);

// ── App packages ────────────────────────────────────────────────────────────
// `stages` is { stationKey: [flattened submitted records] } — the same shape
// ops_analytics.js takes. Records are replayed oldest first. Returns a Map of
// normalized UID → { tag, unit, amount, strain, lastStation, lastDate,
// lastRecordId, active, events }.
function buildAppPackages(stages) {
  const events = [];
  APP_STATIONS.forEach((key) => {
    (stages[key] || []).forEach((raw) => {
      const r = withCalcs(key, raw);
      const at = String(r.submittedAt || r.date || '');
      STATION_EFFECTS[key](r).forEach((fx) => {
        if (!normUid(fx.uid)) return;
        events.push({ ...fx, uid: normUid(fx.uid), at, date: String(r.date || at).slice(0, 10), station: key, recordId: r.id, strain: r.strain || '' });
      });
    });
  });
  // Stable sort keeps a record's own effects in the order its handler gave them.
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const pkgs = new Map();
  const get = (e) => {
    if (!pkgs.has(e.uid)) pkgs.set(e.uid, { tag: e.uid, unit: 'lb', amount: 0, strain: '', lastStation: '', lastDate: '', lastRecordId: null, events: [] });
    return pkgs.get(e.uid);
  };
  events.forEach((e) => {
    const p = get(e);
    if (e.op === 'set') {
      if (e.each != null) { p.unit = 'each'; p.amount = e.each; } else { p.unit = 'lb'; p.amount = e.lb; }
    } else if (e.op === 'consume') {
      if (p.unit === 'lb') p.amount -= e.lb;
    } else if (e.op === 'close') {
      p.amount = 0;
    }
    if (e.strain && !p.strain) p.strain = e.strain;
    p.lastStation = e.station; p.lastDate = e.date; p.lastRecordId = e.recordId;
    p.events.push({ op: e.op, station: e.station, date: e.date, recordId: e.recordId, lb: e.lb, each: e.each });
  });
  pkgs.forEach((p) => {
    p.amount = round3(p.amount);
    p.active = p.unit === 'each' ? p.amount > 0 : p.amount > EMPTY_LB;
  });
  return pkgs;
}

// Operators often type only the last 4–5 of a tag. Resolve a short App UID to
// the one Metrc tag ending in it (none, or more than one, leaves it as is).
function resolveShortUids(appPkgs, metrcTags) {
  const out = new Map();
  appPkgs.forEach((p, uid) => {
    let key = uid;
    if (uid.length < 12) {
      const hits = metrcTags.filter((t) => t.endsWith(uid));
      if (hits.length === 1) key = hits[0];
    }
    if (out.has(key)) {
      // Two App UIDs landed on one tag (short and full) — keep the most recent.
      const prev = out.get(key);
      if (prev.lastDate > p.lastDate) return;
    }
    out.set(key, { ...p, tag: key, appUid: uid });
  });
  return out;
}

// ── Reconcile ───────────────────────────────────────────────────────────────
// metrcPackages: rows of metrc_packages (active ones). Returns issues sorted
// metrc_only, app_only, weight, then by tag.
function reconcile(appPkgs, metrcPackages, opts) {
  const tol = opts && opts.toleranceLb != null ? Number(opts.toleranceLb) : DEFAULT_TOLERANCE_LB;
  const metrc = new Map();
  (metrcPackages || []).forEach((m) => { if (m.is_active !== false) metrc.set(normUid(m.tag), m); });
  const app = resolveShortUids(appPkgs, [...metrc.keys()]);
  const issues = [];

  metrc.forEach((m, tag) => {
    const amt = metrcAmount(m);
    const a = app.get(tag);
    if (!a) {
      issues.push(issue('metrc_only', tag, m, null, amt));
      return;
    }
    const appVal = a.amount;
    // A pre-roll package counted in units on one side and weighed on the other
    // can't be compared — show it, but as a unit mismatch.
    if (a.unit !== amt.unit) {
      issues.push({ ...issue('weight', tag, m, a, amt), unitMismatch: true });
      return;
    }
    const diff = round3(amt.value - appVal);
    const limit = amt.unit === 'each' ? 0 : tol;
    if (Math.abs(diff) > limit + 1e-9) issues.push(issue('weight', tag, m, a, amt));
  });

  app.forEach((a, tag) => {
    if (metrc.has(tag) || !a.active) return;
    issues.push(issue('app_only', tag, null, a, null));
  });

  const order = { metrc_only: 0, app_only: 1, weight: 2 };
  return issues.sort((x, y) => order[x.kind] - order[y.kind] || (x.tag < y.tag ? -1 : 1));
}

function issue(kind, tag, m, a, amt) {
  const unit = amt ? amt.unit : (a ? a.unit : 'lb');
  const metrcVal = amt ? round3(amt.value) : null;
  const appVal = a ? round3(a.amount) : null;
  const diff = metrcVal != null && appVal != null ? round3(metrcVal - appVal) : null;
  return {
    key: `${kind}:${tag}`, kind, tag, unit,
    metrcValue: metrcVal, appValue: appVal, diff,
    usedUpInApp: !!(a && !a.active && m),
    strain: (m && m.strain) || (a && a.strain) || '',
    item: (m && m.item_name) || '',
    category: (m && m.item_category) || '',
    license: (m && m.license_number) || '',
    location: (m && m.location) || '',
    metrcUnit: m ? m.unit : '',
    lastStation: a ? a.lastStation : '',
    lastDate: a ? a.lastDate : '',
    lastRecordId: a ? a.lastRecordId : null,
    appUid: a ? a.appUid : '',
    signature: signatureOf(kind, metrcVal, appVal)
  };
}

// What an issue looked like when someone marked it Known. If the weights move,
// the signature changes and it's back to Needs Attention.
function signatureOf(kind, metrcVal, appVal) {
  const f = (v) => (v == null ? '-' : Number(v).toFixed(3));
  return `${kind}|${f(metrcVal)}|${f(appVal)}`;
}

// Status for an issue given its metrc_recon_status row (or none).
function statusOf(iss, row) {
  if (!row || row.status !== 'known') return { status: 'needs_attention', changed: false };
  if (row.signature && row.signature !== iss.signature) return { status: 'needs_attention', changed: true };
  return { status: 'known', changed: false };
}

return { buildAppPackages, reconcile, statusOf, signatureOf, metrcAmount, resolveShortUids, normUid,
         STATION_EFFECTS, APP_STATIONS, DEFAULT_TOLERANCE_LB };
}));
