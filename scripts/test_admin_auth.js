// Tests the auth boundary of netlify/functions/admin.js — the PIN login
// and signed-token verification — without needing a real Supabase project.
// Actions that reach Supabase (list/upsert/deactivate/reactivate/import)
// are gated behind the same token check, so once that check is proven to
// hold, they're only a network call away — not something this offline
// test can exercise. Run with: node scripts/test_admin_auth.js

process.env.ADMIN_PIN = '9999';
process.env.ADMIN_SIGNING_SECRET = 'test-secret-do-not-use-in-prod';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

const crypto = require('crypto');
const { handler } = require('../netlify/functions/admin.js');

let pass = 0, fail = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('  ok -', name);
    pass++;
  } catch (e) {
    console.log('  FAIL -', name, '-', e.message);
    fail++;
  }
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function call(body) {
  return handler({ httpMethod: 'POST', body: JSON.stringify(body) }).then(res => ({ ...res, json: JSON.parse(res.body) }));
}

(async () => {
  console.log('admin.js auth boundary');

  await check('rejects non-POST', async () => {
    const res = await handler({ httpMethod: 'GET' });
    assertEqual(res.statusCode, 405);
  });

  await check('rejects wrong admin PIN', async () => {
    const res = await call({ action: 'login', pin: '0000' });
    assertEqual(res.statusCode, 401);
    assertEqual(res.json.ok, false);
  });

  let token;
  await check('accepts correct admin PIN and issues a token', async () => {
    const res = await call({ action: 'login', pin: '9999' });
    assertEqual(res.statusCode, 200);
    assertEqual(res.json.ok, true);
    if (!res.json.token || typeof res.json.token !== 'string') throw new Error('no token returned');
    token = res.json.token;
  });

  await check('rejects a request with no token', async () => {
    const res = await call({ action: 'deactivate', id: 'x' });
    assertEqual(res.statusCode, 401);
  });

  await check('rejects a tampered token', async () => {
    const tampered = token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a');
    const res = await call({ action: 'deactivate', id: 'x', token: tampered });
    assertEqual(res.statusCode, 401);
  });

  await check('rejects an expired token even with a valid signature', async () => {
    const exp = Date.now() - 1000; // already expired
    const sig = crypto.createHmac('sha256', process.env.ADMIN_SIGNING_SECRET).update(String(exp)).digest('hex');
    const expiredToken = `${exp}.${sig}`;
    const res = await call({ action: 'deactivate', id: 'x', token: expiredToken });
    assertEqual(res.statusCode, 401);
  });

  await check('rejects an unknown action even with a valid token', async () => {
    const res = await call({ action: 'nonsense', token });
    assertEqual(res.statusCode, 400);
  });

  await check('rejects upsert with a non-numeric PIN', async () => {
    const res = await call({ action: 'upsert', token, user: { name: 'Test', pin: 'abcd', columns: {} } });
    assertEqual(res.statusCode, 400);
  });

  await check('rejects upsert missing name/pin', async () => {
    const res = await call({ action: 'upsert', token, user: { columns: {} } });
    assertEqual(res.statusCode, 400);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
