// Tests for metrc_transfers.js (Metrc Queue's "Incoming transfers"). Run with:
//   node scripts/test_metrc_transfers.js

const M = require('../metrc_transfers.js');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`); }
  else console.log(`  ✓ ${name}`);
}

// Canix's "Z" times are California wall-clock times.
check('PDT departure', new Date(M.pacificTime('2026-10-19T10:12:00.000Z')).toISOString(), '2026-10-19T17:12:00.000Z');
check('PST departure', new Date(M.pacificTime('2026-12-01T08:00:00.000Z')).toISOString(), '2026-12-01T16:00:00.000Z');
check('day after DST ends', new Date(M.pacificTime('2026-11-01T12:00:00.000Z')).toISOString(), '2026-11-01T20:00:00.000Z');
check('no time', M.pacificTime(''), null);

const facilities = [
  { license_number: 'CCL22-0001284', name: 'Adobe: CCL22-0001284' },
  { license_number: 'CCL26-0000027', name: 'Comstock: CCL26-0000027 - All Good Properties, Inc' }
];
const pkg = (tag, status, lb) => ({ package: { tag }, status, shipped_weight: lb, shipped_weight_unit: 'Pounds' });
const tr = (manifest, to, departure, contents) => ({
  manifest_number: manifest, _facility_license_number: 'CCL26-0000027', _facility_name: 'Comstock',
  destinations: [{ destination_facility: to, departure_time: departure, contents }]
});
const transfers = [
  tr('A-overdue', 'CCL22-0001284', '2026-10-18T04:00:00.000Z', [pkg('1A1', 'Shipped', 1000)]),
  tr('B-urgent', 'CCL22-0001284', '2026-10-19T07:36:00.000Z', [pkg('1A2', 'Shipped', 900), pkg('1A3', 'Shipped', 100)]),
  tr('C-ok', 'CCL22-0001284', '2026-10-19T15:30:00.000Z', [pkg('1A4', 'Shipped', 2037)]),
  tr('D-accepted', 'CCL22-0001284', '2026-10-17T06:00:00.000Z', [pkg('1A5', 'Accepted', 1536)]),
  tr('E-not-ours', 'C11-0001255-LIC', '2026-10-01T06:00:00.000Z', [pkg('1A6', 'Shipped', 50)]),
  tr('', 'CCL22-0001284', '2026-10-12T12:00:00.000Z', [pkg('1A7', 'Pending', 50)]),
  tr('F-voided', 'CCL22-0001284', '2026-10-12T12:00:00.000Z', [pkg('1A8', 'Voided', 50)]),
  tr('G-partly', 'CCL22-0001284', '2026-10-19T09:00:00.000Z', [pkg('1A9', 'Accepted', 10), pkg('1A10', 'Shipped', 20)])
];
// 2026-10-20 00:30 PDT
const now = Date.parse('2026-10-20T07:30:00Z');
const got = M.incomingTransfers(transfers, facilities, now);
check('only ours, made in Metrc, still shipped — soonest first', got.map((x) => x.manifest), ['A-overdue', 'B-urgent', 'G-partly', 'C-ok']);
check('levels', got.map((x) => x.level), ['overdue', 'urgent', 'ok', 'ok']);
check('hours left', got.map((x) => Math.round(x.hoursLeft * 10) / 10), [-20.5, 7.1, 8.5, 15]);
check('packages still shipped only', got.find((x) => x.manifest === 'G-partly').tags, ['1A10']);
check('weight', got.find((x) => x.manifest === 'B-urgent').weightLb, 1000);
check('destination name', got[0].toName, 'Adobe: CCL22-0001284');

// Outside farms, from Wet Intake.
const inventory = [
  { tag: '1A4060300089ABD000000050', _facility_license_number: 'CCL22-0001284', received_date: '2026-10-18T10:00:00Z' },
  { tag: '1A40603000769A9000000777', _facility_license_number: 'C11-0009999-LIC' }   // not ours
];
const h = 3600000;
const intakes = [
  { id: 'own-farm', startedAt: now - 2 * h, uids: ['1A10'], farm: '027' },   // a tag on one of our transfers
  { id: 'accepted', startedAt: now - 30 * h, uids: ['1A4060300089ABD000000050'], farm: 'CCL24-0000469' },
  { id: 'ff1', startedAt: now - 30 * h, uids: ['1A40603000769A9000000119', '1A40603000769A9000000119'], manifest: '0011716496', farm: 'CCL24-0000469', strain: 'Glass Candy' },
  { id: 'ff2', startedAt: now - 29 * h, uids: ['1A40603000769A9000000120'], manifest: '0011716496', farm: 'CCL24-0000469', strain: 'Cherry Guluz' },
  { id: 'bro', startedAt: now - 20 * h, uids: ['1A406030001B135000001229'], strain: 'BRO2 ORANGE' },
  { id: 'elsewhere', startedAt: now - 3 * h, uids: ['1A40603000769A9000000777'] },
  { id: 'old', startedAt: now - 5 * 24 * h, uids: ['1A406030001B135000009999'] }
];
const ui = M.unacceptedIntakes(intakes, transfers, inventory, facilities, now);
check('intakes not in Canix, one row per manifest', ui.map((x) => x.manifest || x.ids.join()), ['0011716496', 'bro', 'elsewhere']);
check('intake levels', ui.map((x) => x.level), ['overdue', 'urgent', 'ok']);
check('clock from the first intake on the manifest', Math.round(ui[0].hoursLeft), -6);
check('a package counted once', ui[0].packages, 2);
check('intake strains', ui[0].strains, ['Glass Candy', 'Cherry Guluz']);

// Outgoing raw material with no Product Transfer — Outgoing form.
check('product types from Canix item names', [
  'Cured - Whole Plant - Mendogrown Inc. Flower - PC', 'Flower | Smalls | OG | Bulk', 'Flower - Blue Dream',
  'Trim - Gelato', 'Fresh Frozen - Zkittlez', 'Bucked Flower - OG', 'Pre-Roll 1g', 'Mystery'
].map(M.productTypeOf), ['1', '4', '3', '5', '6', '2', '8', '']);
const out = (manifest, from, to, departure, contents) => ({
  manifest_number: manifest, _facility_license_number: from, _facility_name: 'Adobe: CCL22-0001284',
  destinations: [{ destination_facility: to, departure_time: departure, contents }]
});
const each = (tag, n) => ({ package: { tag }, status: 'Accepted', shipped_weight: n, shipped_weight_unit: 'Each' });
const outgoing = [
  out('0011742507', 'CCL22-0001284', 'C11-0002020-LIC', '2026-10-21T16:25:00.000Z',
    [{ ...pkg('1A4060300089ABD000000201', 'Shipped', 32), _item: 'Flower - Blue Dream', _strain: 'Blue Dream' },
     pkg('1A4060300089ABD000000202', 'Shipped', 50), pkg('1A4060300089ABD000000203', 'Voided', 5)]),
  out('0011735201', 'CCL22-0001284', 'C11-0001568-LIC', '2026-10-20T18:15:00.000Z', [pkg('1A4060300089ABD000000301', 'Accepted', 10)]),
  out('0011735202', 'CCL22-0001284', 'C11-0001568-LIC', '2026-10-20T19:00:00.000Z', [pkg('1A4060300089ABD000000401', 'Accepted', 10)]),
  out('0011735203', 'CCL22-0001284', 'C11-0001568-LIC', '2026-10-20T20:00:00.000Z', [pkg('1A4060300089ABD000000501', 'Accepted', 10)]),
  out('0011700000', 'CCL22-0001284', 'C11-0001568-LIC', '2026-10-15T08:00:00.000Z', [pkg('1A4060300089ABD000000601', 'Accepted', 10)]),   // before the form
  out('0011742600', 'CCL26-0000027', 'CCL22-0001284', '2026-10-21T08:00:00.000Z', [pkg('1A4060300089ABD000000701', 'Shipped', 900)]),   // our own license
  out('0011742700', 'CCL22-0001284', 'C11-0001255-LIC', '2026-10-21T08:00:00.000Z', [each('1A4060300089ABD000000801', 500)]),   // pre-rolls (item unknown)
  out('0011742701', 'CCL22-0001284', 'C11-0001255-LIC', '2026-10-21T09:00:00.000Z', [{ ...each('1A4060300089ABD000000802', 40), _item: 'Jar 3.5g - OG' }]),   // finished goods
  out('0011742702', 'CCL22-0001284', 'C8-0000013-LIC', '2026-10-21T10:00:00.000Z', [{ ...pkg('1A4060300089ABD000000803', 'Shipped', 17), shipped_weight_unit: 'Grams' }]),   // lab sample
  out('0011742703', 'C11-0001652-LIC', 'C11-0001255-LIC', '2026-10-21T11:00:00.000Z', [{ ...each('1A4060300089ABD000000804', 500), _item: 'Pre-Roll 1g' }]),   // not from Adobe
  out('', 'CCL22-0001284', 'C11-0001255-LIC', '2026-10-21T08:00:00.000Z', [pkg('1A4060300089ABD000000901', 'Pending', 5)])   // no manifest yet
];
const outForms = [
  { id: 'f1', manifest: '11735201', uids: [] },                     // manifest without its leading zeros
  { id: 'f2', manifest: '', uids: ['ABD000000401'] }                // the end of a tag
];
const outInv = [{ tag: '1A4060300089ABD000000202', item: { name: 'Flower | Smalls | Gelato #41', strain: { name: 'Gelato #41' } } }];
const nf = M.outgoingNeedingForm(outgoing, facilities, outForms, outInv);
check('needs a form: from Adobe, raw or pre-rolls, made in Metrc, since the form, no form for it', nf.map((x) => x.manifest), ['0011735203', '0011742700', '0011742507']);
const pr = nf.find((x) => x.manifest === '0011742700');
check('pre-rolls: pieces, type 8', [pr.packages[0].qty, pr.packages[0].productType, pr.pieces, pr.weightLb], [500, '8', 500, 0]);
nf.splice(1, 1);
check('needs form: voided packages left out', nf[1].tags, ['1A4060300089ABD000000201', '1A4060300089ABD000000202']);
check('needs form: item from the sync, else the inventory', nf[1].packages.map((p) => [p.strain, p.productType, p.lb]), [['Blue Dream', '3', 32], ['Gelato #41', '4', 50]]);
check('needs form: day, destination, weight', [nf[1].date, nf[1].toLicense, nf[1].weightLb], ['2026-10-21', 'C11-0002020-LIC', 82]);
check('needs form: accepted yet', nf.map((x) => x.accepted), [true, false]);

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nAll passed');
