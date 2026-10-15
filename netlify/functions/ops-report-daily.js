// Scheduled: yesterday's Operations / Staff Hours report, every morning
// (schedule in netlify.toml). Recipients come from the OPS_REPORT_DAILY_TO
// env var (comma-separated); with none set, nothing is sent.

const { buildReport } = require('../lib/ops_report');
const { sendMail, parseRecipients } = require('../lib/mailer');

exports.handler = async () => {
  const to = parseRecipients(process.env.OPS_REPORT_DAILY_TO);
  if (!to.length) { console.log('ops-report-daily: OPS_REPORT_DAILY_TO not set, skipping'); return { statusCode: 200 }; }
  const report = await buildReport('daily');
  await sendMail({ to, subject: report.subject, html: report.html, text: report.text });
  console.log(`ops-report-daily: sent "${report.subject}" to ${to.length}`);
  return { statusCode: 200 };
};
