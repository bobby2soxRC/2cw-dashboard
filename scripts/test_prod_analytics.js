// Tests for prod_analytics.js. Run with: node scripts/test_prod_analytics.js
//
// The fixture below is a single lot walked end to end, using the real numbers
// off the Lemon Cherry Gelato work order (23.65 lb bucked in; trimmers 79, 125
// and 174 weighing out 298, 311 and 377 grams) so the arithmetic the operators
// do on paper and the arithmetic the app does can be compared directly.

const A = require('../prod_analytics.js');
const { stages, ASOF, DRY_UID } = require('./prod_fixture.js');
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

// The truck in Fresh Plant Intake carries two batches on one manifest — its
// two Lemon Cherry Gelato lines should land on the LCG lot (310 = 155+155),
// and the Zoap line on a lot of its own, not lumped into either.
check('the mixed truck\'s two LCG lines both land on the LCG lot', lcg.stages.intake_wet.outputLb, 310);
check('the mixed truck\'s two LCG lines count as two runs', lcg.stages.intake_wet.runs, 2);
const zoapLot = lots.find((l) => l.strain === 'Zoap');
check('the same truck\'s Zoap line becomes its own lot, not merged into LCG', !!zoapLot, true);
check('the Zoap lot only touched intake — no downstream stages for it in this fixture', Object.keys(zoapLot.stages), ['intake_wet']);

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

console.log('\ncrew labor log (employee × batch, the payroll-join seam)');
const laborLog = A.crewLaborLog(stages);
const buckTouches = laborLog.filter((e) => e.stationKey === 'buck');
check('two crew rows off the buck record', buckTouches.length, 2);
check('crew row carries the batch UID forward', buckTouches[0].uid, DRY_UID);
check('hand-trim worksheet contributes touches with no hours yet', laborLog.some((e) => e.stationKey === 'hand_trim' && e.hours === null), true);

const byEmp = A.crewLaborByEmployee(stages);
const emp42 = byEmp.find((e) => e.employeeNo === '42');
check('employee 42 shows 4 hours', emp42.hours, 4);
check('employee 42 touched one distinct batch', emp42.batchCount, 1);
const emp79 = byEmp.find((e) => e.employeeNo === '79');
check('employee 79 (hand-trim only) shows 0 logged hours, 1 touch', [emp79.hours, emp79.touches], [0, 1]);

console.log('\nrequests');
const reqs = A.requestSummary(stages, ASOF);
check('one request still open', reqs.filter((r) => r.open).length, 1);
check('transferred request came up 1 lb short', reqs.find((r) => r.id === 'r1').shortLb, 1);

console.log('\nexceptions');
const exc = A.exceptions(stages, ASOF);
check('the stale request is flagged', exc.filter((e) => e.kind === 'stale_request').length, 1);
check('balanced stages raise nothing', exc.filter((e) => e.kind === 'unbalanced' && e.stage === 'buck').length, 0);
// Drying is meant to shed two thirds of its weight and a preroll run consumes
// its input outright; flagging either would bury the rows that matter.
check('moisture loss is not an exception', exc.filter((e) => e.stage === 'dry_check' && e.kind === 'unbalanced').length, 0);
check('a manufacturing run is not an exception', exc.filter((e) => e.stage === 'mfg_output').length, 0);
// Fresh Plant Intake has no single farm-reported number to check the scale
// against anymore (a truck can carry more than one batch) — the old
// intake_variance check is gone with it; see the comment in exceptions().
check('no intake_variance exceptions exist anymore', exc.filter((e) => e.kind === 'intake_variance').length, 0);
check('total exceptions', exc.length, 1);

console.log(failures ? `\n${failures} test(s) failed\n` : '\nAll tests passed\n');
process.exit(failures ? 1 : 0);
