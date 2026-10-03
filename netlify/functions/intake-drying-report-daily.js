// Scheduled: emails the Intake & Drying report (today's intakes + what's in
// each drying room now) to everyone on the admin panel's Reports list at
// 7 pm Pacific. See docs/REPORTS.md.
//
// Netlify schedules run on UTC, which doesn't follow daylight saving, so
// netlify.toml fires this at both 02:00 and 03:00 UTC and it only sends on
// the run that lands on 7 pm in California (02:00 in summer, 03:00 in winter).
// Scheduled functions can't be called from a browser in production.

const { pacificDate, pacificHour } = require('../lib/intake_drying_report');
const { runIntakeDryingReport } = require('../lib/report_mail');

const SEND_HOUR = 19;

exports.handler = async () => {
  const hour = pacificHour();
  if (hour !== SEND_HOUR) return { statusCode: 200, body: `Not ${SEND_HOUR}:00 Pacific (it's ${hour}:00) — nothing to do.` };

  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !serviceKey) return { statusCode: 500, body: 'Server missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' };

  const today = pacificDate();
  const result = await runIntakeDryingReport({ supaUrl, serviceKey, from: today, to: today, trigger: 'schedule' });
  console.log('intake & drying report', today, JSON.stringify(result));
  return { statusCode: 200, body: JSON.stringify(result) };
};
