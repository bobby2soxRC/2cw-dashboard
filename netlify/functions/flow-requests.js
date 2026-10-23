// Change requests on the Material Flow page (material_flow.html; the
// flow_change_requests table in supabase/schema.sql). The table has no anon
// access at all — the log is only for people with the admin panel's
// Material Flow → Change requests ('material flow requests') or Manage
// ('material flow manage'), checked here against app_users from the PIN the
// person logged in with.
//
// POST {pin, action, ...} -> {ok, ...}
//   list                                   -> {rows, me: {name, manage}}
//   create  {target, targetTitle, original, proposed, note} -> {row}
//   comment {id, text}                     -> {row}
//   status  {id, status, implementation, note} -> {row}   (Manage only)
//     New requests are `pending` (waiting for approval). Only Manage moves
//     them on: approved (note optional) or declined (`implementation` holds
//     why — required); once approved, in_progress and implemented (needs
//     `implementation` — how it was done). Work starts only on approved
//     requests. Back to pending undoes an approval or decline. Each change is
//     appended to the row's log with who and when. ('open' is the old name
//     for pending.)
//
// Required env vars (Netlify site config), same as admin.js:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const REQUEST_COL = 'material flow requests';
const MANAGE_COL = 'material flow manage';
const STATUSES = new Set(['pending', 'approved', 'in_progress', 'implemented', 'declined']);
// Where each status may be set from.
const FROM = {
  pending: ['approved', 'declined'],
  approved: ['pending', 'open', 'declined', 'in_progress'],
  declined: ['pending', 'open', 'approved', 'in_progress'],
  in_progress: ['approved', 'implemented'],
  implemented: ['approved', 'in_progress']
};
const MAX_TEXT = 20000;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function supaFetch(supaUrl, serviceKey, path, opts = {}) {
  return fetch(`${supaUrl}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
}

// Hub login compares PINs zero-padded to 4 digits (index.html) — same
// lookup as metrc-queue.js.
async function userForPin(supaUrl, serviceKey, pin) {
  const pad = (p) => p.padStart(4, '0');
  const target = pad(pin);
  const variants = [...new Set([pin, target, target.replace(/^0+(?=.)/, '')])]
    .map((p) => `"${p.replace(/["\\]/g, '')}"`).join(',');
  const res = await supaFetch(supaUrl, serviceKey,
    `app_users?pin=in.(${encodeURIComponent(variants)})&active=is.true&select=name,pin,columns`);
  if (!res.ok) throw new Error(`user lookup failed: ${res.status} ${await res.text()}`);
  return (await res.json()).find((u) => pad(String(u.pin)) === target) || null;
}

const text = (x, max = MAX_TEXT) => (typeof x === 'string' ? x.replace(/\r\n/g, '\n').trim().slice(0, max) : '');

async function getRow(supaUrl, serviceKey, id) {
  const res = await supaFetch(supaUrl, serviceKey, `flow_change_requests?id=eq.${id}&select=*`);
  if (!res.ok) throw new Error(`lookup failed: ${res.status} ${await res.text()}`);
  return (await res.json())[0] || null;
}

async function patchRow(supaUrl, serviceKey, id, patch) {
  const res = await supaFetch(supaUrl, serviceKey, `flow_change_requests?id=eq.${id}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error(`save failed: ${res.status} ${await res.text()}`);
  return (await res.json())[0];
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !serviceKey) return json(500, { ok: false, error: 'Server missing Supabase configuration' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }
  const { pin, action } = body;
  if (typeof pin !== 'string' || !pin.trim()) return json(401, { ok: false, error: 'Not logged in' });

  try {
    const user = await userForPin(supaUrl, serviceKey, pin.trim());
    if (!user) return json(401, { ok: false, error: 'PIN not recognized — log in again.' });
    const cols = user.columns || {};
    const manage = String(cols[MANAGE_COL] || '').toUpperCase() === 'TRUE';
    const canRequest = manage || String(cols[REQUEST_COL] || '').toUpperCase() === 'TRUE';
    if (!canRequest) return json(403, { ok: false, error: 'You don’t have change request access to the Material Flow page.' });
    const now = new Date().toISOString();

    if (action === 'list') {
      const res = await supaFetch(supaUrl, serviceKey, 'flow_change_requests?select=*&order=created_at.desc&limit=2000');
      if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
      return json(200, { ok: true, rows: await res.json(), me: { name: user.name, manage } });
    }

    if (action === 'create') {
      const target = String(body.target || '');
      if (!/^[a-z0-9_-]{1,80}$/i.test(target)) return json(400, { ok: false, error: 'Unknown box' });
      const targetTitle = text(body.targetTitle, 200);
      const original = text(body.original);
      const proposed = text(body.proposed);
      const note = text(body.note, 4000);
      if (!targetTitle) return json(400, { ok: false, error: 'Missing box name' });
      if (proposed === original && !note) return json(400, { ok: false, error: 'Change the text or say what should change.' });
      const res = await supaFetch(supaUrl, serviceKey, 'flow_change_requests', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          target, target_title: targetTitle, original_text: original, proposed_text: proposed, note: note || null,
          status: 'pending', created_by: user.name, created_at: now, updated_by: user.name, updated_at: now,
          log: [{ status: 'pending', by: user.name, at: now }]
        })
      });
      if (!res.ok) throw new Error(`save failed: ${res.status} ${await res.text()}`);
      return json(200, { ok: true, row: (await res.json())[0] });
    }

    const id = String(body.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json(400, { ok: false, error: 'Invalid request id' });

    if (action === 'comment') {
      const msg = text(body.text, 4000);
      if (!msg) return json(400, { ok: false, error: 'Write a comment first.' });
      const cur = await getRow(supaUrl, serviceKey, id);
      if (!cur) return json(404, { ok: false, error: 'That change request is gone.' });
      const row = await patchRow(supaUrl, serviceKey, id, {
        comments: [...(cur.comments || []), { by: user.name, at: now, text: msg }]
      });
      return json(200, { ok: true, row });
    }

    if (action === 'status') {
      if (!manage) return json(403, { ok: false, error: 'Only people with Manage can change a request’s status.' });
      const status = String(body.status || '');
      if (!STATUSES.has(status)) return json(400, { ok: false, error: 'Unknown status' });
      const implementation = text(body.implementation, 8000);
      const note = text(body.note, 4000);
      if (status === 'implemented' && !implementation) return json(400, { ok: false, error: 'Say how it was implemented.' });
      if (status === 'declined' && !implementation) return json(400, { ok: false, error: 'Say why it’s declined.' });
      const cur = await getRow(supaUrl, serviceKey, id);
      if (!cur) return json(404, { ok: false, error: 'That change request is gone.' });
      if (status !== cur.status && !FROM[status].includes(cur.status)) {
        return json(409, { ok: false, error: (status === 'in_progress' || status === 'implemented')
          ? 'Approve the request first.' : `Can’t go from ${cur.status} to ${status}.` });
      }
      const keepText = status === 'implemented' || status === 'declined' || status === 'in_progress';
      const row = await patchRow(supaUrl, serviceKey, id, {
        status, implementation: keepText ? implementation || null : null, updated_by: user.name, updated_at: now,
        log: [...(cur.log || []), { status, ...(keepText && implementation ? { implementation } : {}), ...(note ? { note } : {}), by: user.name, at: now }]
      });
      return json(200, { ok: true, row });
    }

    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('flow-requests', err);
    return json(500, { ok: false, error: err.message });
  }
};
