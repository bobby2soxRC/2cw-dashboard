// Esensia strain scope and the inventory function's PIN check.
//   node scripts/test_esensia.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../esensia_scope.js');
const Y = require('../flower_yield.js');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
  } else console.log(`  ✓ ${name}`);
}
function checkTrue(name, cond) {
  if (!cond) { failures++; console.log(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

check('aliases', [
  E.packageStrainKey('BBJ'),
  E.packageStrainKey('Blueberry Jam'),
  E.packageStrainKey('Blueberry'),
  E.packageStrainKey('San #10'),
  E.packageStrainKey('SAN#10'),
  E.packageStrainKey('Magic Wand'),
  E.packageStrainKey('MW'),
  E.packageStrainKey('Grapes and Cream'),
  E.packageStrainKey('LSK'),
  E.packageStrainKey('LSK2'),
  E.packageStrainKey('Marilyn Monroe'),
  E.packageStrainKey('GC'),
  E.packageStrainKey('Grape Gas')
], ['BBJ', 'BBJ', null, 'SAN10', 'SAN10', 'MW', 'MW', 'GRAPES', null, null, null, null, null]);

check('blank item only when the name is the strain', E.blankItemKey('Shake - SWD'), 'SWD');
check('retail pre-roll', E.isRetail('Soma Rosa 1g Pre-Roll - Lime Juice', 'Pre-Roll Flower'), true);
check('bulk flower is not retail', E.isRetail('MEN Flower - OC', 'Flower'), false);

check('stages', [
  E.stageOf('Wet Flower - EBD', 'Fresh Cannabis Plant').stage,
  E.stageOf('Unbucked Flower - BBJ', 'Flower').stage,
  E.stageOf('Dry Flower - OC', 'Flower').stage,
  E.stageOf('Cured - Whole Plant - Mendogrown Inc. Flower - OC', 'Flower').stage,
  E.stageOf('Flower - BBJ', 'Flower').stage,
  E.stageOf('Unfinished Smalls - RSP', 'Flower').stage,
  E.stageOf('Smalls - BBJ', 'Flower').stage,
  E.stageOf('Shake - SWD', 'Shake').stage,
  E.stageOf('Bucked Flower - X', 'Flower').stage
], ['wet', 'on stem', 'on stem', 'whole plant', 'flower', 'smalls', 'smalls', 'shake', 'bucked']);

check('harvest strain: Blueberry Jam counts for BBJ, Grape Gas does not, LS21 does, LSK does not', [
  E.harvestMatches('BBJ', 'Blueberry Jam'),
  E.harvestMatches('BBJ', 'Grape Gas (HVN)'),
  E.harvestMatches('LS', 'LS21[ESN]'),
  E.harvestMatches('LS', 'LSK'),
  E.harvestMatches('SAN10', 'SAN10'),
  E.harvestMatches('SAN10', 'SAN#10')
], [true, false, true, false, true, true]);

const fixture = E.buildView({
  packages: [
    { tag: 'ES1', is_active: true, status: 'In Progress', weight: 10, weight_unit: 'Pounds', facility_id: 1,
      item: { name: 'Flower - BBJ', strain: { name: 'BBJ' }, type: { name: 'Flower' } },
      source_harvests: 'BBJ-T2', cannabis_cogs: 123 },
    { tag: 'ES2', is_active: true, status: 'In Progress', weight: 451, weight_unit: 'Pounds', facility_id: 1,
      item: { name: 'Unbucked Flower - BBJ', strain: { name: 'BBJ' }, type: { name: 'Flower' } },
      source_harvests: 'BBJ-T1' },
    { tag: 'NO1', is_active: true, status: 'In Progress', weight: 99, weight_unit: 'Pounds', facility_id: 1,
      item: { name: 'Flower - Grape Gas', strain: { name: 'Grape Gas' }, type: { name: 'Flower' } },
      cannabis_cogs: 999 },
    { tag: 'SW1', is_active: true, status: 'In Progress', weight: 2.2, weight_unit: 'Pounds', facility_id: 1,
      item: { name: 'Shake - SWD', strain: null, type: { name: 'Shake' } }, source_harvests: '' },
    { tag: 'PR1', is_active: true, status: 'Available To Sell', weight: 100, weight_unit: 'Each', facility_id: 1,
      item: { name: 'Soma Rosa 1g Pre-Roll - Lime Juice', strain: { name: 'LJ' }, type: { name: 'Pre-Roll Flower' } } },
    { tag: 'LSK1', is_active: true, status: 'In Progress', weight: 40, weight_unit: 'Pounds', facility_id: 1,
      item: { name: 'Unbucked Flower - LSK', strain: { name: 'LSK' }, type: { name: 'Flower' } } },
    { tag: 'GC1', is_active: true, status: 'In Progress', weight: 12, weight_unit: 'Pounds', facility_id: 1,
      item: { name: 'Flower - Grapes and Cream', strain: { name: 'Grapes and Cream' }, type: { name: 'Flower' } } },
    { tag: 'SAN1', is_active: true, status: 'In Progress', weight: 5, weight_unit: 'Pounds', facility_id: 1,
      item: { name: 'Flower - San #10', strain: { name: 'San #10' }, type: { name: 'Flower' } } },
    { tag: 'SAN2', is_active: true, status: 'In Progress', weight: 7, weight_unit: 'Pounds', facility_id: 1,
      item: { name: 'Wet Flower - SAN#10', strain: { name: 'SAN#10' }, type: { name: 'Fresh Cannabis Plant' } } },
    { tag: 'BOX', is_active: true, status: 'In Progress', weight: 3, weight_unit: 'Pounds', facility_id: 9,
      item: { name: 'Flower - BBJ', strain: { name: 'BBJ' }, type: { name: 'Flower' } } }
  ],
  harvests: [
    { id: 1, name: 'BBJ-T2', strain: { name: 'Blueberry Jam' }, plant_count: 148, harvest_date: '2026-10-05T00:00:00.000Z', _facility_name: 'Comstock: CCL26-0000027' },
    { id: 2, name: 'BBJ-T1', strain: { name: 'Grape Gas (HVN)' }, plant_count: 124, harvest_date: '2026-10-05T00:00:00.000Z', _facility_name: 'Comstock: CCL26-0000027' }
  ],
  facilities: { '9': { exclude: true, license_number: 'sandbox' } },
  properties: []
});

const bbj = fixture.strains.find((s) => s.key === 'BBJ');
const tags = fixture.strains.flatMap((s) => s.packages.map((p) => p.tag));
check('fixture tags', tags.slice().sort(), ['ES1', 'ES2', 'GC1', 'SAN1', 'SAN2', 'SW1']);
check('BBJ plants leave out the other harvest strain', bbj.plantCount, 148);
check('BBJ actual flower is the weighed package', bbj.actualFlowerLb, 10);
checkTrue('mismatched harvest is on the row, not in the total', bbj.packages.some((p) => p.tag === 'ES2' && p.plantCount === 124 && p.plantsCounted === false));
check('Grapes and Cream groups, SAN spellings group', [
  fixture.strains.find((s) => s.key === 'GRAPES').packageCount,
  fixture.strains.find((s) => s.key === 'SAN10').packageCount,
  fixture.strains.find((s) => s.key === 'SAN10').byStage.wet,
  fixture.strains.find((s) => s.key === 'SAN10').byStage.flower
], [1, 2, 7, 5]);
checkTrue('no costs, other strains, or retail in the view', !/cogs|Grape Gas|LSK|Pre-Roll|999|sandbox/i.test(JSON.stringify(fixture)));
checkTrue('shake is not orderable; flower is', fixture.strains.find((s) => s.key === 'SWD').packages[0].orderable === false && bbj.packages.find((p) => p.tag === 'ES1').orderable === true);
check('farm from the harvest facility', bbj.packages.find((p) => p.tag === 'ES1').farm, 'Comstock (2CW)');

const model = Y.buildModel({
  downs: [],
  bucks: [{ strain: 'BBJ', sourceUid: '0001', startingDryLb: 200, buckedFlowerLb: 100 }],
  trims: [{ strain: 'BBJ', sourceUid: '0001', startingBuckedLb: 100, finishedFlowerLb: 50 }],
  strains: E.yieldStrains()
});
const estimated = E.buildView({
  packages: [
    { tag: 'U1', is_active: true, status: 'In Progress', weight: 100, weight_unit: 'Pounds', facility_id: 1,
      item: { name: 'Unbucked Flower - BBJ', strain: { name: 'BBJ' }, type: { name: 'Flower' } }, source_harvests: '' },
    { tag: 'F1', is_active: true, status: 'In Progress', weight: 4, weight_unit: 'Pounds', facility_id: 1,
      item: { name: 'Flower - BBJ', strain: { name: 'BBJ' }, type: { name: 'Flower' } }, source_harvests: '' }
  ],
  harvests: [], facilities: {}, properties: [], yieldModel: model
});
const estBbj = estimated.strains.find((s) => s.key === 'BBJ');
check('estimate is labeled and does not replace the actual flower', [estBbj.actualFlowerLb, estBbj.estimatedAdditionalFlowerLb], [4, 25]);
checkTrue('estimate note says ESTIMATED', /ESTIMATED/.test(estBbj.estimateNote) && !/ACTUAL/.test(String(estBbj.estimatedAdditionalFlowerLb)));
checkTrue('package weight stays the Canix weight', estBbj.packages.find((p) => p.tag === 'U1').lb === 100);

// Live snapshot, when the sync files are in the repo. Locks the rules the
// yield report used: LSK and pre-rolls stay out, blank-strain Shake - SWD
// stays in, San #10 spellings are one strain.
const root = path.join(__dirname, '..');
const invPath = path.join(root, 'data/canix_inventory.json');
if (fs.existsSync(invPath)) {
  const live = E.buildView({
    packages: JSON.parse(fs.readFileSync(invPath, 'utf8')),
    harvests: JSON.parse(fs.readFileSync(path.join(root, 'data/canix_harvests.json'), 'utf8')),
    facilities: JSON.parse(fs.readFileSync(path.join(root, 'config/canix_facility_config.json'), 'utf8')),
    properties: JSON.parse(fs.readFileSync(path.join(root, 'data/operations/reference.json'), 'utf8')).properties
  });
  const liveTags = new Set(live.strains.flatMap((s) => s.packages.map((p) => p.tag)));
  const liveItems = live.strains.flatMap((s) => s.packages.map((p) => p.item));
  checkTrue('live snapshot includes Shake - SWD', live.strains.find((s) => s.key === 'SWD').packages.some((p) => p.tag === '1A406030005E0B2000010514' && p.stage === 'shake'));
  checkTrue('live snapshot drops the LJ pre-rolls', !liveItems.some((n) => /pre-?roll/i.test(n)));
  checkTrue('live snapshot drops LSK', !live.strains.some((s) => s.packages.some((p) => /LSK/.test(p.item))));
  checkTrue('live snapshot drops other brands’ packaged flower', !liveItems.some((n) => /Howie Roll|Soma Rosa|1\/8 oz|1\/2 oz/i.test(n)));
  checkTrue('plain Blueberry is not BBJ', !live.strains.find((s) => s.key === 'BBJ').packages.some((p) => /\|\s*Blueberry\s*$/i.test(p.item)));
  checkTrue('live SAN #10 is one strain', live.strains.find((s) => s.key === 'SAN10').packages.some((p) => /SAN#10/i.test(p.item)) && live.strains.find((s) => s.key === 'SAN10').packages.some((p) => /San #10/.test(p.item)));
  const bbjLive = live.strains.find((s) => s.key === 'BBJ');
  const grapeRow = bbjLive.packages.find((p) => p.sourceHarvest === 'BBJ-T1-10-05-2026');
  checkTrue('BBJ-T1 plants are not in the BBJ total', grapeRow && grapeRow.plantsCounted === false && bbjLive.plantCount && bbjLive.plantCount < (bbjLive.packages.reduce((a, p) => a + (p.plantCount || 0), 0)));
  checkTrue('every live tag is an Esensia package', liveTags.size === live.packageCount && live.packageCount > 0);
  console.log(`  live packages ${live.packageCount}, lb ${live.lb}, actual flower ${live.actualFlowerLb}`);
} else {
  console.log('  (no canix_inventory.json — live snapshot checks skipped)');
}

// Function: PIN and the esensia column, with Supabase and the files faked.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esensia-'));
fs.mkdirSync(path.join(tmp, 'data/operations'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'data/canix_inventory.json'), JSON.stringify([
  { tag: 'ES1', is_active: true, status: 'In Progress', weight: 10, weight_unit: 'Pounds', facility_id: 1,
    item: { name: 'Flower - BBJ', strain: { name: 'BBJ' }, type: { name: 'Flower' } }, source_harvests: '', cannabis_cogs: 50 },
  { tag: 'NO1', is_active: true, status: 'In Progress', weight: 99, weight_unit: 'Pounds', facility_id: 1,
    item: { name: 'Flower - Grape Gas', strain: { name: 'Grape Gas' }, type: { name: 'Flower' } }, cannabis_cogs: 999 }
]));
fs.writeFileSync(path.join(tmp, 'data/canix_harvests.json'), '[]');
fs.writeFileSync(path.join(tmp, 'data/canix_meta.json'), JSON.stringify({ last_sync: '2026-11-20T12:00:00Z' }));
fs.writeFileSync(path.join(tmp, 'config/canix_facility_config.json'), '{}');
fs.writeFileSync(path.join(tmp, 'data/operations/reference.json'), JSON.stringify({ properties: [] }));

process.env.ESENSIA_DATA_DIR = tmp;
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
const { handler } = require('../netlify/functions/esensia-inventory.js');

const users = {
  '1234': { name: 'Ben', pin: '1234', columns: { esensia: 'TRUE' } },
  '5678': { name: 'Niki', pin: '5678', columns: { sales: 'TRUE' } }
};
global.fetch = async (url, opts) => {
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (!opts.headers || opts.headers.Authorization !== 'Bearer test-service-key') return reply(401, {});
  if (String(url).includes('/rest/v1/app_users?')) {
    const pins = Object.keys(users).filter((p) => decodeURIComponent(url).includes(p));
    return reply(200, pins.map((p) => users[p]));
  }
  if (String(url).includes('/rest/v1/operations_forms?')) return reply(200, []);
  throw new Error('unexpected fetch ' + url);
};
const call = (body, method) => handler({ httpMethod: method || 'POST', body: JSON.stringify(body || {}) })
  .then((res) => ({ status: res.statusCode, json: JSON.parse(res.body) }));

(async () => {
  const a = await call(null, 'GET');
  check('rejects non-POST', a.status, 405);
  const b = await call({});
  check('rejects a missing PIN', b.status, 401);
  const c = await call({ pin: '0000' });
  check('rejects an unknown PIN', c.status, 401);
  const d = await call({ pin: '5678' });
  check('rejects a user without the Esensia card', d.status, 403);
  checkTrue('a forbidden user gets no inventory', !d.json.view);
  const e = await call({ pin: '1234' });
  check('Esensia user gets a view', e.status, 200);
  const body = JSON.stringify(e.json);
  checkTrue('response has BBJ and not the other strain or its cost', /ES1/.test(body) && !/NO1|Grape Gas|999|cogs/.test(body));
  check('as-of comes from the sync meta', e.json.view.asOf, '2026-11-20T12:00:00Z');
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
