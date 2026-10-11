// Tests for metrc_recon.js. Run with: node scripts/test_metrc_recon.js
//
// One farm package walked from Wet Intake through Take Down, Bucking and a
// Machine Trim run, plus a pre-roll batch, checked against a hand-made Metrc
// package list with one of each kind of difference in it.

const R = require('../metrc_recon.js');

let failures = 0;
function check(name, actual, expected, tol = 1e-6) {
  const ok = typeof expected === 'number'
    ? Math.abs(actual - expected) <= tol
    : JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`); }
  else console.log(`  ✓ ${name}`);
}

const FARM = '1A4060300000000000001111';
const DRY = '1A4060300000000000002222';
const PART = '1A4060300000000000003333';
const PR_IN = '1A4060300000000000004444';
const PR_OUT = '1A4060300000000000005555';
const ORPHAN = '1A4060300000000000009999';

const stages = {
  intake_wet: [
    { id: 'w1', date: '2026-09-01', submittedAt: '2026-09-01T10:00:00Z', sourceUid: '01111', strain: 'OG',
      lines: [{ sourceUid: '01111', strain: 'OG', binCount: 2, tareEachLb: 5, weight: 110 }] },
    // An intake nobody took down yet, and Metrc has no record of.
    { id: 'w2', date: '2026-09-02', submittedAt: '2026-09-02T10:00:00Z', sourceUid: ORPHAN, strain: 'Gelato', totalWetLb: 40 }
  ],
  dry_check: [
    { id: 'd1', date: '2026-09-08', submittedAt: '2026-09-08T10:00:00Z', incomingUid: '01111', sourceUid: DRY,
      strain: 'OG', dryWeightLb: 25, releases: [{ uid: PART, lb: 5 }] }
  ],
  buck: [
    { id: 'b1', date: '2026-09-10', submittedAt: '2026-09-10T10:00:00Z', sourceUid: DRY, buckedFlowerLb: 15 }
  ],
  machine_trim: [
    { id: 'm1', date: '2026-09-11', submittedAt: '2026-09-11T10:00:00Z', sourceUid: DRY, inputBuckedLb: 10 }
  ],
  preroll_production: [
    { id: 'p1', date: '2026-09-12', submittedAt: '2026-09-12T10:00:00Z', sourceUid: PR_IN, startingWtG: 453.59237,
      newPrerollUid: PR_OUT, totalPrerolls: 400, totalWasteG: 10 }
  ],
  // Metrc set PR_IN up as 2 lb before the batch; nothing else names it.
  harvest: [
    { id: 'h1', date: '2026-09-01', submittedAt: '2026-09-01T08:00:00Z', sourceUid: PR_IN, wetWeightLb: 2 }
  ]
};

console.log('\napp packages');
const pkgs = R.buildAppPackages(stages);
check('wet intake weight is worked out net of tare when missing', pkgs.get('01111').events[0].lb, 100);
check('take down closes the farm package', pkgs.get('01111').active, false);
check('dry package = dry weight − part released, then bucked, then trimmed', pkgs.get(DRY).amount, 15 - 10);
check('the released part is its own package', pkgs.get(PART).amount, 5);
check('pre-roll batch takes its starting weight out of the source', pkgs.get(PR_IN).amount, 1, 1e-3);
check('pre-roll output is counted in units', [pkgs.get(PR_OUT).unit, pkgs.get(PR_OUT).amount], ['each', 400]);

console.log('\nreconcile');
const metrc = [
  { tag: FARM, quantity: 0.5, unit: 'Pounds', is_active: true },          // used up in the App, still in Metrc
  { tag: DRY, quantity: 2268, unit: 'Grams', is_active: true },           // 5.0 lb — matches
  { tag: PART, quantity: 4.5, unit: 'Pounds', is_active: true },          // weight off by 0.5
  { tag: PR_IN, quantity: 1.004, unit: 'Pounds', is_active: true },       // inside tolerance
  { tag: PR_OUT, quantity: 398, unit: 'Each', is_active: true },          // count off by 2
  { tag: '1A4060300000000000007777', quantity: 3, unit: 'Pounds', is_active: true, strain: 'Runtz' }
];
const issues = R.reconcile(pkgs, metrc, { toleranceLb: 0.01 });
const byTag = Object.fromEntries(issues.map((i) => [i.tag, i]));
check('short App UID resolves to the full Metrc tag', byTag[FARM] && byTag[FARM].appUid, '01111');
check('used-up App package still active in Metrc is a weight issue', [byTag[FARM].kind, byTag[FARM].usedUpInApp], ['weight', true]);
check('grams are converted before comparing', byTag[DRY], undefined);
check('weight mismatch diff is Metrc − App', byTag[PART] && byTag[PART].diff, -0.5);
check('within tolerance is not an issue', byTag[PR_IN], undefined);
check('unit packages compare counts exactly', byTag[PR_OUT] && byTag[PR_OUT].diff, -2);
check('Metrc package the App never saw', byTag['1A4060300000000000007777'].kind, 'metrc_only');
check('App package not active in Metrc', byTag[ORPHAN].kind, 'app_only');
check('issues come out metrc_only, app_only, weight', issues.map((i) => i.kind), ['metrc_only', 'app_only', 'weight', 'weight', 'weight']);

console.log('\nstatus');
const iss = byTag[PART];
check('no row → needs attention', R.statusOf(iss, null).status, 'needs_attention');
check('known with the same weights stays known', R.statusOf(iss, { status: 'known', signature: iss.signature }).status, 'known');
const moved = R.statusOf(iss, { status: 'known', signature: R.signatureOf('weight', 4.0, 5) });
check('known, but the weights moved → back to needs attention', [moved.status, moved.changed], ['needs_attention', true]);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
