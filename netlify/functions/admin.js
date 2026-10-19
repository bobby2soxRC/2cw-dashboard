// User-management admin panel backend (admin.html).
//
// This table (app_users) gates access to commissions and executive data, so
// unlike operations_forms it does NOT get an open anon-write RLS policy —
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
const { badgeKey } = require('../../ops_analytics.js');

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

// Walks the reports_to chain starting at `startId` and returns true if it
// ever reaches `targetId` — used to reject an org-chart edit that would
// make someone their own (possibly indirect) manager. Fetches the whole
// id/reports_to graph in one call rather than N+1 lookups; app_users is
// small (staff directory size), so this stays cheap.
async function chainReaches(supaUrl, serviceKey, startId, targetId) {
  const res = await supaFetch(supaUrl, serviceKey, 'app_users?select=id,reports_to');
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const byId = new Map((await res.json()).map(u => [u.id, u.reports_to]));
  let cur = startId;
  const seen = new Set();
  while (cur) {
    if (cur === targetId) return true;
    if (seen.has(cur)) break; // pre-existing cycle in the data — stop rather than loop forever
    seen.add(cur);
    cur = byId.get(cur) || null;
  }
  return false;
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
      const reportsTo = u.reports_to || null;
      if (reportsTo && u.id) {
        if (reportsTo === u.id) return json(400, { ok: false, error: 'Someone cannot report to themselves' });
        // Reject if the proposed manager's own chain leads back to this
        // user — that would make this user (indirectly) their own manager.
        if (await chainReaches(supaUrl, serviceKey, reportsTo, u.id)) {
          return json(400, { ok: false, error: 'That would create a reporting loop — pick a manager who isn\'t already below this person on the chart' });
        }
      }
      const email = String(u.email || '').trim().toLowerCase();
      if (email && !EMAIL_RE.test(email)) return json(400, { ok: false, error: 'That email address doesn\'t look right' });
      const body = {
        name, pin, active: u.active !== false, columns: u.columns || {},
        last_name: String(u.last_name || '').trim() || null,
        email: email || null,
        phone: String(u.phone || '').trim() || null,
        title: (u.title || '').trim() || null,
        reports_to: reportsTo
      };
      const res = u.id
        ? await supaFetch(supaUrl, serviceKey, `app_users?id=eq.${encodeURIComponent(u.id)}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await supaFetch(supaUrl, serviceKey, 'app_users', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) {
        const text = await res.text();
        // 23505 = unique violation on one of the "where active" indexes.
        if (text.includes('23505') && text.includes('email')) return json(409, { ok: false, error: 'Another active user already has that email address' });
        if (text.includes('23505') && text.includes('pin')) return json(409, { ok: false, error: 'Another active user already has that PIN' });
        throw new Error(`${res.status} ${text}`);
      }
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

    // Labor rates (labor_rates table — pay, so service role only; see
    // supabase/schema.sql). Each row is one person's $/hr from a date on.
    // Badge numbers (employee_badges) come along; badges is null until that
    // table has been created, so the tab still loads without it.
    if (action === 'labor_rates_list') {
      const [res, bRes, pRes] = await Promise.all([
        supaFetch(supaUrl, serviceKey, 'labor_rates?select=*&order=employee_id.asc,effective_from.desc'),
        supaFetch(supaUrl, serviceKey, 'employee_badges?select=badge_no,employee_id&order=badge_no.asc'),
        supaFetch(supaUrl, serviceKey, 'labor_people?select=*&order=name.asc')
      ]);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true, rates: await res.json(), badges: bRes.ok ? await bRes.json() : null,
        people: pRes.ok ? await pRes.json() : null });
    }

    // People paid by the hour who aren't in Connecteam (labor_people). Their
    // employee id is 'X' + id. Add: {name, phone} -> {person}; update:
    // {id, name?, phone?, active?}. Never deleted, so old entries keep a name.
    if (action === 'labor_people_add' || action === 'labor_people_update') {
      const row = {};
      if (payload.name !== undefined) {
        row.name = String(payload.name || '').trim().slice(0, 200);
        if (!row.name) return json(400, { ok: false, error: 'Enter a name' });
      }
      if (payload.phone !== undefined) row.phone = String(payload.phone || '').trim().slice(0, 40) || null;
      if (payload.active !== undefined) row.active = !!payload.active;
      let res;
      if (action === 'labor_people_add') {
        if (!row.name) return json(400, { ok: false, error: 'Enter a name' });
        res = await supaFetch(supaUrl, serviceKey, 'labor_people', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(row) });
      } else {
        if (!/^\d+$/.test(String(payload.id || ''))) return json(400, { ok: false, error: 'Missing id' });
        res = await supaFetch(supaUrl, serviceKey, `labor_people?id=eq.${payload.id}`, { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(row) });
      }
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const person = (await res.json())[0];
      if (!person) return json(404, { ok: false, error: 'Person not found' });
      // Keep the name on their badges and rates in step with a rename.
      if (row.name && action === 'labor_people_update') {
        const empQ = encodeURIComponent('X' + person.id);
        for (const table of ['employee_badges', 'labor_rates']) {
          const r = await supaFetch(supaUrl, serviceKey, `${table}?employee_id=eq.${empQ}`, { method: 'PATCH', body: JSON.stringify({ employee_name: row.name }) });
          if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
        }
      }
      return json(200, { ok: true, person });
    }

    // A person's badge numbers (station forms' Employee ID), replacing
    // whatever they had: badges "6, 76" -> two rows. A badge already on
    // someone else is refused rather than moved.
    if (action === 'labor_badges_set') {
      const employeeId = String(payload.employeeId || '').trim();
      if (!employeeId || employeeId === '*' || employeeId.length > 64) return json(400, { ok: false, error: 'Missing employee' });
      const badges = [...new Set(String(payload.badges || '').split(/[\s,;]+/).map(badgeKey).filter(Boolean))];
      if (badges.some((b) => b.length > 20 || /[(),"\\]/.test(b))) return json(400, { ok: false, error: 'Badge numbers are up to 20 characters, separated by commas' });
      const empQ = encodeURIComponent(employeeId);
      if (badges.length) {
        const inList = encodeURIComponent(badges.map((b) => `"${b}"`).join(','));
        const res = await supaFetch(supaUrl, serviceKey, `employee_badges?badge_no=in.(${inList})&employee_id=neq.${empQ}&select=badge_no,employee_name,employee_id`);
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        const taken = await res.json();
        if (taken.length) {
          return json(409, { ok: false, error: taken.map((t) => `Badge ${t.badge_no} is already ${t.employee_name || t.employee_id}'s`).join('; ') + ' — clear it there first.' });
        }
      }
      const del = await supaFetch(supaUrl, serviceKey, `employee_badges?employee_id=eq.${empQ}`, { method: 'DELETE' });
      if (!del.ok) throw new Error(`${del.status} ${await del.text()}`);
      if (badges.length) {
        const name = String(payload.employeeName || '').trim().slice(0, 200) || null;
        const res = await supaFetch(supaUrl, serviceKey, 'employee_badges', {
          method: 'POST',
          body: JSON.stringify(badges.map((b) => ({ badge_no: b, employee_id: employeeId, employee_name: name, updated_by: 'admin panel' })))
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      }
      return json(200, { ok: true, badges });
    }

    if (action === 'labor_rates_set') {
      const employeeId = String(payload.employeeId || '').trim();
      const rate = Number(payload.rate);
      const from = String(payload.effectiveFrom || '2000-01-01');
      if (!employeeId || employeeId.length > 64) return json(400, { ok: false, error: 'Missing employee' });
      if (!Number.isFinite(rate) || rate < 0 || rate > 1000) return json(400, { ok: false, error: 'Rate must be a number between 0 and 1000' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return json(400, { ok: false, error: 'Effective date must be YYYY-MM-DD' });
      const res = await supaFetch(supaUrl, serviceKey, 'labor_rates?on_conflict=employee_id,effective_from', {
        method: 'POST',
        prefer: 'return=representation,resolution=merge-duplicates',
        body: JSON.stringify({
          employee_id: employeeId, employee_name: String(payload.employeeName || '').trim().slice(0, 200) || null,
          rate: Math.round(rate * 100) / 100, effective_from: from, created_by: 'admin panel'
        })
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true, rate: (await res.json())[0] });
    }

    if (action === 'labor_rates_delete') {
      if (!/^\d+$/.test(String(payload.id || ''))) return json(400, { ok: false, error: 'Missing id' });
      const res = await supaFetch(supaUrl, serviceKey, `labor_rates?id=eq.${payload.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true });
    }

    // Drivers and Trucks tab. Drivers (drivers table) are added here or from
    // the Harvest form (drivers.js); trucks (trucks table) only here. The
    // list leaves the ID photos out; driver_photo fetches one. Either list is
    // null until its table has been created.
    if (action === 'drivers_list') {
      const missing = (status, text) => status === 404 || text.includes('42P01') || text.includes('PGRST205');
      const [dRes, tRes] = await Promise.all([
        supaFetch(supaUrl, serviceKey, 'drivers?select=id,first_name,last_name,id_number,active,created_by,created_at&order=first_name.asc,last_name.asc'),
        supaFetch(supaUrl, serviceKey, 'trucks?select=*&order=plate.asc')
      ]);
      const read = async (res) => {
        if (res.ok) return res.json();
        const text = await res.text();
        if (missing(res.status, text)) return null;
        throw new Error(`${res.status} ${text}`);
      };
      const drivers = await read(dRes);
      // Which drivers have no ID photo yet (added without one, e.g. typed in
      // from a list) — asked separately so the list doesn't carry photos.
      if (drivers && drivers.length) {
        const nRes = await supaFetch(supaUrl, serviceKey, 'drivers?id_photo=is.null&select=id');
        const none = new Set(nRes.ok ? (await nRes.json()).map((d) => d.id) : []);
        drivers.forEach((d) => { d.has_photo = !none.has(d.id); });
      }
      return json(200, { ok: true, drivers, trucks: await read(tRes) });
    }

    // A driver's ID photo, added or replaced (a renewed license).
    if (action === 'driver_photo_set') {
      if (!/^\d+$/.test(String(payload.id || ''))) return json(400, { ok: false, error: 'Missing id' });
      const photo = typeof payload.photo === 'string' ? payload.photo : '';
      if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) return json(400, { ok: false, error: 'Pick a photo of the ID' });
      if (photo.length > 3_000_000) return json(400, { ok: false, error: 'That photo is too large' });
      const res = await supaFetch(supaUrl, serviceKey, `drivers?id=eq.${payload.id}`, { method: 'PATCH', body: JSON.stringify({ id_photo: photo }) });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true });
    }

    if (action === 'driver_add') {
      const clean = (s, n) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, n);
      const first = clean(payload.first, 100), last = clean(payload.last, 100);
      const idNumber = clean(payload.idNumber, 40).toUpperCase();
      const photo = typeof payload.photo === 'string' ? payload.photo : '';
      if (!first || !last || !idNumber) return json(400, { ok: false, error: 'First name, last name and ID number are required' });
      if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) return json(400, { ok: false, error: 'A photo of the ID is required' });
      if (photo.length > 3_000_000) return json(400, { ok: false, error: 'That photo is too large' });
      const res = await supaFetch(supaUrl, serviceKey, 'drivers', {
        method: 'POST', body: JSON.stringify({ first_name: first, last_name: last, id_number: idNumber, id_photo: photo, created_by: 'admin panel' })
      });
      if (!res.ok) {
        const text = await res.text();
        if (text.includes('23505')) return json(409, { ok: false, error: 'A driver with that ID number is already on the list' });
        throw new Error(`${res.status} ${text}`);
      }
      return json(200, { ok: true });
    }

    // Trucks: {plate, truckNo?, description?} -> add; {id, …, active?} -> update.
    if (action === 'truck_add' || action === 'truck_update') {
      const clean = (s, n) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, n);
      const row = {};
      if (payload.plate !== undefined) {
        row.plate = clean(payload.plate, 20).toUpperCase();
        if (!row.plate) return json(400, { ok: false, error: 'Enter the license plate' });
      }
      if (payload.truckNo !== undefined) row.truck_no = clean(payload.truckNo, 40) || null;
      if (payload.description !== undefined) row.description = clean(payload.description, 200) || null;
      if (payload.active !== undefined) row.active = !!payload.active;
      let res;
      if (action === 'truck_add') {
        if (!row.plate) return json(400, { ok: false, error: 'Enter the license plate' });
        res = await supaFetch(supaUrl, serviceKey, 'trucks', { method: 'POST', body: JSON.stringify(row) });
      } else {
        if (!/^\d+$/.test(String(payload.id || ''))) return json(400, { ok: false, error: 'Missing id' });
        res = await supaFetch(supaUrl, serviceKey, `trucks?id=eq.${payload.id}`, { method: 'PATCH', body: JSON.stringify(row) });
      }
      if (!res.ok) {
        const text = await res.text();
        if (text.includes('23505')) return json(409, { ok: false, error: 'That plate is already on the list' });
        throw new Error(`${res.status} ${text}`);
      }
      return json(200, { ok: true });
    }

    if (action === 'driver_photo') {
      if (!/^\d+$/.test(String(payload.id || ''))) return json(400, { ok: false, error: 'Missing id' });
      const res = await supaFetch(supaUrl, serviceKey, `drivers?id=eq.${payload.id}&select=id_photo`);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const row = (await res.json())[0];
      if (!row) return json(404, { ok: false, error: 'Driver not found' });
      return json(200, { ok: true, photo: row.id_photo || null });
    }

    if (action === 'driver_update') {
      if (!/^\d+$/.test(String(payload.id || ''))) return json(400, { ok: false, error: 'Missing id' });
      const row = {};
      const clean = (s, n) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, n);
      if (payload.first !== undefined) { row.first_name = clean(payload.first, 100); if (!row.first_name) return json(400, { ok: false, error: 'First name can’t be blank' }); }
      if (payload.last !== undefined) { row.last_name = clean(payload.last, 100); if (!row.last_name) return json(400, { ok: false, error: 'Last name can’t be blank' }); }
      if (payload.idNumber !== undefined) { row.id_number = clean(payload.idNumber, 40).toUpperCase(); if (!row.id_number) return json(400, { ok: false, error: 'ID number can’t be blank' }); }
      if (payload.active !== undefined) row.active = !!payload.active;
      const res = await supaFetch(supaUrl, serviceKey, `drivers?id=eq.${payload.id}`, { method: 'PATCH', body: JSON.stringify(row) });
      if (!res.ok) {
        const text = await res.text();
        if (text.includes('23505')) return json(409, { ok: false, error: 'Another driver already has that ID number' });
        throw new Error(`${res.status} ${text}`);
      }
      return json(200, { ok: true });
    }

    return json(400, { ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    return json(502, { ok: false, error: String(err.message || err) });
  }
};
