#!/usr/bin/env node
// Intake & Drying report from live Supabase data, for the /intake-drying-report
// Claude skill (.claude/skills/intake-drying-report/SKILL.md) or anyone at a
// terminal. Same builder as the 7 pm email (netlify/lib/intake_drying_report.js),
// so the numbers match it exactly.
//
//   node scripts/intake_drying_report.js                       # today
//   node scripts/intake_drying_report.js --days 2              # yesterday + today
//   node scripts/intake_drying_report.js --from 2026-10-01 --to 2026-10-03
//   node scripts/intake_drying_report.js --format html --out report.html
//   node scripts/intake_drying_report.js --format json         # raw numbers
//
// Read-only. Uses the public anon key from config/supabase_config.js (it can
// read operations_forms and ref_codes); SUPABASE_URL / SUPABASE_ANON_KEY env
// vars override it. Needs network access to the Supabase project host.

const fs = require('fs');
const path = require('path');
const report = require('../netlify/lib/intake_drying_report');

function args() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2), v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
    out[k] = v;
  }
  return out;
}

function supabaseConfig() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY };
  const src = fs.readFileSync(path.join(__dirname, '..', 'config', 'supabase_config.js'), 'utf8');
  const pick = (name) => (new RegExp(`const ${name}\\s*=\\s*'([^']*)'`).exec(src) || [])[1];
  return { url: pick('SUPABASE_URL'), key: pick('SUPABASE_ANON_KEY') };
}

(async () => {
  const opt = args();
  const today = report.pacificDate();
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  let from = today, to = today;
  if (opt.days) from = report.addDays(today, -(Math.max(1, Number(opt.days)) - 1));
  if (ymd.test(opt.from || '')) from = opt.from;
  if (ymd.test(opt.to || '')) to = opt.to;
  else if (ymd.test(opt.from || '')) to = today;
  if (from > to) [from, to] = [to, from];

  const { url, key } = supabaseConfig();
  if (!url || !key) throw new Error('No Supabase URL/key — set SUPABASE_URL and SUPABASE_ANON_KEY, or fill in config/supabase_config.js');

  const rep = await report.intakeDryingReport(url, key, { from, to, today });
  const format = opt.format || 'md';
  const body = format === 'json' ? JSON.stringify(rep, null, 2)
    : format === 'html' ? `<!doctype html><meta charset="utf-8"><title>${report.subjectLine(rep)}</title><body style="margin:16px">${report.renderHtml(rep)}</body>`
    : report.renderMarkdown(rep);
  if (opt.out) { fs.writeFileSync(opt.out, body); console.log(`Wrote ${opt.out}`); }
  else console.log(body);
})().catch((err) => {
  console.error(`intake_drying_report: ${err.message}`);
  if (/fetch failed|ENOTFOUND|403|ECONNREFUSED/i.test(String(err.message) + String(err.cause || ''))) {
    console.error('Can this machine reach the Supabase host? In a Claude cloud session, its domain has to be on the environment\'s allowed list (docs/REPORTS.md).');
  }
  process.exit(1);
});
