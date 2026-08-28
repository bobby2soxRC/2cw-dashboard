// Tests for prod_analytics.js. Run with: node scripts/test_prod_analytics.js
//
// The fixture below is a single lot walked end to end, using the real numbers
// off the Lemon Cherry Gelato work order (23.65 lb bucked in; trimmers 79, 125
// and 174 weighing out 298, 311 and 377 grams) so the arithmetic the operators
// do on paper and the arithmetic the app does can be compared directly.

const A = require('../prod_analytics.js');
const { stages, ASOF } = require('./prod_fixture.js');
const { G_PER_LB } = require('../production_stations.js');

let failures = 0;
function check(name, actual, expected, tol = 1e-6) {
  const ok = typeof expected === 'number'
    ? Math.abs(actual - expected) <= tol
    : JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`); }
  else console.log(`  ✓ ${name}`);
}


console.log('\nhand-trim worksheet');
const grams = stages.hand_trim[0].weights.reduce((a, w) => a + w.grams, 0);
check('total grams', grams, 986);
check('grams → lbs uses ÷453.592, not ×454', grams / G_PER_LB, 2.1738, 1e-4);

console.log('\nlot tracking');
const lots = A.buildLots(stages, ASOF);
const lcg = lots.find((l) => l.strain === 'Lemon Cherry Gelato');
check('the new bucked UID resolves back to one lot', lots.filter((l) => l.strain === 'Lemon Cherry Gelato').length, 1);
check('lot cleared all six pipeline stages', Object.keys(lcg.stages).length, 6);
check('lot sits at hand_trim', lcg.currentStage, 'hand_trim');
check('days since last touch', lcg.daysInStage, 1);
check('dry-check output carried through', lcg.stages.dry_check.outputs.dry_whole_plant, 102);

console.log('\nstage yields');
const ys = A.stageYields(stages);
const buck = ys.find((y) => y.key === 'buck');
check('buck input', buck.inputLb, 102);
check('buck output', buck.outputLb, 102);
check('buck reconciles to zero loss', buck.lossPct, 0);
const dry = ys.find((y) => y.key === 'dry_check');
check('moisture loss ≈ 67.1%', dry.lossPct, (310 - 102) / 310, 1e-9);

check('dry_check loss is tagged as moisture', ys.find((y) => y.key === 'dry_check').lossKind, 'moisture');
check('buck loss is tagged as conserving', buck.lossKind, 'conserving');
// mfg_output has no biomass outputs — its input becomes finished goods — so it
// is deliberately absent from the stage-loss table rather than showing 100% loss.
check('mfg_output stays out of the stage-loss table', ys.some((y) => y.key === 'mfg_output'), false);

console.log('\nstrain yields');
const [sy] = A.strainYields(stages, { strain: 'Lemon Cherry Gelato' });
check('wet in', sy.wetLb, 310);
check('finished flower = machine A-buds + hand-trim finished', sy.flowerLb, 20 + 986 / G_PER_LB, 1e-6);
check('dry as % of wet', sy.dryPctOfWet, 102 / 310, 1e-9);

console.log('\nbiomass ledger');
const led = A.biomassLedger(stages);
const byCat = Object.fromEntries(led.map((r) => [r.category, r]));
// buck made 60 lb of bucked flower; machine trim took 36.35 and hand trim 23.65.
check('bucked flower fully consumed downstream', byCat.bucked_flower.processingLb, 0);
// 8 lb of smalls made, 9 lb transferred to manufacturing (an over-draw worth seeing).
check('smalls left in processing', byCat.smalls_b.processingLb, 8 + 4 - 9);
check('smalls sitting in manufacturing after the preroll run', byCat.smalls_b.manufacturingLb, 9 - 5);
check('fresh frozen on hand', byCat.fresh_frozen.totalLb, 500);
check('a transfer is not counted as a loss', byCat.smalls_b.totalLb, 8 + 4 - 5);

console.log('\ntrimmer productivity');
const trimmers = A.trimmerStats(stages);
check('three trimmers on the work order', trimmers.length, 3);
check('top trimmer is #174', trimmers[0].employeeNo, '174');
check('#174 grams', trimmers[0].grams, 377);
check('#79 lbs', trimmers.find((x) => x.employeeNo === '79').lb, Math.round((298 / G_PER_LB) * 100) / 100);

console.log('\ncrew throughput');
const crew = A.crewThroughput(stages);
check('bucking lbs per labor hour', crew.find((c) => c.key === 'buck').lbPerLaborHour, 102 / 32, 0.01);

console.log('\nrequests');
const reqs = A.requestSummary(stages, ASOF);
check('one request still open', reqs.filter((r) => r.open).length, 1);
check('transferred request came up 1 lb short', reqs.find((r) => r.id === 'r1').shortLb, 1);

console.log('\nexceptions');
const exc = A.exceptions(stages, ASOF);
check('the 5%-light intake is flagged', exc.filter((e) => e.kind === 'intake_variance').length, 1);
check('the stale request is flagged', exc.filter((e) => e.kind === 'stale_request').length, 1);
check('balanced stages raise nothing', exc.filter((e) => e.kind === 'unbalanced' && e.stage === 'buck').length, 0);
// Drying is meant to shed two thirds of its weight and a preroll run consumes
// its input outright; flagging either would bury the rows that matter.
check('moisture loss is not an exception', exc.filter((e) => e.stage === 'dry_check' && e.kind === 'unbalanced').length, 0);
check('a manufacturing run is not an exception', exc.filter((e) => e.stage === 'mfg_output').length, 0);
check('total exceptions', exc.length, 2);

console.log(failures ? `\n${failures} test(s) failed\n` : '\nAll tests passed\n');
process.exit(failures ? 1 : 0);
