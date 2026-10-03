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
const report = require('../lib/intake_drying_report');
const mail = require('../lib/report_mail');

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

// ── Reports tab (docs/REPORTS.md) ────────────────────────────────────────
const REPORT_KEY = 'intake_drying';
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_EDITOR = 'Admin panel';   // who the edit history shows for drying-room fixes made here

function reportRange(p) {
  const today = report.pacificDate();
  const from = YMD_RE.test(p.from || '') ? p.from : today;
  const to = YMD_RE.test(p.to || '') ? p.to : from;
  return from <= to ? { from, to } : { from: to, to: from };
}

// Drying-room fixes write onto the intake record itself, so they show in its
// edit history (operations_forms_history). Submitted intakes only — a draft
// is still open on someone's tablet and its autosave would undo the change.
async function patchIntakeFields(supaUrl, serviceKey, id, change) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return { error: 'Invalid intake id', status: 400 };
  const res = await supaFetch(supaUrl, serviceKey, `operations_forms?id=eq.${id}&station_key=eq.intake_wet&select=status,fields`);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const rec = (await res.json())[0];
  if (!rec) return { error: 'Intake not found', status: 404 };
  if (rec.status !== 'submitted') return { error: 'That intake is still being entered — finish and submit it first.', status: 409 };
  const fields = { ...(rec.fields || {}), ...change, lastEditedBy: REPORT_EDITOR, lastEditedAt: new Date().toISOString() };
  for (const k of Object.keys(change)) if (change[k] === null) delete fields[k];
  const upd = await supaFetch(supaUrl, serviceKey, `operations_forms?id=eq.${id}&status=eq.submitted`, {
    method: 'PATCH', body: JSON.stringify({ fields, updated_by: REPORT_EDITOR })
  });
  if (!upd.ok) throw new Error(`${upd.status} ${await upd.text()}`);
  return { ok: true };
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

    if (action === 'reportInfo') {
      const [recipients, runs] = await Promise.all([
        mail.listRecipients(supaUrl, serviceKey, REPORT_KEY),
        mail.listRuns(supaUrl, serviceKey, REPORT_KEY, 10)
      ]);
      return json(200, { ok: true, recipients, runs, mailerConfigured: mail.mailerConfigured(), today: report.pacificDate() });
    }

    if (action === 'addRecipient') {
      const email = String(payload.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return json(400, { ok: false, error: 'That email address doesn\'t look right' });
      const res = await supaFetch(supaUrl, serviceKey, 'report_recipients', {
        method: 'POST', body: JSON.stringify({ report_key: REPORT_KEY, email, name: String(payload.name || '').trim() || null })
      });
      if (!res.ok) {
        const text = await res.text();
        if (text.includes('23505')) return json(409, { ok: false, error: 'That address is already on the list' });
        throw new Error(`${res.status} ${text}`);
      }
      return json(200, { ok: true, recipient: (await res.json())[0] });
    }

    if (action === 'removeRecipient') {
      if (!payload.id) return json(400, { ok: false, error: 'Missing id' });
      const res = await supaFetch(supaUrl, serviceKey, `report_recipients?id=eq.${encodeURIComponent(payload.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true });
    }

    if (action === 'previewReport') {
      const { from, to } = reportRange(payload);
      const rep = await report.intakeDryingReport(supaUrl, serviceKey, { from, to });
      return json(200, { ok: true, subject: report.subjectLine(rep), html: report.renderHtml(rep, { siteUrl: process.env.URL }) });
    }

    if (action === 'sendReport') {
      const { from, to } = reportRange(payload);
      const onlyTo = payload.onlyTo ? String(payload.onlyTo).trim().toLowerCase() : null;
      if (onlyTo && !EMAIL_RE.test(onlyTo)) return json(400, { ok: false, error: 'That email address doesn\'t look right' });
      const result = await mail.runIntakeDryingReport({ supaUrl, serviceKey, from, to, trigger: 'manual', onlyTo });
      if (result.status === 'failed') return json(502, { ok: false, error: result.detail });
      return json(200, { ok: true, ...result });
    }

    // What's in each drying room now, plus intakes marked taken down here in
    // the last 30 days (so a mistake can be put back).
    if (action === 'dryingRooms') {
      const data = await report.fetchData(supaUrl, serviceKey);
      const today = report.pacificDate();
      const rep = report.buildReport({ ...data, from: today, to: today, today });
      const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
      const markedOut = data.intakes.filter((r) => (r.fields || {}).takenDownAt && r.fields.takenDownAt >= cutoff).map((r) => ({
        id: r.id, since: r.work_date, room: r.fields.dryRoom || '', pid: r.fields.pid || '',
        uids: [...new Set([r.fields.sourceUid, ...(r.fields.lines || []).map((x) => x.sourceUid)].filter(Boolean))].join(', '),
        strain: r.fields.strain || '', takenDownAt: r.fields.takenDownAt, note: r.fields.takenDownNote || ''
      }));
      return json(200, { ok: true, drying: rep.drying, markedOut });
    }

    if (action === 'markTakenDown') {
      const note = String(payload.note || '').trim().slice(0, 300);
      if (!note) return json(400, { ok: false, error: 'Add a short note (e.g. "taken down 10/3, form missed")' });
      const r = await patchIntakeFields(supaUrl, serviceKey, payload.id, { takenDownAt: new Date().toISOString(), takenDownNote: note });
      return r.error ? json(r.status, { ok: false, error: r.error }) : json(200, { ok: true });
    }

    if (action === 'undoTakenDown') {
      const r = await patchIntakeFields(supaUrl, serviceKey, payload.id, { takenDownAt: null, takenDownNote: null });
      return r.error ? json(r.status, { ok: false, error: r.error }) : json(200, { ok: true });
    }

    if (action === 'moveRoom') {
      const room = String(payload.room || '').trim();
      if (!room) return json(400, { ok: false, error: 'Pick a room' });
      const r = await patchIntakeFields(supaUrl, serviceKey, payload.id, { dryRoom: room });
      return r.error ? json(r.status, { ok: false, error: r.error }) : json(200, { ok: true });
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
