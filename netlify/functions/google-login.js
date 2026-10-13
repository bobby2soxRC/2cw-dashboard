// Google sign-in for the hub (index.html), alongside the PIN while everyone
// moves over — see "Google sign-in" in docs/USER_ADMIN.md.
//
// The browser signs in to Google through Supabase Auth and sends the access
// token here. This checks the token with Supabase (so a forged one gets
// nothing), finds the app_users row linked to that Google account
// (app_users.auth_user_id), and hands back that row's PIN. The hub then
// logs in exactly as if the PIN had been typed — every page and function
// that reads '2cw_pin' keeps working unchanged during the transition.
// Returning the PIN exposes nothing new: app_users is anon-readable today.
//
// POST {accessToken} -> {ok, pin}
//                    -> {ok:false, notLinked:true, email}  (signed in, no linked row)
//
// Required env vars (Netlify site config), same as admin.js:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !serviceKey) return json(500, { ok: false, error: 'Server missing Supabase configuration' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }
  const token = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
  if (!token) return json(401, { ok: false, error: 'Not signed in' });

  try {
    // Supabase checks the token's signature and expiry and returns its user.
    const authRes = await fetch(`${supaUrl}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${token}` }
    });
    if (authRes.status === 401 || authRes.status === 403) {
      return json(401, { ok: false, error: 'Google sign-in expired — try again.' });
    }
    if (!authRes.ok) throw new Error(`token check failed: ${authRes.status} ${await authRes.text()}`);
    const authUser = await authRes.json();
    if (!authUser || !UUID_RE.test(String(authUser.id || ''))) throw new Error('token check returned no user');

    const res = await fetch(
      `${supaUrl}/rest/v1/app_users?auth_user_id=eq.${authUser.id}&active=is.true&select=pin`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    if (!res.ok) throw new Error(`user lookup failed: ${res.status} ${await res.text()}`);
    const row = (await res.json())[0];
    if (!row) return json(200, { ok: false, notLinked: true, email: authUser.email || '' });
    return json(200, { ok: true, pin: String(row.pin) });
  } catch (err) {
    return json(502, { ok: false, error: String(err.message || err) });
  }
};
