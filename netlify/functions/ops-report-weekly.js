// Scheduled: last week's (Mon–Sun) Operations / Staff Hours report, Monday
// mornings (schedule in netlify.toml). Recipients come from the
// OPS_REPORT_WEEKLY_TO env var (comma-separated); with none set, nothing is
// sent.

const { buildReport } = require('../lib/ops_report');
const { sendMail, parseRecipients } = require('../lib/mailer');

exports.handler = async () => {
  const to = parseRecipients(process.env.OPS_REPORT_WEEKLY_TO);
  if (!to.length) { console.log('ops-report-weekly: OPS_REPORT_WEEKLY_TO not set, skipping'); return { statusCode: 200 }; }
  const report = await buildReport('weekly');
  await sendMail({ to, subject: report.subject, html: report.html, text: report.text });
  console.log(`ops-report-weekly: sent "${report.subject}" to ${to.length}`);
  return { statusCode: 200 };
};
