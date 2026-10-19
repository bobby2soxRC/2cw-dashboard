// Sets where a submitted station form stands in the Metrc queue
// (metrc.html; the metrc_queue table in supabase/schema.sql). Reading the
// queue goes through the anon key; changing it needs the admin panel's
// Metrc Queue → Edit ('metrc queue edit'), checked here against app_users
// from the PIN the person logged in with.
//
// POST {pin, id, status, note, tags} -> {ok, row, fields}
//   status: todo | in_progress | done | not_needed. note is optional and
//   replaces the current note (blank clears it). tags is optional:
//   {field: uid} for the station's `metrcTags` (operations_stations.js — the
//   new Metrc package tag on each output, e.g. Hand Trim's finished flower,
//   smalls, trim); they're written onto the form record itself (blank clears
//   one), and `fields` comes back. Each change is appended to the row's log
//   with who and when, tags included.
//
// Required env vars (Netlify site config), same as admin.js:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const EDIT_COL = 'metrc queue edit';
const STATUSES = new Set(['todo', 'in_progress', 'done', 'not_needed']);
// The station forms that feed the queue — keep in step with METRC_STATIONS
// in metrc.html.
const METRC_STATIONS = new Set(['intake_wet', 'dry_check', 'buck', 'hand_trim', 'preroll_production']);
const { STATION_BY_KEY } = require('../../operations_stations.js');
// Metrc package tags: letters and digits only, spaces dropped, upper case.
const normTag = (u) => String(u == null ? '' : u).toUpperCase().replace(/\s/g, '');

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
// lookup as operations-records.js.
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !serviceKey) return json(500, { ok: false, error: 'Server missing Supabase configuration' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }
  const { pin, id, status } = body;
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : null;
  if (typeof pin !== 'string' || !pin.trim()) return json(401, { ok: false, error: 'Not logged in' });
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return json(400, { ok: false, error: 'Invalid record id' });
  if (!STATUSES.has(status)) return json(400, { ok: false, error: 'Unknown status' });
  const tagsIn = body.tags && typeof body.tags === 'object' && !Array.isArray(body.tags) ? body.tags : null;

  try {
    const user = await userForPin(supaUrl, serviceKey, pin.trim());
    if (!user) return json(401, { ok: false, error: 'PIN not recognized — log in again.' });
    if (String((user.columns || {})[EDIT_COL] || '').toUpperCase() !== 'TRUE') {
      return json(403, { ok: false, error: 'You don’t have edit access to the Metrc queue.' });
    }

    const formRes = await supaFetch(supaUrl, serviceKey, `operations_forms?id=eq.${id}&select=station_key,status,owner_user,fields`);
    if (!formRes.ok) throw new Error(`record lookup failed: ${formRes.status} ${await formRes.text()}`);
    const form = (await formRes.json())[0];
    if (!form) return json(404, { ok: false, error: 'That form is gone — it may have been deleted.' });
    if (form.status !== 'submitted' || !METRC_STATIONS.has(form.station_key) || form.owner_user === 'paper_import') {
      return json(400, { ok: false, error: 'That form isn’t in the Metrc queue.' });
    }

    // New package tags go on the form record. Only the ones that changed are
    // written and logged.
    let tagChanges = null, fields = form.fields || {};
    if (tagsIn) {
      const allowed = new Set(((STATION_BY_KEY[form.station_key] || {}).metrcTags || []).map((x) => x.k));
      tagChanges = {};
      for (const [k, raw] of Object.entries(tagsIn)) {
        if (!allowed.has(k)) return json(400, { ok: false, error: `Unknown tag field: ${k}` });
        const v = normTag(raw);
        if (v && !/^[A-Z0-9]{4,40}$/.test(v)) return json(400, { ok: false, error: `That doesn’t look like a Metrc tag: ${raw}` });
        if (v !== normTag(fields[k])) tagChanges[k] = v;
      }
      if (Object.keys(tagChanges).length) {
        fields = { ...fields };
        Object.entries(tagChanges).forEach(([k, v]) => { if (v) fields[k] = v; else delete fields[k]; });
        const fr = await supaFetch(supaUrl, serviceKey, `operations_forms?id=eq.${id}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ fields, updated_by: user.name })
        });
        if (!fr.ok) throw new Error(`tag save failed: ${fr.status} ${await fr.text()}`);
      } else tagChanges = null;
    }

    const curRes = await supaFetch(supaUrl, serviceKey, `metrc_queue?form_id=eq.${id}&select=log,note`);
    if (!curRes.ok) throw new Error(`queue lookup failed: ${curRes.status} ${await curRes.text()}`);
    const cur = (await curRes.json())[0];
    const now = new Date().toISOString();
    const nextNote = note === null ? (cur ? cur.note : null) : (note || null);
    const log = [...((cur && cur.log) || []), { status, note: nextNote, ...(tagChanges ? { tags: tagChanges } : {}), by: user.name, at: now }];

    const up = await supaFetch(supaUrl, serviceKey, 'metrc_queue?on_conflict=form_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ form_id: id, station_key: form.station_key, status, note: nextNote, log, updated_by: user.name, updated_at: now })
    });
    if (!up.ok) throw new Error(`save failed: ${up.status} ${await up.text()}`);
    return json(200, { ok: true, row: (await up.json())[0], fields });
  } catch (err) {
    console.error('metrc-queue', err);
    return json(500, { ok: false, error: err.message });
  }
};
