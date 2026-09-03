// User-management admin panel backend (admin.html).
//
// This table (app_users) gates access to commissions and executive data, so
// unlike production_forms it does NOT get an open anon-write RLS policy —
// every write goes through here, using the Supabase *service role* key
// (server-side only, never shipped to the browser) and gated by a separate
// admin PIN. This is an explicit stopgap, not real SSO: anyone who has the
// admin PIN can manage every user's access. Documented as such in
// docs/USER_ADMIN.md.
//
// Auth flow: POST {action:'login', pin} -> {ok:true, token}. Every other
// action requires that token in the body. Tokens are signed with HMAC
// (Node's built-in crypto, no new dependency) and expire after a few hours
// — there's no session store, the token itself carries its expiry and a
// signature proving it was issued by this server.
//
// Required env vars (Netlify site config), none shared with the browser:
//   ADMIN_PIN                 the admin PIN checked on login
//   ADMIN_SIGNING_SECRET      random string used to sign/verify tokens
//   SUPABASE_URL              same project URL as config/supabase_config.js
//   SUPABASE_SERVICE_ROLE_KEY service_role key (Project Settings -> API)

const crypto = require('crypto');

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function sign(secret, str) {
  return crypto.createHmac('sha256', secret).update(str).digest('hex');
}

function issueToken(secret) {
  const exp = Date.now() + TOKEN_TTL_MS;
  return `${exp}.${sign(secret, String(exp))}`;
}

function verifyToken(secret, token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = sign(secret, expStr);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function supaFetch(supaUrl, serviceKey, path, opts = {}) {
  return fetch(`${supaUrl}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {})
    }
  });
}

async function importRows(supaUrl, serviceKey, rows) {
  const results = [];
  for (const row of rows) {
    const name = String(row.user || '').trim();
    const pin = String(row.pin || '').trim();
    if (!name || !pin) { results.push({ name: name || '(blank)', ok: false, error: 'missing name or pin' }); continue; }
    try {
      const getRes = await supaFetch(supaUrl, serviceKey, `app_users?name=ilike.${encodeURIComponent(name)}&select=id`);
      if (!getRes.ok) throw new Error(`lookup failed: ${getRes.status}`);
      const existing = await getRes.json();
      if (existing.length) {
        const patchRes = await supaFetch(supaUrl, serviceKey, `app_users?id=eq.${existing[0].id}`, {
          method: 'PATCH',
          body: JSON.stringify({ pin, active: true, columns: row })
        });
        if (!patchRes.ok) throw new Error(`update failed: ${patchRes.status} ${await patchRes.text()}`);
        results.push({ name, ok: true, action: 'updated' });
      } else {
        const postRes = await supaFetch(supaUrl, serviceKey, 'app_users', {
          method: 'POST',
          body: JSON.stringify({ name, pin, active: true, columns: row })
        });
        if (!postRes.ok) throw new Error(`create failed: ${postRes.status} ${await postRes.text()}`);
        results.push({ name, ok: true, action: 'created' });
      }
    } catch (err) {
      results.push({ name, ok: false, error: String(err.message || err) });
    }
  }
  return results;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  const adminPin = process.env.ADMIN_PIN;
  const signingSecret = process.env.ADMIN_SIGNING_SECRET;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!adminPin || !signingSecret || !supaUrl || !serviceKey) {
    return json(500, { ok: false, error: 'Server missing ADMIN_PIN / ADMIN_SIGNING_SECRET / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const { action } = payload;

  if (action === 'login') {
    if (String(payload.pin || '') !== String(adminPin)) {
      return json(401, { ok: false, error: 'Incorrect admin PIN' });
    }
    return json(200, { ok: true, token: issueToken(signingSecret) });
  }

  if (!verifyToken(signingSecret, payload.token)) {
    return json(401, { ok: false, error: 'Session expired — please sign in again' });
  }

  try {
    if (action === 'list') {
      const res = await supaFetch(supaUrl, serviceKey, 'app_users?select=*&order=name.asc');
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true, users: await res.json() });
    }

    if (action === 'upsert') {
      const u = payload.user || {};
      const name = String(u.name || '').trim();
      const pin = String(u.pin || '').trim();
      if (!name || !pin) return json(400, { ok: false, error: 'Name and PIN are required' });
      if (!/^\d{4,}$/.test(pin)) return json(400, { ok: false, error: 'PIN must be numeric' });
      const body = { name, pin, active: u.active !== false, columns: u.columns || {} };
      if (u.id) {
        const res = await supaFetch(supaUrl, serviceKey, `app_users?id=eq.${encodeURIComponent(u.id)}`, {
          method: 'PATCH', body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        return json(200, { ok: true, user: (await res.json())[0] });
      }
      const res = await supaFetch(supaUrl, serviceKey, 'app_users', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true, user: (await res.json())[0] });
    }

    if (action === 'deactivate') {
      if (!payload.id) return json(400, { ok: false, error: 'Missing id' });
      const res = await supaFetch(supaUrl, serviceKey, `app_users?id=eq.${encodeURIComponent(payload.id)}`, {
        method: 'PATCH', body: JSON.stringify({ active: false })
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true });
    }

    if (action === 'reactivate') {
      if (!payload.id) return json(400, { ok: false, error: 'Missing id' });
      const res = await supaFetch(supaUrl, serviceKey, `app_users?id=eq.${encodeURIComponent(payload.id)}`, {
        method: 'PATCH', body: JSON.stringify({ active: true })
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true });
    }

    if (action === 'import') {
      if (!Array.isArray(payload.rows)) return json(400, { ok: false, error: 'Missing rows array' });
      const results = await importRows(supaUrl, serviceKey, payload.rows);
      return json(200, { ok: true, results });
    }

    return json(400, { ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    return json(502, { ok: false, error: String(err.message || err) });
  }
};
