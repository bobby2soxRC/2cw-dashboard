// Tests for netlify/functions/operations-records.js's delete_open (deleting an
// open Bucking page), against a fake Supabase. Run: node scripts/test_operations_records.js
process.env.SUPABASE_URL = 'https://fake'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
const users = [
  { name: 'Crew C', pin: '1111', columns: { 'production edit stations': 'buck,smalls_trim' } },
  { name: 'All A', pin: '2222', columns: { 'production edit stations': 'all' } },
  { name: 'Trim T', pin: '3333', columns: { 'production edit stations': 'hand_trim' } }
];
const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;
let rows, rpcCalls;
function reset() {
  rows = [{ id: ID(1), station_key: 'buck', status: 'draft' }, { id: ID(2), station_key: 'buck', status: 'submitted' }, { id: ID(3), station_key: 'smalls_trim', status: 'draft' }];
  rpcCalls = [];
}
global.fetch = async (url, opts = {}) => {
  const u = decodeURIComponent(url);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.includes('/app_users?')) { const pins = (u.match(/pin=in\.\(([^)]*)\)/) || [])[1] || ''; return ok(users.filter((x) => pins.includes(`"${x.pin}"`))); }
  if (u.includes('/operations_forms?id=eq.')) { const id = u.split('id=eq.')[1].split('&')[0]; return ok(rows.filter((r) => r.id === id).map(({ station_key, status }) => ({ station_key, status }))); }
  if (u.endsWith('/rpc/delete_operations_form')) { const b = JSON.parse(opts.body); rpcCalls.push(b); const i = rows.findIndex((r) => r.id === b.p_id); if (i > -1) rows.splice(i, 1); return ok(i > -1); }
  throw new Error('unexpected ' + u);
};
const { handler } = require('../netlify/functions/operations-records.js');
const call = async (body) => { const r = await handler({ httpMethod: 'POST', body: JSON.stringify(body) }); return { status: r.statusCode, ...JSON.parse(r.body) }; };
(async () => {
  let fails = 0;
  const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  got ${JSON.stringify(got)}`}`); };
  reset(); let r = await call({ action: 'delete_open', pin: '1111', stationKey: 'buck', id: ID(1) });
  check('crew deletes an open bucking page', [r.status, r.ok, rows.some((x) => x.id === ID(1))], [200, true, false]);
  check('…logged with their name', rpcCalls[0] && rpcCalls[0].p_actor, 'Crew C');
  reset(); r = await call({ action: 'delete_open', pin: '1111', stationKey: 'buck', id: ID(2) });
  check('a submitted page is refused', [r.status, r.code, rows.some((x) => x.id === ID(2)), rpcCalls.length], [409, 'submitted', true, 0]);
  reset(); r = await call({ action: 'delete_open', pin: '3333', stationKey: 'buck', id: ID(1) });
  check('someone without Bucking access is refused', [r.status, rows.some((x) => x.id === ID(1))], [403, true]);
  reset(); r = await call({ action: 'delete_open', pin: '2222', stationKey: 'buck', id: ID(1) });
  check('"all" stations access works', r.status, 200);
  reset(); r = await call({ action: 'delete_open', pin: '1111', stationKey: 'smalls_trim', id: ID(3) });
  check('a station not on the list is refused', [r.status, rows.some((x) => x.id === ID(3))], [400, true]);
  reset(); r = await call({ action: 'delete_open', pin: '1111', stationKey: 'buck', id: ID(3) });
  check('a page from another station is refused', [r.status, rows.some((x) => x.id === ID(3))], [403, true]);
  reset(); r = await call({ action: 'delete_open', pin: '1111', stationKey: 'buck', id: ID(9) });
  check('an already-gone page says gone', [r.status, r.code], [404, 'gone']);
  reset(); r = await call({ action: 'delete_open', pin: '9999', stationKey: 'buck', id: ID(1) });
  check('a bad PIN is refused', r.status, 401);
  reset(); r = await call({ action: 'delete', pin: '1111', stationKey: 'buck', id: ID(1), reason: 'x' });
  check('the old full delete still is not open to bucking', r.status, 400);
  console.log(fails ? `\n${fails} test(s) failed\n` : '\nAll tests passed\n');
  process.exit(fails ? 1 : 0);
})();
