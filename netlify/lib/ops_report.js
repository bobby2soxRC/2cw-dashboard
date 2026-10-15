// The Operations / Staff Hours email report: one day (daily) or the seven
// days ending on a date (weekly). Built here, sent by the scheduled
// functions ops-report-daily.js / ops-report-weekly.js and on demand by
// ops-report.js.
//
//   Staff hours  — Connecteam shifts (data/connecteam_shifts.json, synced
//                  hourly; it holds the last 14 days, enough for a week).
//   Operations   — submitted operations_forms rows from Supabase, summed per
//                  station with ops_analytics.js's dailyOutput, the same
//                  numbers operations_dashboard.html shows.
//
// Dates are farm-local (America/Los_Angeles) throughout.

const OpsAnalytics = require('../../ops_analytics.js');
const { OPERATIONS_STATIONS } = require('../../operations_stations.js');
const { escapeHtml } = require('./mailer');

const TZ = 'America/Los_Angeles';
const SHIFTS_URL = 'https://raw.githubusercontent.com/bobby2soxRC/2cw-dashboard/main/data/connecteam_shifts.json';

const round1 = (x) => Math.round(x * 10) / 10;
const fmt1 = (x) => round1(x).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// YYYY-MM-DD for an instant, in farm time.
const localDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const prettyDay = (day, opts) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });

// {period:'daily'|'weekly', end?:'YYYY-MM-DD'} -> {from, to, label}. `end`
// defaults to yesterday: scheduled reports go out in the morning and cover
// complete days.
function reportWindow(period, end) {
  const today = localDay(new Date());
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(end || '')) ? end : addDays(today, -1);
  const from = period === 'weekly' ? addDays(to, -6) : to;
  const label = period === 'weekly'
    ? `${prettyDay(from, { month: 'short', day: 'numeric' })} – ${prettyDay(to, { month: 'short', day: 'numeric', year: 'numeric' })}`
    : prettyDay(to, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  return { from, to, today, label };
}

// ── Staff hours ─────────────────────────────────────────────────────────────
async function staffHours(win, period) {
  const res = await fetch(`${SHIFTS_URL}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`connecteam_shifts.json: HTTP ${res.status}`);
  const data = await res.json();
  const now = Date.now();

  const people = {}, jobs = {}, activities = {};
  const missingClockOut = [];
  let total = 0, shifts = 0;

  (data.shifts || []).forEach((s) => {
    const start = new Date(s.start);
    const day = localDay(start);
    if (day < win.from || day > win.to) return;
    let end = s.end ? new Date(s.end).getTime() : null;
    if (!end) {
      // Still clocked in today counts up to now; an open shift on an earlier
      // day is a forgotten clock-out — listed, not counted.
      if (day < win.today) { missingClockOut.push({ name: s.name, day }); return; }
      end = now;
    }
    const hrs = Math.max(0, (end - start.getTime()) / 3600000);
    total += hrs; shifts += 1;
    const p = (people[s.userId] = people[s.userId] || { name: s.name, hours: 0, days: {} });
    p.hours += hrs;
    p.days[day] = (p.days[day] || 0) + hrs;
    const job = s.job || '—', act = s.activity || '—';
    jobs[job] = (jobs[job] || 0) + hrs;
    activities[act] = (activities[act] || 0) + hrs;
  });

  const byPerson = Object.values(people).map((p) => {
    const maxDay = Math.max(...Object.values(p.days));
    const flag = period === 'weekly'
      ? (p.hours > 40 ? 'Overtime (40+ hrs)' : maxDay > 8 ? 'Daily overtime' : '')
      : (p.hours > 12 ? 'Double time' : p.hours > 8 ? 'Overtime' : '');
    return { name: p.name, hours: p.hours, days: Object.keys(p.days).length, flag };
  }).sort((a, b) => b.hours - a.hours);

  const sortHours = (o) => Object.entries(o).map(([name, hours]) => ({ name, hours })).sort((a, b) => b.hours - a.hours);
  return {
    lastSync: data.last_sync, total, shifts, people: byPerson.length,
    byPerson, byJob: sortHours(jobs), byActivity: sortHours(activities), missingClockOut
  };
}

// ── Operations ──────────────────────────────────────────────────────────────
async function supaGet(path) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Supabase ${res.status} ${await res.text()}`);
  return res.json();
}

