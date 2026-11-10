// Tests for inv_adjust.js (Inventory Adjustments: Metrc vs Raw Inventory) and
// raw_stock.js's applyAdjusted (how saved adjustments change the stock).
// Run with:  node scripts/test_inv_adjust.js

// raw_stock.js expects ops_common.js's UID helpers as globals.
global.normUid = (u) => String(u || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
global.uidTailMatch = (a, b) => {
  a = normUid(a); b = normUid(b);
  if (Math.min(a.length, b.length) < 4) return false;
  return a.endsWith(b) || b.endsWith(a);
};
const A = require('../inv_adjust.js');
const RawStock = require('../raw_stock.js');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`); }
  else console.log(`  ✓ ${name}`);
}

// ── Items and quantities ──
check('tab from Metrc item names', [
  'Wet Flower - Zoap', 'Unbucked Flower - Grape Gas', 'Unfinished Smalls - Zoap', 'Smalls - Zoap', 'Flower | Smalls | OG | Bulk',
  'Flower - Hashburger', 'Biomass - Mix', 'Pre-Roll-2CW- (1g)', 'Fresh Frozen - Zoap', 'Bucked Flower - Zoap', 'Fresh Cannabis Flowers'
].map((n) => A.tabOfItem(n)), ['drying', 'onstem', 'smalls_unf', 'smalls', 'smalls', 'flower', 'trim', 'finished', 'frozen', 'bucked', 'drying']);
check('quantities and units', [A.qtyOf('12.5 lb'), A.qtyOf('453.59237', 'Grams'), A.qtyOf('1 kg'), A.qtyOf('28', 'Each'), A.qtyOf('1,204.5'), A.qtyOf('n/a')],
  [{ qty: 12.5, unit: 'lb' }, { qty: 1, unit: 'lb' }, { qty: 2.2, unit: 'lb' }, { qty: 28, unit: 'units' }, { qty: 1204.5, unit: 'lb' }, null]);

// ── Canix ──
const canix = [
  { tag: '1A4060300047D39000000001', is_active: true, status: 'In Progress', weight: 10, weight_unit: 'Pounds', _facility_license_number: 'CCL22-0001284',
    item: { name: 'Flower - Zoap', strain: { name: 'Zoap' }, type: { name: 'Flower' } } },
  { tag: '1A4060300047D39000000002', is_active: true, status: 'In Transit', weight: 4, weight_unit: 'Pounds', _facility_license_number: 'CCL22-0001284',
    item: { name: 'Smalls - Zoap', strain: { name: 'Zoap' } } },
  { tag: '1A4060300047D39000000003', is_active: true, status: 'In Progress', weight: 900, weight_unit: 'Grams', _facility_license_number: 'C11-0001652-LIC',
    item: { name: 'Flower - OG' } }
];
const pk = A.fromCanix(canix, ['CCL22-0001284']);
check('Canix: only the license asked for, In Transit marked', pk.map((p) => [p.uid.slice(-3), p.qty, p.tab, p.inTransit]), [['001', 10, 'flower', false], ['002', 4, 'smalls', true]]);

// ── Uploads ──
const csv = 'Physical count Nov 2026\nTag,Item,Quantity,Unit of Measure\n"1A4060300047D39000000001","Flower - Zoap","8.5","Pounds"\n1A4060300047D39000000009,Trim - Zoap,500,Grams\n1A4060300047D39000000009,Trim - Zoap,500,Grams\n,,,\nTotal,,9,\n';
const up = A.fromGrid(A.parseCsv(csv));
check('upload: header found under a title row, grams to lb, same tag added up, junk skipped',
  [up.header, up.pkgs.map((p) => [p.uid.slice(-3), p.qty, p.tab]), up.skipped], [1, [['001', 8.5, 'flower'], ['009', 2.2, 'trim']], 1]);
const bare = A.fromGrid([['1A4060300047D39000000001', 'Zoap', '7'], ['1A4060300047D39000000002', 'Zoap', '3 lb']]);
check('upload: no header — tag column and first number column', bare.pkgs.map((p) => [p.uid.slice(-3), p.qty]), [['001', 7], ['002', 3]]);
check('upload: tab-separated with "12.5 lb" cells', A.fromGrid(A.parseCsv('UID\tWeight\n0001\t12.5 lb\n')).pkgs.map((p) => [p.uid, p.qty]), [['0001', 12.5]]);

// ── Compare ──
const row = (key, uid, tab, lb, date = '2026-10-01', x = {}) => ({ key, uid, tab, lb, startLb: lb, date, strain: 'Zoap', used: [], ...x });
const rows = [
  row('a', '1A4060300047D39000000001', 'flower', 6), row('b', '1A4060300047D39000000001', 'flower', 4, '2026-10-05'),
  row('c', '1A4060300047D39000000002', 'smalls', 4),
  row('d', '1A4060300047D39000000004', 'trim', 3),
  row('e', '1A4060300047D39000000005', 'trim', 2),       // marked used up
  row('f', '', 'trim', 1.5)                              // no UID
];
const metrc = [
  { uid: '1A4060300047D39000000001', qty: 10, unit: 'lb', tab: 'flower' },
  { uid: '1A4060300047D39000000002', qty: 4, unit: 'lb', tab: 'smalls', inTransit: true },
  { uid: '1A4060300047D39000000005', qty: 1.5, unit: 'lb', tab: 'trim' },
  { uid: '1A4060300047D39000000006', qty: 2.25, unit: 'lb', tab: 'trim', strain: 'OG' }
];
const cmp = A.compare(rows, { e: { by: 'X' } }, metrc, { full: true });
const brief = (l) => [l.uid.slice(-1), l.kind, l.appLb, l.toLb, l.keys.join('+'), l.unmark.join('+')];
check('compare: group by UID, transit, marked rows brought back, only Metrc, only app',
  cmp.lines.map(brief), [['1', 'match', 10, 10, 'a+b', ''], ['2', 'transit', 4, 0, 'c', ''], ['5', 'only_metrc', 0, 1.5, 'e', 'e'], ['6', 'only_metrc', 0, 2.25, '', ''], ['4', 'only_app', 3, 0, 'd', '']]);
check('compare: rows without a UID are listed apart', cmp.noUid.map((r) => r.key), ['f']);
const short = A.compare([row('a', '1A4060300047D39000000001', 'flower', 6)], {}, [{ uid: '0001', qty: 5, unit: 'lb' }]);
check('compare: a count sheet with the last 4 of the tag', short.lines.map(brief), [['1', 'diff', 6, 5, 'a', '']]);

check('entry: set / add / bring back', [
  A.entryOf({ ...cmp.lines[1], reason: 'metrc_only' }), A.entryOf(cmp.lines[3]), A.entryOf(cmp.lines[2])
].map((e) => [e.kind, e.keys.join('+'), e.fromLb, e.toLb, e.delta, e.reason]),
[['set', 'c', 4, 0, -4, 'metrc_only'], ['add', '', 0, 2.25, 2.25, ''], ['set', 'e', 2, 1.5, -0.5, '']]);

// ── Applying saved adjustments (raw_stock.js) ──
const fresh = () => [row('a', 'AAAA0001', 'flower', 6), row('b', 'AAAA0001', 'flower', 4, '2026-10-05'), row('d', 'AAAA0004', 'trim', 3)];
const taker = (uid, lb, at) => ({ id: `t${at}`, uid, tab: 'flower', lb, at, date: at.slice(0, 10) });
const batch = (at, lines) => ({ id: `B${at}`, at, by: 'Robert', title: 'Count', lines });
const lbs = (out) => out.map((r) => `${r.key}:${r.lb}`).join(' ');

let out = fresh();
RawStock.applyAdjusted(out, [taker('AAAA0001', 3, '2026-10-10T10:00:00Z')], []);
check('no adjustments: same as before', lbs(out), 'a:3 b:4 d:3');

// Count on Nov 10: app said 7 (10 − 3 taken), Metrc 5 → −2, off the oldest.
out = fresh();
RawStock.applyAdjusted(out, [taker('AAAA0001', 3, '2026-10-10T10:00:00Z')],
  [batch('2026-11-10T12:00:00Z', [{ kind: 'set', keys: ['a', 'b'], delta: -2 }])]);
check('less than the forms: off the oldest first', lbs(out), 'a:1 b:4 d:3');

// A form for before the count, entered after it, still counts — and one
// dated before the count but submitted after it too.
out = fresh();
RawStock.applyAdjusted(out, [taker('AAAA0001', 3, '2026-10-10T10:00:00Z'), taker('AAAA0001', 1, '2026-11-12T09:00:00Z')],
  [batch('2026-11-10T12:00:00Z', [{ kind: 'set', keys: ['a', 'b'], delta: -2 }])]);
check('forms after the count take from the adjusted stock', lbs(out), 'a:0 b:4 d:3');

out = fresh();
RawStock.applyAdjusted(out, [], [batch('2026-11-10T12:00:00Z', [{ kind: 'set', keys: ['a', 'b'], delta: 1.5 }, { kind: 'set', keys: ['d'], delta: -3 }])]);
check('more than the forms: on the newest; to zero', lbs(out), 'a:6 b:5.5 d:0');

// An added package isn't eaten by a form from before the count that named its UID.
out = fresh();
RawStock.applyAdjusted(out, [{ ...taker('BBBB0009', 2, '2026-10-01T00:00:00Z'), tab: 'trim' }, { ...taker('BBBB0009', 0.5, '2026-11-11T00:00:00Z'), tab: 'trim' }],
  [batch('2026-11-10T12:00:00Z', [{ kind: 'add', uid: 'BBBB0009', tab: 'trim', strain: 'OG', toLb: 2.25 }])]);
check('added package: only later forms take from it', out.filter((r) => r.type === 'tAdj').map((r) => [r.key, r.uid, r.tab, r.lb, r.startLb]),
  [['adj:B2026-11-10T12:00:00Z:0', 'BBBB0009', 'trim', 1.75, 2.25]]);

out = fresh();
RawStock.applyAdjusted(out, [], [batch('2026-11-10T12:00:00Z', [{ kind: 'set', keys: ['d'], delta: -3, undone: { by: 'Robert' } }])]);
check('undone lines are ignored', lbs(out), 'a:6 b:4 d:3');
check('rows carry what adjusted them', (() => { const o = fresh(); RawStock.applyAdjusted(o, [], [batch('2026-11-10T12:00:00Z', [{ kind: 'set', keys: ['d'], delta: -1, reason: 'physical_count' }])]);
  return o[2].adj.map((x) => [x.delta, x.reason, x.by]); })(), [[-1, 'physical_count', 'Robert']]);

console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
