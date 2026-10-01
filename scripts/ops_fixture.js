// A single lot walked end to end, plus a couple of deliberately imperfect rows.
// Used by scripts/test_ops_analytics.js, and by scripts/seed_demo_operations.js
// to fill an empty install so the dashboard has something to draw.
//
// The numbers come off the real Lemon Cherry Gelato work order: 23.65 lb of
// bucked flower in, trimmers 79, 125 and 174 weighing out 298, 311 and 377
// grams.

const { G_PER_LB } = require('../operations_stations.js');

const FARM_UID = '1A4060300032386000000777';
const DRY_UID = '1A4060300032386000001008';

const stages = {
  harvest: [
    { id: 'h1', date: '2026-08-05', sourceUid: FARM_UID, strain: 'Lemon Cherry Gelato', site: 'BG',
      harvestBatchName: 'BG-0309-Lemon Cherry Gelato-216-T4', wetWeightLb: 310, plantCount: 40 }
  ],
  // Harvest Intake — Wet: one record per incoming farm package. Each line is
  // a group of bins on the scale; totalWetLb is net of the bins' tare. The
  // Zoap package came in on the same truck but is its own lot.
  intake_wet: [
    { id: 'i1', date: '2026-08-05', sourceUid: FARM_UID, pid: '540', strain: 'Lemon Cherry Gelato',
      manifestNo: '0001234567', completedBy: 'Ops', weighmaster: 'Ops', dryRoom: 'DRY1',
      lines: [
        { binCount: 3, tareEachLb: 5, weight: 170 },
        { binCount: 3, tareEachLb: 5, weight: 170 }
      ],
      binCount: 6, totalTareLb: 30, totalWetLb: 310 },
    { id: 'i2', date: '2026-08-05', sourceUid: '1A9999', pid: '540', strain: 'Zoap',
      manifestNo: '0001234567', completedBy: 'Ops', weighmaster: 'Ops', dryRoom: 'DRY1',
      lines: [{ binCount: 2, tareEachLb: 5, weight: 102 }],
      binCount: 2, totalTareLb: 10, totalWetLb: 92 }
  ],
  // Take Down — Dry retags the farm package (written as just its last 5 here,
  // the way the paper form asks for it) as a new on-stem package, DRY_UID.
  dry_check: [
    { id: 'd1', date: '2026-08-17', incomingUid: FARM_UID.slice(-5), sourceUid: DRY_UID, strain: 'Lemon Cherry Gelato',
      boxes: [{ boxNo: '1', tareLb: 2, weight: 53 }, { boxNo: '2', tareLb: 2, weight: 53 }],
      wetIntakeLb: 310, dryWeightLb: 102, result: 'pass' }
  ],
  // Bucking no longer mints a new UID when it finishes — the summary record
  // (what buck_station.html writes when a batch closes, rolled up from many
  // small employee/box submissions) stays tagged under the same dried-batch
  // UID dry_check produced. See operations_stations.js's 'buck' entry.
  buck: [
    { id: 'b1', date: '2026-08-19', sourceUid: DRY_UID, strain: 'Lemon Cherry Gelato',
      startingDryLb: 102,
      buckedFlowerLb: 60, bigLeafLb: 22, stemLb: 16, wasteLb: 4,
      laborHours: 8, crewSize: 4,
      crew: [{ employeeNo: '42', hours: 4 }, { employeeNo: '58', hours: 4 }] }
  ],
  machine_trim: [
    { id: 'm1', date: '2026-08-22', sourceUid: DRY_UID, strain: 'Lemon Cherry Gelato',
      inputBuckedLb: 36.35, flowerALb: 20, smallsBLb: 8, machineShakeLb: 3, sugarTrimLb: 5, wasteLb: 0.35 }
  ],
  hand_trim: [
    { id: 't1', date: '2026-08-29', sourceUid: DRY_UID, strain: 'Lemon Cherry Gelato',
      startingBuckedLb: 23.65, workOrderNo: '23',
      weights: [{ employeeNo: '79', grams: 298 }, { employeeNo: '125', grams: 311 }, { employeeNo: '174', grams: 377 }],
      finishedFlowerLb: 986 / G_PER_LB, smallsLb: 4, sugarTrimLb: 8, wasteLb: 9 }
  ],
  fresh_frozen: [
    { id: 'f1', date: '2026-08-10', site: 'AF', strain: 'Glitter Bomb', totalLb: 500, bagCount: 25, freezer: 'FRZ-1' }
  ],
  biomass_request: [
    { id: 'r1', date: '2026-08-25', requestedBy: 'Ops', destinationDept: 'prerolls', category: 'smalls_b',
      strain: 'Lemon Cherry Gelato', requestedLb: 10, status: 'transferred', transferredLb: 9, transferDate: '2026-08-26' },
    { id: 'r2', date: '2026-08-20', requestedBy: 'Ops', destinationDept: 'flower', category: 'flower_a',
      strain: 'Lemon Cherry Gelato', requestedLb: 15, status: 'requested' }
  ],
  mfg_output: [
    { id: 'g1', date: '2026-08-27', line: 'prerolls', brand: 'howie_roll', sku: 'HR-Pouch-14g',
      inputCategory: 'smalls_b', inputLb: 5, unitsProduced: 160, unitSizeG: 14 }
  ]
};

module.exports = { stages, DRY_UID, ASOF: '2026-08-30' };
