// Per-person labor rates for the Labor Log's cost reports (labor_log.html).
// Rates are pay, so the labor_rates table has no anon access; this hands them
// only to someone whose app_users row has 'labor log costs' ticked (admin
// panel → user editor → Labor Log), looked up from the PIN they logged in
// with — same pattern as operations-records.js. Rates are set in the admin
// panel's Labor Rates tab (admin.js).
//
// POST {pin} -> {ok, rates: [{employeeId, rate, from}]}   ('*' = default rate)
//
// Required env vars (Netlify site config), same as admin.js:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const COST_COL = 'labor log costs';

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function supaFetch(supaUrl, serviceKey, path) {
  return fetch(`${supaUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !serviceKey) return json(500, { ok: false, error: 'Server missing Supabase configuration' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }
  const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
  if (!pin) return json(401, { ok: false, error: 'Not logged in' });

  try {
    const user = await userForPin(supaUrl, serviceKey, pin);
    if (!user) return json(401, { ok: false, error: 'PIN not recognized — log in again.' });
    if (String((user.columns || {})[COST_COL] || '').toUpperCase() !== 'TRUE') {
      return json(403, { ok: false, error: 'You don’t have permission to see labor costs.' });
    }
    const res = await supaFetch(supaUrl, serviceKey, 'labor_rates?select=employee_id,rate,effective_from&order=effective_from.asc');
    if (!res.ok) throw new Error(`rates read failed: ${res.status} ${await res.text()}`);
    const rates = (await res.json()).map((r) => ({ employeeId: r.employee_id, rate: Number(r.rate), from: r.effective_from }));
    return json(200, { ok: true, rates });
  } catch (err) {
    return json(502, { ok: false, error: String(err.message || err) });
  }
};
