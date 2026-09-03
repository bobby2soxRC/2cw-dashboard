// A single lot walked end to end, plus a couple of deliberately imperfect rows.
// Used by scripts/test_prod_analytics.js, and by scripts/seed_demo_production.js
// to fill an empty install so the dashboard has something to draw.
//
// The numbers come off the real Lemon Cherry Gelato work order: 23.65 lb of
// bucked flower in, trimmers 79, 125 and 174 weighing out 298, 311 and 377
// grams.

const { G_PER_LB } = require('../production_stations.js');

const DRY_UID = '1A4060300032386000001008';
const BUCKED_UID = '1A4060300032386000009008';

const stages = {
  harvest: [
    { id: 'h1', date: '2026-08-05', sourceUid: DRY_UID, strain: 'Lemon Cherry Gelato', site: 'BG',
      harvestBatchName: 'BG-0309-Lemon Cherry Gelato-216-T4', wetWeightLb: 310, plantCount: 40 }
  ],
  // A single truck (Fresh Plant Intake) carrying more than one batch — the
  // real paper log unloads a few bins at a time, weighing each group, and a
  // truck can be mixed (two strains/UIDs on one manifest).
  intake_wet: [
    { id: 'i1', date: '2026-08-05', pid: '540', site: 'BG',
      lines: [
        { containerType: 'bins', containerCount: 3, weight: 155, sourceUid: DRY_UID, strain: 'Lemon Cherry Gelato', intakeFormat: 'wet_on_stem' },
        { containerType: 'bins', containerCount: 3, weight: 155, sourceUid: DRY_UID, strain: 'Lemon Cherry Gelato', intakeFormat: 'wet_on_stem' },
        { containerType: 'totes', containerCount: 2, weight: 92, sourceUid: '1A9999', strain: 'Zoap', intakeFormat: 'wet_on_stem' }
      ],
      totalWetLb: 402, binCount: 8, dryRoom: 'DRY1' }
  ],
  dry_check: [
    { id: 'd1', date: '2026-08-17', sourceUid: DRY_UID, strain: 'Lemon Cherry Gelato',
      wetIntakeLb: 310, dryWeightLb: 102, result: 'pass' }
  ],
  buck: [
    { id: 'b1', date: '2026-08-19', sourceUid: DRY_UID, strain: 'Lemon Cherry Gelato',
      estWeightNeededLb: 102,
      boxesRemoved: [{ boxNo: '1', weightLb: 52 }, { boxNo: '2', weightLb: 50 }],
      startingDryLb: 102,
      buckedWeights: [{ bagNo: '1', weightLb: 30 }, { bagNo: '2', weightLb: 30 }],
      buckedFlowerLb: 60, bigLeafLb: 22, stemLb: 16, wasteLb: 4,
      newBuckedUid: BUCKED_UID, laborHours: 8, crewSize: 4,
      crew: [{ employeeNo: '42', hours: 4 }, { employeeNo: '58', hours: 4 }] }
  ],
  machine_trim: [
    { id: 'm1', date: '2026-08-22', sourceUid: BUCKED_UID, strain: 'Lemon Cherry Gelato',
      inputBuckedLb: 36.35, flowerALb: 20, smallsBLb: 8, machineShakeLb: 3, sugarTrimLb: 5, wasteLb: 0.35 }
  ],
  hand_trim: [
    { id: 't1', date: '2026-08-29', sourceUid: BUCKED_UID, strain: 'Lemon Cherry Gelato',
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

module.exports = { stages, DRY_UID, BUCKED_UID, ASOF: '2026-08-30' };
