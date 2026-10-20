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

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nAll passed');
