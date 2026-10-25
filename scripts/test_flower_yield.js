// Tests for flower_yield.js (A-flower estimates for bucked / on-stem stock).
// Run with:  node scripts/test_flower_yield.js

const Y = require('../flower_yield.js');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`); }
  else console.log(`  ✓ ${name}`);
}
const r3 = (x) => Math.round(x * 1000) / 1000;

check('squash', Y.squash('Gelato #41 (grade noted Trozo 6)'), 'gelato41');
check('lot tail', [Y.lotTail('0392'), Y.lotTail('392'), Y.lotTail('49C1A-0392'), Y.lotTail('')], ['0392', '0392', '0392', '']);

// Paper-style records: one lot split over records, a duplicate, an input
// with no output, and an impossible yield.
const trims = [
  { strain: 'Glitter Bomb', sourceUid: '396', startingBuckedLb: 100 },
  { strain: 'Glitter Bomb', sourceUid: '0396', finishedFlowerLb: 50 },
  { strain: 'Glitter Bomb', sourceUid: '396', finishedFlowerLb: 15 },
  { strain: 'White Runtz', sourceUid: '392', startingBuckedLb: 100, finishedFlowerLb: 70 },
  { strain: 'White Runtz', sourceUid: '0392', startingBuckedLb: 100, finishedFlowerLb: 70 },
  { strain: 'Blue Taffeze', sourceUid: '1022', startingBuckedLb: 137 },
  { strain: 'Mule Fuel', sourceUid: '1001', startingBuckedLb: 678, finishedFlowerLb: 56.7 },
  { strain: 'Gelato #41', sourceUid: '1A406030005E0B2000010005', startingBuckedLb: 200, finishedFlowerLb: 120 }
];
const lots = Y.lotsOf(trims, 'trim', { strain: Y.squash });
check('lots: split lot added up, duplicate once, bad ones out',
  lots.map((l) => [l.strain, l.in, l.out]), [['glitterbomb', 100, 65], ['whiteruntz', 100, 70], ['gelato41', 200, 120]]);

const strains = [{ name: 'Gelato #41', aliases: ['G41', 'Gelato 41'] }];
const model = Y.buildModel({ bucks: [
  { strain: 'Zoap', sourceUid: '49C1A-1579', startingDryLb: 400, buckedFlowerLb: 200 },
  { strain: 'Grape Gas', sourceUid: '49C1A-1574', startingDryLb: 400 },
  { strain: 'Grape Gas', sourceUid: '49C1A-1574', buckedFlowerLb: 240 }
], trims, strains });
check('all-lots trim yield is pooled by pounds', r3(model.trim.all), r3(255 / 400));
check('all-lots buck yield', r3(model.buck.all), r3(440 / 800));

// A strain with no history gets the average.
const none = Y.rate(model, 'trim', 'Never Seen', '');
check('unknown strain → all lots', [none.basis, r3(none.pct)], ['all', r3(255 / 400)]);
// An alias finds the strain; 200 lb of its own history vs 100 lb of average.
const g = Y.rate(model, 'trim', 'G41', '');
check('alias → strain, weighted', [g.basis, r3(g.pct)], ['strain', r3((120 + 100 * 255 / 400) / 300)]);
// The same lot's earlier records weigh in on top.
const b = Y.rate(model, 'trim', 'White Runtz', '1A4060300000000000000392');
const strainPct = (70 + 100 * 255 / 400) / 200;
check('same lot → batch', [b.basis, r3(b.pct)], ['batch', r3((70 + 20 * strainPct) / 120)]);

// On-stem: buck × trim; bucked: trim, less what's already weighed.
const e1 = Y.estimate(model, { stage: 'onstem', strain: 'Zoap', uid: '9999', lb: 100 });
check('on-stem estimate = lb × buck × trim', [e1.steps.map((x) => x.stage), e1.lb],
  [['buck', 'trim'], Math.round(100 * e1.steps[0].pct * e1.steps[1].pct * 10) / 10]);
const e2 = Y.estimate(model, { stage: 'bucked', strain: 'Never Seen', lb: 80, startLb: 100, doneLb: 20 });
check('bucked estimate from the start weight less weighed', Math.abs(e2.lb - (100 * 255 / 400 - 20)) <= 0.05, true);
check('never below zero', Y.estimate(model, { stage: 'bucked', strain: 'x', lb: 10, doneLb: 50 }).lb, 0);

// No data at all → the defaults.
const empty = Y.buildModel({ bucks: [], trims: [], strains: [] });
check('no data → defaults', [Y.rate(empty, 'buck', 'a').basis, Y.rate(empty, 'trim', 'a').pct], ['default', Y.DEFAULT.trim]);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
