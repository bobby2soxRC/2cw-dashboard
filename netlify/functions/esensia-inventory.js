// Esensia partner inventory. The page POSTs the hub PIN. This looks the PIN
// up in app_users and only answers when columns.esensia is TRUE — the same
// checkbox as the Esensia Dashboard card. The body is buildView() from
// esensia_scope.js: Esensia strains, weights, farm, and plant count. Costs,
// customers, invoices, and every other strain stay out of the response.
//
// Canix files are the read-only sync (data/canix_inventory.json and
// data/canix_harvests.json). Yield estimates, when the forms can be read,
// use flower_yield.js (the same model as Raw Inventory's Est. A flower) and
// are labeled ESTIMATED. A missing form read still returns the actual pounds.
//
// POST {pin} -> {ok, view}
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (same as admin.js).

const fs = require('fs');
const path = require('path');
const { buildView, yieldStrains } = require('../../esensia_scope.js');
const FlowerYield = require('../../flower_yield.js');

const COL = 'esensia';

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function findFile(rel) {
  const dir = process.env.ESENSIA_DATA_DIR;
  const roots = dir ? [path.resolve(dir)] : [
    path.join(__dirname, '..', '..'),
    __dirname,
    process.cwd(),
    '/var/task'
  ];
  for (let i = 0; i < roots.length; i++) {
    const p = path.join(roots[i], rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function readJson(rel) {
  const p = findFile(rel);
  if (p) return JSON.parse(fs.readFileSync(p, 'utf8'));
  if (process.env.ESENSIA_DATA_DIR) return null;
  const base = String(process.env.URL || process.env.DEPLOY_URL || '').replace(/\/$/, '');
  if (!base) return null;
  const res = await fetch(`${base}/${rel}`);
  if (!res.ok) throw new Error(`could not read ${rel}`);
  return res.json();
}

let cache = null;
let yieldCache = null;
async function loadBag() {
  if (!process.env.ESENSIA_DATA_DIR && cache) return cache;
  const [packages, harvests, meta, facilitiesRaw, reference] = await Promise.all([
    readJson('data/canix_inventory.json'),
    readJson('data/canix_harvests.json'),
    readJson('data/canix_meta.json'),
    readJson('config/canix_facility_config.json'),
    readJson('data/operations/reference.json')
  ]);
  if (!packages) throw new Error('Canix inventory is not on this server');
  const facilities = {};
  Object.keys(facilitiesRaw || {}).forEach((k) => { if (!k.startsWith('_')) facilities[k] = facilitiesRaw[k]; });
  const bag = {
    packages,
    harvests: harvests || [],
    facilities,
    properties: (reference && reference.properties) || [],
    asOf: (meta && meta.last_sync) || null
  };
  if (!process.env.ESENSIA_DATA_DIR) cache = bag;
  return bag;
}

async function supaFetch(supaUrl, serviceKey, pathAndQuery, headers) {
  return fetch(`${supaUrl}/rest/v1/${pathAndQuery}`, {
    headers: Object.assign({
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json'
    }, headers || {})
  });
}

async function userForPin(supaUrl, serviceKey, pin) {
  const pad = (p) => String(p).padStart(4, '0');
  const target = pad(pin);
  const variants = [...new Set([pin, target, target.replace(/^0+(?=.)/, '')])]
    .map((p) => `"${String(p).replace(/["\\]/g, '')}"`).join(',');
  const res = await supaFetch(supaUrl, serviceKey,
    `app_users?pin=in.(${encodeURIComponent(variants)})&active=is.true&select=name,pin,columns`);
  if (!res.ok) throw new Error(`user lookup failed: ${res.status}`);
  return (await res.json()).find((u) => pad(u.pin) === target) || null;
}

// Submitted take-down, bucking, and hand-trim forms. Paged so a 1,000-row
// default doesn't become a partial rate presented as the full one. If the
// read stops early, the caller skips estimates rather than publish them.
async function loadForms(supaUrl, serviceKey) {
  const rows = [];
  const page = 1000;
  for (let offset = 0; offset < 20000; offset += page) {
    const res = await supaFetch(supaUrl, serviceKey,
      'operations_forms?status=eq.submitted&station_key=in.(dry_check,buck,hand_trim)&select=station_key,fields',
      { Range: `${offset}-${offset + page - 1}` });
    if (!res.ok) throw new Error(`forms read failed: ${res.status}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < page) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

function modelFromForms(rows) {
  const downs = [], bucks = [], trims = [];
  rows.forEach((r) => {
    const f = r.fields || {};
    if (r.station_key === 'dry_check') downs.push(f);
    else if (r.station_key === 'buck') bucks.push(f);
    else if (r.station_key === 'hand_trim') trims.push(f);
  });
  return FlowerYield.buildModel({ downs, bucks, trims, strains: yieldStrains() });
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
    const on = String((user.columns || {})[COL] || '').toUpperCase() === 'TRUE';
    if (!on) return json(403, { ok: false, error: 'This login doesn’t include the Esensia dashboard.' });

    const bag = await loadBag();
    let yieldModel = null;
    const fresh = yieldCache && Date.now() - yieldCache.at < 10 * 60 * 1000 && !process.env.ESENSIA_DATA_DIR;
    if (fresh) yieldModel = yieldCache.model;
    else {
      try {
        let timer;
        const forms = await Promise.race([
          loadForms(supaUrl, serviceKey),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('yield timeout')), 8000); })
        ]).finally(() => clearTimeout(timer));
        if (!forms.truncated) yieldModel = modelFromForms(forms.rows);
        if (!process.env.ESENSIA_DATA_DIR) yieldCache = { at: Date.now(), model: yieldModel };
      } catch (err) {
        console.warn('esensia yield forms unavailable:', err.message || err);
      }
    }
    const view = buildView({ ...bag, yieldModel });
    return json(200, { ok: true, view });
  } catch (err) {
    return json(502, { ok: false, error: String(err.message || err) });
  }
};