// Same shape ops_data.js's flattenRecord hands ops_analytics.js.
const flatten = (row) => ({ ...row.fields, id: row.id, strain: row.strain || row.fields.strain,
  date: row.work_date, submittedAt: row.submitted_at, stationKey: row.station_key });

async function operations(win) {
  const keys = OPERATIONS_STATIONS.map((s) => s.key);
  const inList = encodeURIComponent(`(${keys.join(',')})`);
  const [submitted, drafts] = await Promise.all([
    supaGet(`operations_forms?status=eq.submitted&station_key=in.${inList}&work_date=gte.${win.from}&work_date=lte.${win.to}&select=id,station_key,strain,work_date,submitted_at,fields&limit=10000`),
    supaGet(`operations_forms?status=eq.draft&station_key=in.${inList}&select=station_key&limit=10000`)
  ]);

  const stages = {};
  submitted.forEach((r) => { (stages[r.station_key] = stages[r.station_key] || []).push(flatten(r)); });
  const out = OpsAnalytics.dailyOutput(stages, { from: win.from, to: win.to });
  const lbByStation = {};
  out.stationKeys.forEach((k, i) => { lbByStation[k] = out.totalsByStation[i]; });

  const openByStation = {};
  drafts.forEach((r) => { openByStation[r.station_key] = (openByStation[r.station_key] || 0) + 1; });

  const rows = OPERATIONS_STATIONS
    .map((s) => ({ key: s.key, title: s.title.en, forms: (stages[s.key] || []).length,
                   lb: lbByStation[s.key] || 0, open: openByStation[s.key] || 0,
                   strains: [...new Set((stages[s.key] || []).map((r) => r.strain).filter(Boolean))] }))
    .filter((r) => r.forms || r.open);
  return { rows, forms: submitted.length, lb: out.totalsByStation.reduce((a, b) => a + b, 0) };
}

// ── Email ───────────────────────────────────────────────────────────────────
const TH = 'text-align:left;padding:6px 10px;border-bottom:2px solid #d0d4dc;font-size:12px;color:#555;text-transform:uppercase;letter-spacing:.03em';
const TD = 'padding:6px 10px;border-bottom:1px solid #e6e8ee;font-size:14px';
const NUM = 'text-align:right;font-variant-numeric:tabular-nums';

function table(cols, rows) {
  if (!rows.length) return '<p style="color:#777;font-size:14px">Nothing logged.</p>';
  const head = cols.map((c) => `<th style="${TH};${c.num ? NUM : ''}">${escapeHtml(c.t)}</th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map((c) => `<td style="${TD};${c.num ? NUM : ''}">${c.html ? c.v(r) : escapeHtml(c.v(r))}</td>`).join('')}</tr>`).join('');
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:0 0 20px">${`<tr>${head}</tr>`}${body}</table>`;
}
const h2 = (t) => `<h2 style="font-size:17px;margin:28px 0 8px;color:#111">${escapeHtml(t)}</h2>`;
const stat = (label, value) => `<td style="padding:10px 16px 10px 0"><div style="font-size:22px;font-weight:700;color:#111">${escapeHtml(value)}</div><div style="font-size:12px;color:#666">${escapeHtml(label)}</div></td>`;

