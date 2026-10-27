// Tests for ops_reports.js and ops_flow.js (the Reports page).
// Run with: node scripts/test_ops_reports.js
//
// Both are plain browser scripts over the operations_stations.js /
// ops_common.js / ops_analytics.js globals, so they're loaded here the way a
// page loads them: one after another into the same global scope. The lot is
// scripts/ops_fixture.js's Lemon Cherry Gelato, walked end to end.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
['operations_stations.js', 'ops_common.js', 'ops_analytics.js', 'metrc_transfers.js', 'ops_flow.js', 'ops_reports.js']
  .forEach((f) => vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), { filename: f }));
const { stages, DRY_UID } = require('./ops_fixture.js');

let failures = 0;
function check(name, actual, expected, tol = 1e-6) {
  const ok = typeof expected === 'number'
    ? typeof actual === 'number' && Math.abs(actual - expected) <= tol
    : JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`); }
  else console.log(`  ✓ ${name}`);
}

const sub = Object.fromEntries(Object.entries(stages).map(([k, list]) => [k, list.map((r) => ({ ...r, status: 'submitted', stationKey: k }))]));
const D = { sub, open: {} };
const ctx = (x) => ({ from: '2026-08-01', to: '2026-08-31', today: '2026-08-30', params: {}, farmName: (p) => (p === '540' ? 'Test Farm' : ''),
  personName: (b) => ({ 79: 'Ana', 125: 'Beto', 174: 'Cruz', 42: 'Dani' }[b] || ''), rates: [{ employeeId: '*', rate: 20, from: '2026-01-01' }],
  split: null, reference: { strains: [] }, metrcQueue: new Map(), canix: { transfers: [], facilities: [] }, shifts: { shifts: [] }, prerollQueue: [], ...x });

console.log('\nevery report runs on the fixture');
Object.keys(OpsReports.BUILDERS).forEach((k) => {
  let out = null, err = null;
  try { out = OpsReports.BUILDERS[k](D, ctx(k === 'customer_summary' ? { params: { who: 'pid:540' } } : k === 'uid_flow' ? { params: { uids: [DRY_UID] } } : {})); }
  catch (e) { err = e; }
  check(`${k} builds`, err ? String(err.stack).split('\n').slice(0, 2).join(' ') : !!(out && Array.isArray(out.sections) && Array.isArray(out.tiles)), true);
  // Every row value a column names is a plain value or a {en, es} label.
  if (out) out.sections.forEach((s) => s.rows.forEach((r) => s.cols.forEach((c) => {
    const v = r[c.k];
    if (v != null && typeof v === 'object' && !('en' in v)) { failures++; console.log(`  ✗ ${k}.${s.key}.${c.k} is an object`); }
  })));
});

console.log('\nyield & loss by lot');
const ly = OpsReports.BUILDERS.lot_yield(D, ctx());
const lcg = ly.sections[0].rows.find((r) => r.strain === 'Lemon Cherry Gelato');
check('one Lemon Cherry Gelato lot', ly.sections[0].rows.filter((r) => r.strain === 'Lemon Cherry Gelato').length, 1);
check('wet 310 lb', lcg.wetLb, 310);
check('dry 102 lb', lcg.dryLb, 102);
check('water lost (310 − 102) / 310', lcg.waterPct, 208 / 310);
check('bucked 60 lb', lcg.buckedLb, 60);
check('farm from the license code', lcg.farm, 'Test Farm');
check('into trim = machine 36.35 + hand 23.65', lcg.trimInLb, 60);
check('flower = machine 20 + hand 986 g', lcg.flowerLb, Math.round((20 + 986 / 454) * 100) / 100);
const outside = OpsReports.BUILDERS.lot_yield(D, ctx({ from: '2026-09-01', to: '2026-09-30' }));
check('a range after the lot came in has no lots', outside.sections[0].rows.length, 0);
const trimmedIn = OpsReports.BUILDERS.lot_yield(D, ctx({ from: '2026-08-25', to: '2026-08-31', params: { basis: 'trimmed' } }));
check('“were trimmed” finds it by the hand trim date', trimmedIn.sections[0].rows.length, 1);

console.log('\ntrimmer pay');
const withRate = { ...D, sub: { ...sub, hand_trim: sub.hand_trim.map((r) => ({ ...r, trimRatePerLb: 23, weights: r.weights.map((w) => ({ ...w, day: '2026-08-29' })) })) } };
const tp = OpsReports.BUILDERS.trimmer_pay(withRate, ctx());
const ana = tp.sections[0].rows.find((r) => r.badge === '79');
check('three trimmers', tp.sections[0].rows.length, 3);
check('name from the badge', ana.name, 'Ana');
check('pay = 298 g ÷ 454 × $23', ana.pay, Math.round(298 / 454 * 23 * 100) / 100);
check('total pay', tp.sections[0].total.pay, Math.round(986 / 454 * 23 * 100) / 100, 0.02);

console.log('\nhand trim — metrc reconciliation');
{
  const ht = (x) => ({ id: 'h', date: '2026-08-29', status: 'submitted', stationKey: 'hand_trim', sourceUid: DRY_UID, strain: 'Lemon Cherry Gelato', trimRatePerLb: 20,
    weights: [{ employeeNo: '79', grams: 4540, day: '2026-08-28' }, { employeeNo: '125', grams: 4540, day: '2026-08-29' }], smallsLb: 3, ...x });
  const pk = (tag, item, lb, src) => ({ tag, item: { name: item }, original_weight: lb, weight: 1, weight_unit: 'Pounds', packaged_date: '2026-08-30T00:00:00.000Z', source_packages: [{ tag: src }], status: 'Active' });
  const Dr = { sub: { hand_trim: [
    ht({ id: 'a', newFinishedUid: 'TAGFLOWER0001', newSmallsUid: 'TAGSMALLS0001' }),
    ht({ id: 'b', sourceUid: 'LOTB00000002', newFinishedUid: 'TAGFLOWER0002' }),
    ht({ id: 'c', sourceUid: 'LOTC00000003' }),
    ht({ id: 'd', sourceUid: 'LOTD00000004' }),
    ht({ id: 'e', sourceUid: 'LOTE00000005', owner: 'paper_import' })] },
    open: { hand_trim: [ht({ id: 'o', status: 'draft', sourceUid: 'LOTO00000009' })] } };
  const packages = [pk('TAGFLOWER0001', 'Flower - Lemon Cherry Gelato', 20.1, DRY_UID), pk('TAGSMALLS0001', 'Smalls - LCG', 3.5, DRY_UID),
    pk('TAGFLOWER0002', 'Flower - B', 18, 'LOTB00000002'), pk('TAGFLOWER0003', 'Flower - C', 20, 'LOTC00000003'), pk('TAGBUCKED0004', 'Bucked Flower - D', 50, 'LOTD00000004')];
  const rr = OpsReports.BUILDERS.trim_metrc_recon(Dr, ctx({ packages, params: { open: true, tol: '1' } }));
  const lot = (id) => rr.sections[0].rows.find((r) => r.id === id);
  check('paper imports left out, open page in', rr.sections[0].rows.map((r) => r.id).sort(), ['a', 'b', 'c', 'd', 'o']);
  check('trimmer lb = every bag', lot('a').trimmerLb, 20);
  check('Metrc lb is the created weight, not what’s left', lot('a').metrcLb, 20.1);
  check('0.5% off matches at 1%', lot('a').res, 'ok');
  check('smalls Metrc − form', lot('a').smallsDiffLb, 0.5);
  check('10% short is over tolerance', lot('b').res, 'over');
  check('no tag entered: found from the lot UID', [lot('c').res, lot('c').flowerTag], ['found', 'TAGFLOWER0003']);
  check('a bucked package isn’t finished flower', lot('d').res, 'nopkg');
  check('open page is still trimming', lot('o').res, 'open');
  check('Not needed in the queue with no package', OpsReports.BUILDERS.trim_metrc_recon(Dr, ctx({ packages, metrcQueue: new Map([['d', { status: 'not_needed' }]]) })).sections[0].rows.find((r) => r.id === 'd').res, 'notNeeded');
  const ana = rr.sections[3].rows.find((r) => r.badge === '79');
  check('trimmer pay 10 lb × $20 on each lot', ana.pay, 5 * 10 * 20);
  check('share of Metrc lb: 10 lb × 20.1 / 20 on lot a', rr.sections[4].rows.find((r) => r.badge === '79' && r.uid === normUid(DRY_UID)).metrcShare, 10.05);
  const one = OpsReports.BUILDERS.trim_metrc_recon(Dr, ctx({ packages, from: '2026-08-29', to: '2026-08-29' }));
  check('by date counts only bags in the range', one.sections[1].rows.find((r) => r.day === '2026-08-29').lb, 50);
  check('… but the lot still reconciles all its bags', one.sections[0].rows.find((r) => r.id === 'a').trimmerLb, 20);
  check('packages list both of lot a’s', rr.sections[2].rows.filter((r) => r.uid === normUid(DRY_UID)).length, 2);
}

console.log('\nbucker output');
const bo = OpsReports.BUILDERS.bucker_output(D, ctx());
check('two buckers', bo.sections[0].rows.length, 2);
check('badge 42 → name', bo.sections[0].rows.find((r) => r.who === '42').name, 'Dani');
check('a typed name stays the name', bo.sections[0].rows.find((r) => r.who === 'Maria').name, 'Maria');

console.log('\nmaterial flow');
const G = OpsFlow.buildFlow(sub);
const links = (from) => G.links.filter((l) => l.source === from).map((l) => [l.target, l.value]);
check('intake → on-stem carries the dry weight', links('in:i1').find(([t]) => t === `os:${DRY_UID}`)[1], 102);
check('intake → water lost', links('in:i1').find(([t]) => t === 'in:i1>water')[1], 208);
check('the Zoap intake with no Take Down is still drying', links('in:i2'), [['in:i2>drying', 92]]);
const os = links(`os:${DRY_UID}`);
check('on-stem → bucked 60', os.find(([t]) => t === `bk:${DRY_UID}`)[1], 60);
check('on-stem → stems 16', os.find(([t]) => t.endsWith('>stems'))[1], 16);
check('on-stem → big leaf 22', os.find(([t]) => t.endsWith('>leaf'))[1], 22);
check('nothing unweighed when bucking balances', os.some(([t]) => t.endsWith('>shrink')), false);
const bk = links(`bk:${DRY_UID}`);
check('bucked → machine trim flower 20', bk.find(([t]) => t === 'o:m1:flowerALb')[1], 20);
check('bucked fully trimmed: no “not trimmed” left', bk.some(([t]) => t.endsWith('>untrimmed')), false);
check('hand trim loss = 23.65 − outputs − waste', bk.find(([t]) => t === `bk:${DRY_UID}>tl:t1`)[1],
  Math.round((23.65 - 986 / 454 - 4 - 8 - 9) * 100) / 100);
const seed = OpsFlow.findUnits(G, [DRY_UID.slice(-4)]).map((x) => x.id);
check('a UID tail finds the on-stem package', seed.includes(`os:${DRY_UID}`), true);
const down = OpsFlow.selectFlow(G, { seeds: [`os:${DRY_UID}`], direction: 'down', start: 1, combine: true });
check('downstream from on-stem leaves the intake out', down.nodes.some((x) => x.id === 'in:i1'), false);
const bothWays = OpsFlow.selectFlow(G, { seeds: [`os:${DRY_UID}`], direction: 'both', start: 0, combine: true });
check('upstream and downstream brings the intake in', bothWays.nodes.some((x) => x.id === 'in:i1'), true);
check('… and its water lost', bothWays.nodes.some((x) => x.key === 'water'), true);
check('… but not the other intake on the truck', bothWays.nodes.some((x) => x.id === 'in:i2'), false);
const fromBucked = OpsFlow.selectFlow(G, { seeds: [`os:${DRY_UID}`], direction: 'both', start: 2, combine: true });
check('starting at Bucked drops the earlier phases', Math.min(...fromBucked.nodes.map((x) => x.phase)), 2);
const combined = OpsFlow.selectFlow(G, { seeds: [`os:${DRY_UID}`], direction: 'down', start: 1, combine: true });
check('combined: one flower node for both trim runs', combined.nodes.filter((x) => x.cat === 'flower_a').length, 1);
const apart = OpsFlow.selectFlow(G, { seeds: [`os:${DRY_UID}`], direction: 'down', start: 1, combine: false });
check('not combined: a flower node per trim run', apart.nodes.filter((x) => x.cat === 'flower_a').length, 2);
// Every package shown balances: what came in went somewhere.
const bal = bothWays.nodes.filter((x) => x.unit && x.inLb > 0 && x.outLb > 0);
check('every package in the middle balances in = out', bal.every((x) => Math.abs(x.inLb - x.outLb) < 0.05), true);

console.log('\nthe downstream run that took the smalls');
const withPre = { ...sub, preroll_production: [{ id: 'p1', date: '2026-08-28', status: 'submitted', sourceUid: DRY_UID.slice(-4), inputCategory: 'smalls_b', startingLb: 5, batchId: 'PQ-1' }] };
const G2 = OpsFlow.buildFlow(withPre);
const took = G2.links.filter((l) => l.target === 'u:preroll_production:p1');
check('a pre-roll run naming the lot takes 5 lb of its smalls', Math.round(took.reduce((a, l) => a + l.value, 0) * 100) / 100, 5);
check('oldest smalls first (machine trim’s)', took[0].source, 'o:m1:smallsBLb');

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
