// Delete an operations form, and read the change history of a station's
// forms (operations_forms_history — see supabase/schema.sql). Both need a
// per-user permission from the admin panel, checked here against app_users
// from the PIN the person logged in with — not trusted from the browser,
// which is why these don't go through the anon key like the rest of
// ops_data.js.
//
// POST {action:'history', pin, stationKey}            -> {ok, history, deleted}
// POST {action:'delete',  pin, stationKey, id, reason} -> {ok}
//
// Required env vars (Netlify site config), same as admin.js:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// Which stations this covers, and the app_users column that grants each
// action there. Only Harvest Intakes has a records page today.
const STATIONS = {
  intake_wet: { delete: 'harvest intakes delete', history: 'harvest intakes history' }
};

const HISTORY_LIMIT = 5000;

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

// Hub login compares PINs zero-padded to 4 digits (index.html), so "0123"
// typed matches "123" stored — look up the same spellings here.
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

const allowed = (user, col) => String((user.columns || {})[col] || '').toUpperCase() === 'TRUE';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !serviceKey) return json(500, { ok: false, error: 'Server missing Supabase configuration' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }
  const { action, pin, stationKey } = body;
  const cols = STATIONS[stationKey];
  if (!cols || !cols[action]) return json(400, { ok: false, error: 'Unknown action or station' });
  if (typeof pin !== 'string' || !pin.trim()) return json(401, { ok: false, error: 'Not logged in' });

  try {
    const user = await userForPin(supaUrl, serviceKey, pin.trim());
    if (!user) return json(401, { ok: false, error: 'PIN not recognized — log in again.' });
    if (!allowed(user, cols[action])) return json(403, { ok: false, error: 'You don’t have permission to do that.' });
    const actor = user.name;  // same name the app logs everywhere else (2cw_user_name)

    if (action === 'history') {
      // Snapshots only for deletions (to show the deleted record); edits
      // carry their changes, and the as-submitted snapshot isn't needed here.
      const base = `operations_forms_history?station_key=eq.${encodeURIComponent(stationKey)}&order=created_at.desc`;
      const [hRes, dRes] = await Promise.all([
        supaFetch(supaUrl, serviceKey, `${base}&select=id,form_id,action,actor,reason,changes,created_at&limit=${HISTORY_LIMIT}`),
        supaFetch(supaUrl, serviceKey, `${base}&action=eq.deleted&select=form_id,actor,reason,created_at,snapshot&limit=${HISTORY_LIMIT}`)
      ]);
      if (!hRes.ok) throw new Error(`history read failed: ${hRes.status} ${await hRes.text()}`);
      if (!dRes.ok) throw new Error(`history read failed: ${dRes.status} ${await dRes.text()}`);
      return json(200, { ok: true, history: await hRes.json(), deleted: await dRes.json() });
    }

    // action === 'delete'
    const { id } = body;
    const reason = String(body.reason || '').trim().slice(0, 500);
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return json(400, { ok: false, error: 'Invalid record id' });
    if (!reason) return json(400, { ok: false, error: 'A reason is required.' });

    // Confirm the record is on this station, so a delete permission for one
    // station's records can't be used on another's.
    const chk = await supaFetch(supaUrl, serviceKey, `operations_forms?id=eq.${id}&select=station_key`);
    if (!chk.ok) throw new Error(`record lookup failed: ${chk.status} ${await chk.text()}`);
    const rec = (await chk.json())[0];
    if (!rec) return json(404, { ok: false, error: 'Record not found — it may already be deleted.' });
    if (rec.station_key !== stationKey) return json(403, { ok: false, error: 'Record is not on this station' });

    const del = await supaFetch(supaUrl, serviceKey, 'rpc/delete_operations_form', {
      method: 'POST',
      body: JSON.stringify({ p_id: id, p_actor: actor, p_reason: reason })
    });
    if (!del.ok) throw new Error(`delete failed: ${del.status} ${await del.text()}`);
    if (!(await del.json())) return json(404, { ok: false, error: 'Record not found — it may already be deleted.' });
    return json(200, { ok: true });
  } catch (err) {
    return json(502, { ok: false, error: String(err.message || err) });
  }
};
