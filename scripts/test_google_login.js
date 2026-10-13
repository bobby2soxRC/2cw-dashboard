// Tests netlify/functions/google-login.js with Supabase faked out: a token
// Supabase rejects gets nothing, a valid token with no linked row is told
// so, and a linked one gets that row's PIN. Run with:
//   node scripts/test_google_login.js

process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

const { handler } = require('../netlify/functions/google-login.js');

const USER_ID = '11111111-2222-3333-4444-555555555555';
let linkedRows = [];
global.fetch = async (url, opts) => {
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (url.endsWith('/auth/v1/user')) {
    return opts.headers.Authorization === 'Bearer good-token'
      ? reply(200, { id: USER_ID, email: 'someone@example.com' })
      : reply(401, { msg: 'invalid JWT' });
  }
  if (url.includes('/rest/v1/app_users?')) {
    if (opts.headers.Authorization !== 'Bearer test-service-key') return reply(401, {});
    if (!url.includes(`auth_user_id=eq.${USER_ID}`) || !url.includes('active=is.true')) return reply(400, {});
    return reply(200, linkedRows);
  }
  throw new Error('unexpected fetch ' + url);
};

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok -', name); pass++; }
  catch (e) { console.log('  FAIL -', name, '-', e.message); fail++; }
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const call = (body) => handler({ httpMethod: 'POST', body: JSON.stringify(body) })
  .then(res => ({ ...res, json: JSON.parse(res.body) }));

(async () => {
  console.log('google-login.js');
  await check('rejects non-POST', async () => assertEqual((await handler({ httpMethod: 'GET' })).statusCode, 405));
  await check('rejects a missing token', async () => assertEqual((await call({})).statusCode, 401));
  await check('rejects a token Supabase does not accept', async () => {
    const res = await call({ accessToken: 'forged' });
    assertEqual(res.statusCode, 401);
    assertEqual(res.json.pin, undefined, 'no PIN for a bad token');
  });
  await check('valid token, no linked user → notLinked', async () => {
    linkedRows = [];
    const res = await call({ accessToken: 'good-token' });
    assertEqual(res.json.ok, false);
    assertEqual(res.json.notLinked, true);
    assertEqual(res.json.email, 'someone@example.com');
  });
  await check('valid token, linked user → their PIN', async () => {
    linkedRows = [{ pin: '0420' }];
    const res = await call({ accessToken: 'good-token' });
    assertEqual(res.json.ok, true);
    assertEqual(res.json.pin, '0420');
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
