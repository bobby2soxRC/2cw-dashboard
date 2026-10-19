// Truck drivers for the Harvest form's Driver dropdown (ops_form.html,
// driverPicker). The drivers table holds ID numbers and a photo of each
// driver's ID, so it has no anon access; this hands the list (no photos) to
// anyone logged into the hub, and lets them add a driver who isn't on it.
// The photos are only seen in the admin panel's Drivers tab (admin.js).
//
// POST {pin, action:'list'} -> {ok, drivers: [{id, first, last, idNumber}]}
// POST {pin, action:'add', first, last, idNumber, photo (image data URL)}
//   -> {ok, driver, existed}   (an ID number already on the list returns
//      that driver, existed: true, rather than adding a second one)
//
// Required env vars (Netlify site config), same as admin.js:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const MAX_PHOTO_CHARS = 3_000_000;   // ~2 MB image; the form sends ~200 KB

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function supaFetch(supaUrl, serviceKey, path, opts = {}) {
  return fetch(`${supaUrl}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json',
      Prefer: 'return=representation', ...(opts.headers || {})
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
    `app_users?pin=in.(${encodeURIComponent(variants)})&active=is.true&select=name,pin`);
  if (!res.ok) throw new Error(`user lookup failed: ${res.status} ${await res.text()}`);
  return (await res.json()).find((u) => pad(String(u.pin)) === target) || null;
}

const shape = (d) => ({ id: d.id, first: d.first_name, last: d.last_name, idNumber: d.id_number });
const clean = (s, n) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, n);

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

    if (body.action === 'list') {
      const res = await supaFetch(supaUrl, serviceKey,
        'drivers?active=is.true&select=id,first_name,last_name,id_number&order=first_name.asc,last_name.asc');
      if (!res.ok) throw new Error(`drivers read failed: ${res.status} ${await res.text()}`);
      return json(200, { ok: true, drivers: (await res.json()).map(shape) });
    }

    if (body.action === 'add') {
      const first = clean(body.first, 100), last = clean(body.last, 100);
      const idNumber = clean(body.idNumber, 40).toUpperCase();
      const photo = typeof body.photo === 'string' ? body.photo : '';
      if (!first || !last || !idNumber) return json(400, { ok: false, error: 'First name, last name and ID number are required.' });
      if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) return json(400, { ok: false, error: 'A photo of the ID is required.' });
      if (photo.length > MAX_PHOTO_CHARS) return json(400, { ok: false, error: 'That photo is too large.' });

      const dupe = await supaFetch(supaUrl, serviceKey,
        `drivers?id_number=eq.${encodeURIComponent(idNumber)}&select=id,first_name,last_name,id_number,active`);
      if (!dupe.ok) throw new Error(`drivers read failed: ${dupe.status} ${await dupe.text()}`);
      const existing = (await dupe.json())[0];
      if (existing) {
        if (!existing.active) {
          await supaFetch(supaUrl, serviceKey, `drivers?id=eq.${existing.id}`, { method: 'PATCH', body: JSON.stringify({ active: true }) });
        }
        return json(200, { ok: true, driver: shape(existing), existed: true });
      }

      const res = await supaFetch(supaUrl, serviceKey, 'drivers', {
        method: 'POST',
        body: JSON.stringify({ first_name: first, last_name: last, id_number: idNumber, id_photo: photo, created_by: user.name })
      });
      if (!res.ok) throw new Error(`driver save failed: ${res.status} ${await res.text()}`);
      return json(200, { ok: true, driver: shape((await res.json())[0]), existed: false });
    }

    return json(400, { ok: false, error: `Unknown action: ${body.action}` });
  } catch (err) {
    return json(502, { ok: false, error: String(err.message || err) });
  }
};
