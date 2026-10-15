// Operations / Staff Hours report, on demand (the "Email me this report"
// button on staff_hours.html). The same report goes out on a schedule from
// ops-report-daily.js and ops-report-weekly.js; see netlify/lib/ops_report.js.
//
// POST {pin, period:'daily'|'weekly', end?:'YYYY-MM-DD'} -> {ok, to, subject}
//   Emails the report to the person asking (app_users.email). Needs the
//   'staff hours' column TRUE for that user, checked here from the PIN.
//   `end` defaults to today for on-demand (today so far), unlike the
//   scheduled runs, which cover through yesterday.
//
// Required env vars (Netlify site config):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   same as admin.js
//   GMAIL_USER, GMAIL_APP_PASSWORD            see netlify/lib/mailer.js

const { buildReport, reportWindow } = require('../lib/ops_report');
const { mailConfigured, sendMail } = require('../lib/mailer');

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Hub login compares PINs zero-padded to 4 digits (index.html) — same lookup
// as operations-records.js.
async function userForPin(pin) {
  const supaUrl = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const pad = (p) => p.padStart(4, '0');
  const target = pad(pin);
  const variants = [...new Set([pin, target, target.replace(/^0+(?=.)/, '')])]
    .map((p) => `"${p.replace(/["\\]/g, '')}"`).join(',');
  const res = await fetch(`${supaUrl}/rest/v1/app_users?pin=in.(${encodeURIComponent(variants)})&active=is.true&select=name,pin,email,columns`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`user lookup failed: ${res.status} ${await res.text()}`);
  return (await res.json()).find((u) => pad(String(u.pin)) === target) || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Bad request' }); }

  const pin = String(body.pin || '').trim();
  const period = body.period === 'weekly' ? 'weekly' : 'daily';
  if (!/^\d{1,8}$/.test(pin)) return json(401, { ok: false, error: 'Please log in again.' });
  if (!mailConfigured()) return json(503, { ok: false, error: 'Email isn’t set up yet.' });

  try {
    const user = await userForPin(pin);
    if (!user) return json(401, { ok: false, error: 'Please log in again.' });
    if (String((user.columns || {})['staff hours'] || '').toUpperCase() !== 'TRUE') {
      return json(403, { ok: false, error: 'You don’t have access to this report.' });
    }
    if (!user.email) return json(400, { ok: false, error: 'There’s no email address on your account — ask an admin to add one.' });

    const end = body.end || reportWindow(period).today;
    const report = await buildReport(period, end);
    await sendMail({ to: user.email, subject: report.subject, html: report.html, text: report.text });
    return json(200, { ok: true, to: user.email, subject: report.subject });
  } catch (e) {
    console.error('ops-report', e);
    return json(500, { ok: false, error: 'Couldn’t send the report. Try again in a minute.' });
  }
};