function renderEmail(period, win, hours, ops, siteUrl) {
  const title = period === 'weekly' ? 'Weekly Operations & Staff Hours' : 'Daily Operations & Staff Hours';
  const subject = `${title} — ${win.label}`;
  const flagged = hours.byPerson.filter((p) => p.flag);

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;color:#222">
<h1 style="font-size:21px;margin:0 0 4px">${escapeHtml(title)}</h1>
<div style="color:#666;font-size:14px;margin-bottom:12px">${escapeHtml(win.label)}</div>
<table cellspacing="0" cellpadding="0"><tr>
${stat('staff hours', fmt1(hours.total))}${stat('people', String(hours.people))}${stat('forms submitted', String(ops.forms))}${stat('lbs out', fmt1(ops.lb))}
</tr></table>

${h2('Operations by station')}
${table([
    { t: 'Station', v: (r) => r.title },
    { t: 'Forms', num: true, v: (r) => String(r.forms) },
    { t: 'Lbs out', num: true, v: (r) => (r.lb ? fmt1(r.lb) : '—') },
    { t: 'Open now', num: true, v: (r) => (r.open ? String(r.open) : '') },
    { t: 'Strains', v: (r) => r.strains.slice(0, 4).join(', ') + (r.strains.length > 4 ? ` +${r.strains.length - 4}` : '') }
  ], ops.rows)}

${h2('Hours by site')}
${table([{ t: 'Site', v: (r) => r.name }, { t: 'Hours', num: true, v: (r) => fmt1(r.hours) }], hours.byJob)}

${h2('Hours by activity')}
${table([{ t: 'Activity', v: (r) => r.name }, { t: 'Hours', num: true, v: (r) => fmt1(r.hours) }], hours.byActivity)}

${flagged.length ? h2('Overtime') + table([{ t: 'Name', v: (r) => r.name }, { t: 'Hours', num: true, v: (r) => fmt1(r.hours) }, { t: '', v: (r) => r.flag }], flagged) : ''}

${hours.missingClockOut.length ? h2('Missing clock-outs') + table([{ t: 'Name', v: (r) => r.name }, { t: 'Day', v: (r) => prettyDay(r.day, { weekday: 'short', month: 'short', day: 'numeric' }) }], hours.missingClockOut) : ''}

${h2('Hours by person')}
${table([
    { t: 'Name', v: (r) => r.name },
    ...(period === 'weekly' ? [{ t: 'Days', num: true, v: (r) => String(r.days) }] : []),
    { t: 'Hours', num: true, v: (r) => fmt1(r.hours) }
  ], hours.byPerson)}

<p style="color:#888;font-size:12px;margin-top:28px">Hours from Connecteam (last synced ${escapeHtml(new Date(hours.lastSync).toLocaleString('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }))}); operations from submitted station forms.
${siteUrl ? `<a href="${escapeHtml(siteUrl)}/operations_dashboard.html" style="color:#0a8f78">Operations dashboard</a> · <a href="${escapeHtml(siteUrl)}/staff_hours.html" style="color:#0a8f78">Staff hours</a>` : ''}</p>
</div>`;

  const text = [
    `${title} — ${win.label}`, '',
    `Staff hours: ${fmt1(hours.total)} (${hours.people} people)`,
    `Forms submitted: ${ops.forms} · Lbs out: ${fmt1(ops.lb)}`, '',
    'Operations by station:',
    ...ops.rows.map((r) => `  ${r.title}: ${r.forms} form${r.forms === 1 ? "" : "s"}${r.lb ? `, ${fmt1(r.lb)} lb` : ''}${r.open ? `, ${r.open} open` : ''}`), '',
    'Hours by site:', ...hours.byJob.map((r) => `  ${r.name}: ${fmt1(r.hours)}`), '',
    ...(flagged.length ? ['Overtime:', ...flagged.map((r) => `  ${r.name}: ${fmt1(r.hours)} (${r.flag})`), ''] : []),
    ...(hours.missingClockOut.length ? ['Missing clock-outs:', ...hours.missingClockOut.map((r) => `  ${r.name} (${r.day})`), ''] : []),
    'Hours by person:', ...hours.byPerson.map((r) => `  ${r.name}: ${fmt1(r.hours)}`)
  ].join('\n');

  return { subject, html, text };
}

// buildReport('daily'|'weekly', end?) -> {subject, html, text, window}
async function buildReport(period, end) {
  const win = reportWindow(period, end);
  const [hours, ops] = await Promise.all([staffHours(win, period), operations(win)]);
  const siteUrl = (process.env.URL || '').replace(/\/$/, '');
  return { ...renderEmail(period, win, hours, ops, siteUrl), window: win };
}

module.exports = { buildReport, reportWindow };
