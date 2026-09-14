// Canix yield forecasting — admin panel backend (admin.html's "Yield
// Forecast" tab): estimated lbs/plant per farm and planned harvest dates.
//
// Same posture as admin.js/canix-facilities.js: canix_yield_estimates and
// canix_harvest_plans do not get an open anon-write RLS policy (see
// supabase/schema.sql), so every write goes through here using the
// Supabase *service role* key and the same admin PIN/token scheme as the
// other two functions — intentionally reuses ADMIN_PIN / ADMIN_SIGNING_SECRET
// rather than adding a third secret, so one admin login covers all three
// panel tabs.
//
// Required env vars — identical set to admin.js / canix-facilities.js:
//   ADMIN_PIN                 the admin PIN checked on login
//   ADMIN_SIGNING_SECRET      random string used to sign/verify tokens
//   SUPABASE_URL              same project URL as config/supabase_config.js
//   SUPABASE_SERVICE_ROLE_KEY service_role key (Project Settings -> API)

const crypto = require('crypto');

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function sign(secret, str) {
  return crypto.createHmac('sha256', secret).update(str).digest('hex');
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

const PLAN_STATUSES = ['planned', 'completed', 'canceled'];

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

  // No separate login here — a token from admin.js's or canix-facilities.js's
  // login already verifies, since all three share the same signing secret.
  if (!verifyToken(signingSecret, payload.token)) {
    return json(401, { ok: false, error: 'Session expired — please sign in again' });
  }

  try {
    if (action === 'list_estimates') {
      const res = await supaFetch(supaUrl, serviceKey, 'canix_yield_estimates?select=*&order=farm_group.asc,effective_date.desc');
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true, estimates: await res.json() });
    }

    if (action === 'add_estimate') {
      const e = payload.estimate || {};
      const farmGroup = String(e.farm_group || '').trim();
      const lbs = Number(e.estimated_lbs_per_plant);
      if (!farmGroup) return json(400, { ok: false, error: 'farm_group is required' });
      if (!Number.isFinite(lbs) || lbs <= 0) return json(400, { ok: false, error: 'estimated_lbs_per_plant must be a positive number' });
      const body = {
        farm_group: farmGroup,
        estimated_lbs_per_plant: lbs,
        effective_date: e.effective_date || new Date().toISOString().slice(0, 10),
        notes: e.notes || null,
      };
      const res = await supaFetch(supaUrl, serviceKey, 'canix_yield_estimates', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true, estimate: (await res.json())[0] });
    }

    if (action === 'delete_estimate') {
      if (!payload.id) return json(400, { ok: false, error: 'Missing id' });
      const res = await supaFetch(supaUrl, serviceKey, `canix_yield_estimates?id=eq.${encodeURIComponent(payload.id)}`, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' }
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true });
    }

    if (action === 'list_harvest_plans') {
      const res = await supaFetch(supaUrl, serviceKey, 'canix_harvest_plans?select=*&order=planned_harvest_date.asc');
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true, plans: await res.json() });
    }

    if (action === 'upsert_harvest_plan') {
      const p = payload.plan || {};
      const farmGroup = String(p.farm_group || '').trim();
      const date = p.planned_harvest_date;
      if (!farmGroup) return json(400, { ok: false, error: 'farm_group is required' });
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { ok: false, error: 'planned_harvest_date must be YYYY-MM-DD' });
      const status = p.status || 'planned';
      if (!PLAN_STATUSES.includes(status)) return json(400, { ok: false, error: `status must be one of: ${PLAN_STATUSES.join(', ')}` });
      const body = {
        farm_group: farmGroup,
        planned_harvest_date: date,
        plant_count_override: p.plant_count_override === '' || p.plant_count_override == null ? null : Number(p.plant_count_override),
        status,
        notes: p.notes || null,
      };
      if (p.id) {
        const res = await supaFetch(supaUrl, serviceKey, `canix_harvest_plans?id=eq.${encodeURIComponent(p.id)}`, {
          method: 'PATCH', body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        return json(200, { ok: true, plan: (await res.json())[0] });
      }
      const res = await supaFetch(supaUrl, serviceKey, 'canix_harvest_plans', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true, plan: (await res.json())[0] });
    }

    if (action === 'delete_harvest_plan') {
      if (!payload.id) return json(400, { ok: false, error: 'Missing id' });
      const res = await supaFetch(supaUrl, serviceKey, `canix_harvest_plans?id=eq.${encodeURIComponent(payload.id)}`, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' }
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true });
    }

    return json(400, { ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    return json(502, { ok: false, error: String(err.message || err) });
  }
};
