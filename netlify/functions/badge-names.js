// Badge number -> employee name, for the station forms' daily summaries
// (ops_form.html), which list people by the Employee # typed on the form.
// The mapping lives in employee_badges (admin panel → Labor Rates → Badge #),
// which is service role only; this hands out just badge and name — names the
// Connecteam roster file (data/connecteam_roster.json) already publishes —
// never the Connecteam id or anything about pay.
//
// GET -> {ok, names: {"6": "Ana Reyes", ...}}
//
// Required env vars (Netlify site config), same as admin.js:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { badgeKey } = require('../../ops_analytics.js');

function json(statusCode, body, extra) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...(extra || {}) }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });

  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !serviceKey) return json(500, { ok: false, error: 'Server missing Supabase configuration' });

  try {
    const res = await fetch(`${supaUrl}/rest/v1/employee_badges?select=badge_no,employee_name`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
    });
    if (!res.ok) throw new Error(`badges read failed: ${res.status} ${await res.text()}`);
    const names = {};
    (await res.json()).forEach((r) => { if (r.employee_name) names[badgeKey(r.badge_no)] = r.employee_name; });
    return json(200, { ok: true, names }, { 'Cache-Control': 'max-age=300' });
  } catch (err) {
    return json(502, { ok: false, error: String(err.message || err) });
  }
};
