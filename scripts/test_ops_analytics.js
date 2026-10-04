// Tests for ops_analytics.js. Run with: node scripts/test_ops_analytics.js
//
// The fixture below is a single lot walked end to end, using the real numbers
// off the Lemon Cherry Gelato work order (23.65 lb bucked in; trimmers 79, 125
// and 174 weighing out 298, 311 and 377 grams) so the arithmetic the operators
// do on paper and the arithmetic the app does can be compared directly.

const A = require('../ops_analytics.js');
const { stages, ASOF, DRY_UID } = require('./ops_fixture.js');
const { G_PER_LB } = require('../operations_stations.js');

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

// Wet Intake is one record per farm package; Take Down retags it as a new
// on-stem package (and the fixture gives the farm UID as only its last 5) —
// harvest, intake, take down and everything downstream should still be one lot.
check('intake lands on the LCG lot net of bin tare', lcg.stages.intake_wet.outputLb, 310);
check('the lot is keyed on the full farm UID', lcg.id, '1A4060300032386000000777');
const zoapLot = lots.find((l) => l.strain === 'Zoap');
check('the Zoap package from the same truck becomes its own lot', !!zoapLot, true);
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

console.log('\ndaily output by process');
const daily = A.dailyOutput(stages);
check('one date per station touched in the fixture', daily.dates.length, 6);
check('buck shows up with its one day of output (all four output fields, not just buckedFlowerLb)', daily.byDateStation['2026-08-19'].buck, 60 + 22 + 16 + 4);
check('machine_trim total for its day = all five output fields', daily.byDateStation['2026-08-22'].machine_trim, 20 + 8 + 3 + 5 + 0.35, 1e-6);
check('mfg_output never appears (no biomass outputs of its own)', daily.stationKeys.includes('mfg_output'), false);
check('totalsByDate sums every station touched that day', daily.totalsByDate[daily.dates.indexOf('2026-08-05')], 310 + 402, 1e-6);

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

console.log('\nlabor log (labor_log.html entries)');
// The fixture's truck: the LCG farm package came in at 310 wet lb, Zoap
// (1A9999) at 92. LCG was taken down into DRY_UID and bucked from 102 dry lb.
const FARM_UID = '1A4060300032386000000777';
const laborStages = { ...stages, labor_entry: [
  // 8 hours of intake across both packages — split by wet lb
  { id: 'L1', process: 'intake_wet', employeeId: '5475211', employeeName: 'Gilberto Diaz', hours: 8, date: ASOF, rate: 25,
    uids: [{ uid: FARM_UID, strain: 'Lemon Cherry Gelato' }, { uid: '1A9999', strain: 'Zoap' }] },
  // take-down across LCG and a package with no weight anywhere — even split
  { id: 'L2', process: 'dry_check', employeeId: '5475211', employeeName: 'Gilberto Diaz', hours: 4, date: ASOF,
    uids: [{ uid: FARM_UID }, { uid: '1AUNKNOWN0000000000000001' }] },
  // bucking on the on-stem UID — still the LCG lot
  { id: 'L3', process: 'buck', employeeId: '7366212', employeeName: 'Andres Beltran', hours: 6, date: ASOF, uids: [{ uid: DRY_UID }] },
  // general harvest work, no UID
  { id: 'L4', process: 'harvest', employeeId: '5475211', employeeName: 'Gilberto Diaz', hours: 1.5, date: ASOF, uids: [] },
  // removed entries count for nothing
  { id: 'L5', process: 'buck', employeeId: '5475211', employeeName: 'Gilberto Diaz', hours: 3, date: ASOF, voided: true,
    uids: [{ uid: DRY_UID }] }
] };
const allocs = A.laborAllocations(laborStages, 20);
const l1 = allocs.filter((a) => a.entryId === 'L1');
check('intake hours split by wet lb (310 : 92)', l1.map((a) => a.hours), [6.169, 1.831]);
check('…and marked as a weight split', l1.map((a) => a.basis), ['weight', 'weight']);
check('entry rate wins over the default', l1[0].cost, 154.23);
const l2 = allocs.filter((a) => a.entryId === 'L2');
check('a UID with no weight falls back to an even split', [l2.map((a) => a.hours), l2[0].basis], [[2, 2], 'even']);
check('take-down weight is the wet lb going in', A.lotLbForProcess(A.buildLots(laborStages).find((l) => l.id === FARM_UID), 'dry_check'), 310);
const l3 = allocs.find((a) => a.entryId === 'L3');
check('on-stem UID rolls back to the farm lot', l3.lotId, FARM_UID);
check('default rate when the entry has none', l3.cost, 120);
check('voided entry is left out', allocs.some((a) => a.entryId === 'L5'), false);

const byLot = A.laborCostByLot(laborStages, 20);
const lcgLot = byLot.find((r) => r.lotId === FARM_UID);
check('LCG lot: intake + take-down + bucking hours', lcgLot.hours, 14.17);
check('LCG lot: cost across stages', lcgLot.cost, 154.23 + 40 + 120);
check('LCG lot: cost per wet lb', lcgLot.costPerWetLb, (154.23 + 40 + 120) / 310, 1e-6);
check('LCG lot flagged for the even take-down split', lcgLot.evenSplit, true);
check('general work is its own row, last', [byLot[byLot.length - 1].lotId, byLot[byLot.length - 1].hours], ['', 1.5]);

const llRows = A.crewLaborLog(laborStages).filter((e) => e.employeeNo === '5475211');
check('crew log: one row per UID plus the no-UID row', llRows.length, 5);
check('strain filter keeps only that strain’s share', A.crewLaborLog(laborStages, { strain: 'Zoap' }).map((e) => e.hours), [1.831]);
const gil = A.crewLaborByEmployee(laborStages).find((e) => e.employeeNo === '5475211');
check('employee roll-up: 13.5 hours, named', [gil.hours, gil.name], [13.5, 'Gilberto Diaz']);

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
