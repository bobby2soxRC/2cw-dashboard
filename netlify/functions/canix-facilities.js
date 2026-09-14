// Canix facility nicknames — admin panel backend (admin.html's "Canix
// Facilities" tab).
//
// Same posture as admin.js/app_users: canix_facilities does not get an open
// anon-write RLS policy (see supabase/schema.sql), so every write goes
// through here using the Supabase *service role* key (server-side only) and
// the same admin PIN/token scheme as admin.js — intentionally reuses
// ADMIN_PIN / ADMIN_SIGNING_SECRET rather than adding a second secret, so a
// token issued by admin.html's login also works here and vice versa.
//
// Required env vars — identical set to admin.js, already configured in
// Netlify if user admin is working:
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

const STAGES = ['Cultivation', 'Processing', 'Manufacturing', 'Distribution'];

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
      const res = await supaFetch(supaUrl, serviceKey, 'canix_facilities?select=*&order=facility_id.asc');
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true, facilities: await res.json() });
    }

    if (action === 'update') {
      const f = payload.facility || {};
      const facilityId = f.facility_id;
      if (!facilityId) return json(400, { ok: false, error: 'Missing facility_id' });
      if (f.stage != null && f.stage !== '' && !STAGES.includes(f.stage)) {
        return json(400, { ok: false, error: `stage must be one of: ${STAGES.join(', ')}` });
      }
      const body = {
        display_name: f.display_name || null,
        stage: f.stage || null,
        farm_group: f.farm_group || null,
        exclude: !!f.exclude,
      };
      const res = await supaFetch(supaUrl, serviceKey, `canix_facilities?facility_id=eq.${encodeURIComponent(facilityId)}`, {
        method: 'PATCH', body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const rows = await res.json();
      if (!rows.length) return json(404, { ok: false, error: 'No facility with that id' });
      return json(200, { ok: true, facility: rows[0] });
    }

    return json(400, { ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    return json(502, { ok: false, error: String(err.message || err) });
  }
};
