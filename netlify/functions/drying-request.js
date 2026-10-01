// Client drying request form (drying_request.html) -> a new row in
// drying_intakes with status 'requested', for the office to review on the
// Drying Schedule.
//
//   POST {farm_name, license_number, contact_name, contact_phone,
//         contact_email, farm_size, farm_size_unit, strains, est_wet_lb,
//         harvests:[{start, days, lb}], services:[key],
//         farm_support:[{start, days, people}], notes, website}
//     -> {ok:true} | {ok:false, error}
//
// The form is public (no PIN), so it never talks to Supabase itself: this
// function checks and trims every field, only ever inserts (a client can't
// read or change anything), and stamps status/created_by so a submission
// can't pretend to be a confirmed booking. `website` is a honeypot field
// hidden from people — bots that fill it get a fake success. A global cap
// on submissions per hour stops a flood from burying the schedule.
//
// Required env vars (already set for admin.js):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// Must match the keys in drying_services.js.
const ALLOWED_SERVICES = new Set([
  'drying', 'farm_labor', 'hand_bucking', 'hand_trim', 'machine_trim', 'trim_smalls',
  'batching', 'dry_storage', 'cargo_van', 'box_truck', 'reefer', 'rd_potency', 'rd_full_panel'
]);
const UNITS = new Set(['sq ft', 'acres', 'plants']);
const MAX_PER_HOUR = 30;
const MAX_WINDOWS = 20;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = 864e5;

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
      Prefer: 'return=minimal',
      ...(opts.headers || {})
    }
  });
}

class Bad extends Error {}

const str = (v, max) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
};
const num = (v, min, max, what) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Bad(`Please check ${what}.`);
  return n;
};
const date = (v, what) => {
  const d = typeof v === 'string' && DATE_RE.test(v) ? Date.parse(v + 'T00:00:00Z') : NaN;
  if (!Number.isFinite(d)) throw new Bad(`Please check the ${what} dates.`);
  const now = Date.now();
  if (d < now - 60 * DAY || d > now + 2 * 365 * DAY) throw new Bad(`Please check the ${what} dates.`);
  return v;
};

// [{start, days, <extra>}] -> cleaned list sorted by start; fully blank rows dropped.
function windows(list, extraKey, extraMin, extraMax, what) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > MAX_WINDOWS) throw new Bad(`Please check the ${what} dates.`);
  return list
    .filter((w) => w && (w.start || w.days || w[extraKey]))
    .map((w) => ({
      start: date(w.start, what),
      days: Math.round(num(w.days, 1, 60, `the number of ${what} days`) || 1),
      [extraKey]: num(w[extraKey], extraMin, extraMax, `the ${what} rows`)
    }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

function clean(p) {
  const row = {
    farm_name: str(p.farm_name, 200),
    license_number: (str(p.license_number, 60) || '').toUpperCase() || null,
    contact_name: str(p.contact_name, 120),
    contact_phone: str(p.contact_phone, 40),
    contact_email: (str(p.contact_email, 200) || '').toLowerCase() || null,
    farm_size: num(p.farm_size, 0, 1e9, 'the farm size'),
    farm_size_unit: UNITS.has(p.farm_size_unit) ? p.farm_size_unit : 'sq ft',
    strains: str(p.strains, 500),
    est_wet_lb: num(p.est_wet_lb, 0, 1e8, 'the estimated wet weight'),
    notes: str(p.notes, 4000)
  };
  if (!row.farm_name) throw new Bad('Please enter your farm name.');
  if (!row.license_number) throw new Bad('Please enter your license number.');
  if (!row.contact_name) throw new Bad('Please enter a contact name.');
  if (!row.contact_phone && !row.contact_email) throw new Bad('Please enter a phone number or email so we can reach you.');
  if (row.contact_email && !EMAIL_RE.test(row.contact_email)) throw new Bad('Please check the email address.');

  const services = Array.isArray(p.services) ? [...new Set(p.services.filter((k) => ALLOWED_SERVICES.has(k)))] : [];
  if (!services.length) throw new Bad('Please pick at least one service.');
  const harvests = windows(p.harvests, 'lb', 0, 1e8, 'harvest');
  const support = services.includes('farm_labor') ? windows(p.farm_support, 'people', 1, 500, 'farm support') : [];
  if (support.some((s) => !s.people)) throw new Bad('Please add how many people you need for each farm support date.');

  // Same derived columns drying_schedule.html keeps: first harvest day,
  // last harvest day, and the total (or the sum of per-date lbs).
  const spans = harvests.map((h) => {
    const a = Date.parse(h.start + 'T00:00:00Z');
    return { a, b: a + (h.days - 1) * DAY };
  });
  const lbSum = harvests.reduce((s, h) => s + (h.lb || 0), 0);
  return {
    ...row,
    harvests,
    services,
    farm_support: support,
    est_start: spans.length ? new Date(Math.min(...spans.map((s) => s.a))).toISOString().slice(0, 10) : null,
    est_end: spans.length ? new Date(Math.max(...spans.map((s) => s.b))).toISOString().slice(0, 10) : null,
    est_wet_lb: row.est_wet_lb ?? (lbSum || null),
    status: 'requested',
    created_by: 'Client form',
    updated_by: 'Client form'
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !serviceKey) return json(500, { ok: false, error: 'The request form is not set up yet. Please call or email us instead.' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Bad request' }); }
  if (payload.website) return json(200, { ok: true });   // honeypot

  let row;
  try { row = clean(payload); } catch (e) {
    if (e instanceof Bad) return json(400, { ok: false, error: e.message });
    throw e;
  }

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await supaFetch(supaUrl, serviceKey,
    `drying_intakes?select=id&created_by=eq.${encodeURIComponent('Client form')}&created_at=gte.${encodeURIComponent(since)}&limit=${MAX_PER_HOUR}`,
    { headers: { Prefer: '' } });
  if (recent.ok && (await recent.json()).length >= MAX_PER_HOUR) {
    return json(429, { ok: false, error: 'We’re getting a lot of requests right now — please try again in an hour, or call or email us.' });
  }

  const res = await supaFetch(supaUrl, serviceKey, 'drying_intakes', { method: 'POST', body: JSON.stringify(row) });
  if (!res.ok) {
    console.error('drying-request insert failed', res.status, await res.text());
    return json(500, { ok: false, error: 'Something went wrong saving your request. Please try again, or call or email us.' });
  }
  return json(200, { ok: true });
};
