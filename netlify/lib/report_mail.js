// Sending emailed reports: the recipient list (report_recipients), the send
// log (report_runs), and the mail itself. See docs/REPORTS.md.
//
// Mail goes out through a Gmail account with an app password (no domain
// needed). Env vars, Netlify site config only:
//   GMAIL_USER          the sending address, e.g. reports.2cw@gmail.com
//   GMAIL_APP_PASSWORD  a Google "app password" for that account (16 letters)
//   REPORT_FROM_NAME    optional display name (default "2CW Reports")
//   URL                 set by Netlify itself — used for the link back to the site
//
// Recipients are BCC'd (the To line is the sending address), so people
// outside the company don't see each other's addresses.

const nodemailer = require('nodemailer');
const report = require('./intake_drying_report');

const REPORTS = {
  intake_drying: { title: 'Intake & Drying Report' }
};

async function rest(supaUrl, key, path, opts = {}) {
  const res = await fetch(`${supaUrl}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) }
  });
  if (!res.ok) throw new Error(`Supabase ${path.split('?')[0]}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const listRecipients = (supaUrl, key, reportKey) =>
  rest(supaUrl, key, `report_recipients?report_key=eq.${encodeURIComponent(reportKey)}&select=id,email,name,created_at&order=created_at.asc`);

const listRuns = (supaUrl, key, reportKey, limit = 10) =>
  rest(supaUrl, key, `report_runs?report_key=eq.${encodeURIComponent(reportKey)}&select=*&order=ran_at.desc&limit=${limit}`);

async function logRun(supaUrl, key, run) {
  try { await rest(supaUrl, key, 'report_runs', { method: 'POST', body: JSON.stringify(run), headers: { Prefer: 'return=minimal' } }); }
  catch (err) { console.error('report_runs insert failed', err); }   // never let the log hide the real outcome
}

function mailerConfigured() {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

async function sendMail({ bcc, subject, html, text }) {
  if (!mailerConfigured()) throw new Error('Email isn’t set up yet: add GMAIL_USER and GMAIL_APP_PASSWORD in Netlify (see docs/REPORTS.md).');
  const from = process.env.GMAIL_USER;
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: from, pass: process.env.GMAIL_APP_PASSWORD } });
  await transport.sendMail({
    from: `"${(process.env.REPORT_FROM_NAME || '2CW Reports').replace(/"/g, '')}" <${from}>`,
    to: from, bcc, subject, html, text
  });
}

// Builds and sends the Intake & Drying report; intakes received [from, to],
// drying rooms as of now.
//   trigger 'schedule' — the 7 pm job, to everyone on the list
//   trigger 'manual'   — "Send now" in the admin panel: to everyone on the
//                        list, or only to `onlyTo` (one address) when given
// Sent every evening even on a day with no intakes — the drying rooms still
// change. Returns { status, recipients, detail, totalLb }.
async function runIntakeDryingReport({ supaUrl, serviceKey, from, to, trigger, onlyTo }) {
  const reportKey = 'intake_drying';
  const run = { report_key: reportKey, trigger, report_from: from, report_to: to, recipients: 0 };
  try {
    const rep = await report.intakeDryingReport(supaUrl, serviceKey, { from, to });
    run.total_lb = Math.round(rep.received.totalLb * 10) / 10;
    const bcc = onlyTo ? [onlyTo] : (await listRecipients(supaUrl, serviceKey, reportKey)).map((r) => r.email);
    if (!bcc.length) {
      Object.assign(run, { status: 'skipped', detail: 'No recipients on the list.' });
    } else {
      await sendMail({
        bcc,
        subject: report.subjectLine(rep),
        html: report.renderHtml(rep, { siteUrl: process.env.URL }),
        text: report.renderText(rep)
      });
      Object.assign(run, { status: 'sent', recipients: bcc.length, detail: onlyTo ? `Only to ${onlyTo}` : null });
    }
  } catch (err) {
    Object.assign(run, { status: 'failed', detail: String(err.message || err).slice(0, 1000) });
  }
  await logRun(supaUrl, serviceKey, run);
  return { status: run.status, recipients: run.recipients, detail: run.detail || null, totalLb: run.total_lb ?? null };
}

module.exports = { REPORTS, listRecipients, listRuns, mailerConfigured, runIntakeDryingReport };
