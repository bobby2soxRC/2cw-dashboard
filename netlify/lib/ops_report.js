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
const { OPERATIONS_STATIONS, G_PER_LB } = require('../../operations_stations.js');
const { escapeHtml } = require('./mailer');

const TZ = 'America/Los_Angeles';
const SHIFTS_URL = 'https://raw.githubusercontent.com/bobby2soxRC/2cw-dashboard/main/data/connecteam_shifts.json';

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };
const round1 = (x) => Math.round(x * 10) / 10;
const fmt1 = (x) => round1(x).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtUsd = (x) => '$' + Math.round(x).toLocaleString('en-US');

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
// `rates` (labor_rates rows, or null to leave cost out): each shift costed
// at the person's rate on that day — straight time only, no overtime premium.
async function staffHours(win, period, rates) {
  const res = await fetch(`${SHIFTS_URL}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`connecteam_shifts.json: HTTP ${res.status}`);
  const data = await res.json();
  const now = Date.now();

  const people = {}, jobs = {}, activities = {};
  const missingClockOut = [];
  let total = 0, shifts = 0, cost = 0, unratedHours = 0;
  const add = (o, k, hrs, c) => { o[k] = o[k] || { name: k, hours: 0, cost: 0 }; o[k].hours += hrs; o[k].cost += c; };

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
    const rate = rates ? OpsAnalytics.rateFor(rates, s.userId, day) : null;
    const c = rate != null ? hrs * rate : 0;
    if (rates && rate == null) unratedHours += hrs;
    total += hrs; shifts += 1; cost += c;
    const p = (people[s.userId] = people[s.userId] || { name: s.name, hours: 0, cost: 0, days: {} });
    p.hours += hrs; p.cost += c;
    p.days[day] = (p.days[day] || 0) + hrs;
    // "Hanging / Colgar · Esensia" counts as Hanging: the part after the dot
    // is a sub-location, not a different kind of work.
    const act = String(s.activity || '').split(' · ')[0].trim() || '(no activity)';
    const job = s.job || '—';
    add(jobs, job, hrs, c);
    add((jobs[job].acts = jobs[job].acts || {}), act, hrs, c);
    add(activities, act, hrs, c);
  });

  const byPerson = Object.values(people).map((p) => {
    const maxDay = Math.max(...Object.values(p.days));
    const flag = period === 'weekly'
      ? (p.hours > 40 ? 'Overtime (40+ hrs)' : maxDay > 8 ? 'Daily overtime' : '')
      : (p.hours > 12 ? 'Double time' : p.hours > 8 ? 'Overtime' : '');
    return { name: p.name, hours: p.hours, cost: p.cost, days: Object.keys(p.days).length, flag };
  }).sort((a, b) => b.hours - a.hours);

  const sortHours = (o) => Object.values(o).sort((a, b) => b.hours - a.hours);
  return {
    lastSync: data.last_sync, total, shifts, people: byPerson.length,
    withCost: Boolean(rates), cost, unratedHours,
    byPerson, byActivity: sortHours(activities), missingClockOut,
    byJob: sortHours(jobs).map((j) => ({ ...j, acts: sortHours(j.acts) }))
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

// Pounds weighed in the window on every page of a station with a
// `dailySummary` (Bucking, Hand Trim, Smalls), open pages included: the same
// tally as the Daily Summary under those forms. Rows stamped with their own
// day (`dateCol`) count on that day, so a lot open across three days counts
// each day's pounds once; without one, the page's date is the day.
function weighedByStation(pages, win) {
  const by = {};
  OPERATIONS_STATIONS.filter((s) => s.dailySummary).forEach((station) => {
    const cfg = station.dailySummary;
    const toLb = cfg.unit === 'lb' && !cfg.fromGrams ? 1 : 1 / G_PER_LB;
    let lb = 0;
    const people = new Set(), open = new Set(), strains = new Set();
    pages.filter((p) => p.station_key === station.key).forEach((p) => {
      ((p.fields || {})[cfg.lines] || []).forEach((r) => {
        const day = cfg.dateCol ? String(r[cfg.dateCol] || p.work_date) : p.work_date;
        const v = num(r[cfg.valueCol]);
        if (day < win.from || day > win.to || !v) return;
        lb += v * toLb;
        // "126" and "126." are the same person.
        const who = String(r[cfg.empCol] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (who) people.add(who);
        if (p.status === 'draft') open.add(p.id);
        const strain = p.strain || (p.fields || {}).strain;
        if (strain) strains.add(strain);
      });
    });
    if (lb) by[station.key] = { lb, people: people.size, openPages: open.size, strains: [...strains] };
  });
  return by;
}

async function operations(win) {
  const keys = OPERATIONS_STATIONS.map((s) => s.key);
  const inList = encodeURIComponent(`(${keys.join(',')})`);
  const tallyKeys = OPERATIONS_STATIONS.filter((s) => s.dailySummary).map((s) => s.key);
  // A page can stay open for weeks, so look back like ops_form.html's
  // Daily Summary does (45 days) for rows weighed in the window.
  const [submitted, drafts, tallyPages] = await Promise.all([
    supaGet(`operations_forms?status=eq.submitted&station_key=in.${inList}&work_date=gte.${win.from}&work_date=lte.${win.to}&select=id,station_key,strain,work_date,submitted_at,fields&limit=10000`),
    supaGet(`operations_forms?status=eq.draft&station_key=in.${inList}&select=station_key&limit=10000`),
    supaGet(`operations_forms?station_key=in.${encodeURIComponent(`(${tallyKeys.join(',')})`)}&work_date=gte.${addDays(win.from, -45)}&work_date=lte.${win.to}&select=id,station_key,status,strain,work_date,fields&limit=10000`)
  ]);
  const weighed = weighedByStation(tallyPages, win);

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
                   weighed: weighed[s.key] || null,
                   strains: [...new Set([...(stages[s.key] || []).map((r) => r.strain), ...((weighed[s.key] || {}).strains || [])].filter(Boolean))] }))
    .filter((r) => r.forms || r.open || r.weighed);
  // A station's pounds: what was weighed in the window when it keeps a daily
  // tally (open pages count), otherwise pounds out on its submitted forms.
  rows.forEach((r) => { r.lbShown = r.weighed ? r.weighed.lb : r.lb; });
  return { rows, forms: submitted.length, lb: rows.reduce((a, r) => a + r.lbShown, 0) };
}

// ── Labor cost ──────────────────────────────────────────────────────────────
// $/hr from the labor_rates table (admin panel → Labor Rates), keyed by
// Connecteam user id with '*' as the default — the same rates and lookup
// (OpsAnalytics.rateFor) the Labor Log's cost reports use.
const laborRates = async () => (await supaGet('labor_rates?select=employee_id,rate,effective_from'))
  .map((r) => ({ employeeId: r.employee_id, rate: Number(r.rate), from: r.effective_from }));

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
// Each site with its activities under it: hours, share of the site's hours,
// and labor $ when costed.
function siteActivityTable(byJob, withCost) {
  if (!byJob.length) return '<p style="color:#777;font-size:14px">Nothing logged.</p>';
  const cols = ['Site / activity', 'Hours', '% of site', ...(withCost ? ['Labor $'] : [])];
  const head = cols.map((t, i) => `<th style="${TH};${i ? NUM : ''}">${escapeHtml(t)}</th>`).join('');
  const row = (cells, site) => `<tr${site ? ' style="background:#f3f5f8"' : ''}>${cells.map((c, i) =>
    `<td style="${TD};${i ? NUM : ''}${site ? ';font-weight:700' : ''}${!site && !i ? ';padding-left:26px' : ''}">${escapeHtml(c)}</td>`).join('')}</tr>`;
  const body = byJob.map((j) => row([j.name, fmt1(j.hours), '', ...(withCost ? [fmtUsd(j.cost)] : [])], true) +
    j.acts.map((a) => row([a.name, fmt1(a.hours), `${Math.round((a.hours / j.hours) * 100)}%`, ...(withCost ? [fmtUsd(a.cost)] : [])], false)).join('')).join('');
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:0 0 20px"><tr>${head}</tr>${body}</table>`;
}

const h2 = (t) => `<h2 style="font-size:17px;margin:28px 0 8px;color:#111">${escapeHtml(t)}</h2>`;
const stat = (label, value) => `<td style="padding:10px 16px 10px 0"><div style="font-size:22px;font-weight:700;color:#111">${escapeHtml(value)}</div><div style="font-size:12px;color:#666">${escapeHtml(label)}</div></td>`;

function renderEmail(period, win, hours, ops, siteUrl) {
  const title = period === 'weekly' ? 'Weekly Operations & Staff Hours' : 'Daily Operations & Staff Hours';
  const subject = `${title} — ${win.label}`;
  const flagged = hours.byPerson.filter((p) => p.flag);
  const $col = hours.withCost ? [{ t: 'Labor $', num: true, v: (r) => fmtUsd(r.cost) }] : [];

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;color:#222">
<h1 style="font-size:21px;margin:0 0 4px">${escapeHtml(title)}</h1>
<div style="color:#666;font-size:14px;margin-bottom:12px">${escapeHtml(win.label)}</div>
<table cellspacing="0" cellpadding="0"><tr>
${stat('staff hours', fmt1(hours.total))}${hours.withCost ? stat('labor cost', fmtUsd(hours.cost)) : ''}${stat('people', String(hours.people))}${stat('lbs worked', fmt1(ops.lb))}${stat('forms submitted', String(ops.forms))}
</tr></table>

${h2('Operations by station')}
${table([
    { t: 'Station', v: (r) => r.title },
    { t: 'Lbs', num: true, v: (r) => (r.lbShown ? fmt1(r.lbShown) : '—') },
    { t: 'People', num: true, v: (r) => (r.weighed ? String(r.weighed.people) : '') },
    { t: 'Submitted', num: true, v: (r) => String(r.forms) },
    { t: 'Open now', num: true, v: (r) => (r.open ? String(r.open) : '') },
    { t: 'Strains', v: (r) => r.strains.slice(0, 4).join(', ') + (r.strains.length > 4 ? ` +${r.strains.length - 4}` : '') }
  ], ops.rows)}
<p style="color:#888;font-size:12px;margin:-12px 0 0">Bucking and hand trim: pounds weighed in this period on every page, finished or still open (the forms' Daily Summary). Other stations: pounds out on submitted forms.</p>

${h2('Labor by site and activity')}
${siteActivityTable(hours.byJob, hours.withCost)}

${h2('Hours by activity')}
${table([{ t: 'Activity', v: (r) => r.name }, { t: 'Hours', num: true, v: (r) => fmt1(r.hours) }, ...$col], hours.byActivity)}

${flagged.length ? h2('Overtime') + table([{ t: 'Name', v: (r) => r.name }, { t: 'Hours', num: true, v: (r) => fmt1(r.hours) }, { t: '', v: (r) => r.flag }], flagged) : ''}

${hours.missingClockOut.length ? h2('Missing clock-outs') + table([{ t: 'Name', v: (r) => r.name }, { t: 'Day', v: (r) => prettyDay(r.day, { weekday: 'short', month: 'short', day: 'numeric' }) }], hours.missingClockOut) : ''}

${h2('Hours by person')}
${table([
    { t: 'Name', v: (r) => r.name },
    ...(period === 'weekly' ? [{ t: 'Days', num: true, v: (r) => String(r.days) }] : []),
    { t: 'Hours', num: true, v: (r) => fmt1(r.hours) },
    ...$col
  ], hours.byPerson)}

<p style="color:#888;font-size:12px;margin-top:28px">Hours from Connecteam (last synced ${escapeHtml(new Date(hours.lastSync).toLocaleString('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }))}); operations from station forms.${hours.withCost ? ` Labor $ is hours × each person's rate (admin → Labor Rates), straight time only: overtime premiums aren't included.${hours.unratedHours ? ` ${fmt1(hours.unratedHours)} hrs had no rate and aren't costed.` : ''}` : ''}
${siteUrl ? `<a href="${escapeHtml(siteUrl)}/operations_dashboard.html" style="color:#0a8f78">Operations dashboard</a> · <a href="${escapeHtml(siteUrl)}/staff_hours.html" style="color:#0a8f78">Staff hours</a>` : ''}</p>
</div>`;

  const text = [
    `${title} — ${win.label}`, '',
    `Staff hours: ${fmt1(hours.total)} (${hours.people} people)`,
    ...(hours.withCost ? [`Labor cost: ${fmtUsd(hours.cost)} (straight time)`] : []),
    `Lbs worked: ${fmt1(ops.lb)} · Forms submitted: ${ops.forms}`, '',
    'Operations by station:',
    ...ops.rows.map((r) => `  ${r.title}: ${r.lbShown ? `${fmt1(r.lbShown)} lb, ` : ''}${r.forms} submitted${r.open ? `, ${r.open} open` : ''}`), '',
    'Labor by site and activity:', ...hours.byJob.flatMap((j) => [
      `  ${j.name}: ${fmt1(j.hours)} hrs${hours.withCost ? ` (${fmtUsd(j.cost)})` : ''}`,
      ...j.acts.map((a) => `      ${a.name}: ${fmt1(a.hours)} hrs${hours.withCost ? ` (${fmtUsd(a.cost)})` : ''}`)]), '',
    ...(flagged.length ? ['Overtime:', ...flagged.map((r) => `  ${r.name}: ${fmt1(r.hours)} (${r.flag})`), ''] : []),
    ...(hours.missingClockOut.length ? ['Missing clock-outs:', ...hours.missingClockOut.map((r) => `  ${r.name} (${r.day})`), ''] : []),
    'Hours by person:', ...hours.byPerson.map((r) => `  ${r.name}: ${fmt1(r.hours)}${hours.withCost ? ` (${fmtUsd(r.cost)})` : ''}`)
  ].join('\n');

  return { subject, html, text };
}

// buildReport('daily'|'weekly', end?, {withCost}) -> {subject, html, text, window}
// withCost (default true) adds labor dollars; leave it off for anyone who
// can't see pay (the on-demand button checks 'labor log costs').
async function buildReport(period, end, { withCost = true } = {}) {
  const win = reportWindow(period, end);
  const rates = withCost ? await laborRates() : null;
  const [hours, ops] = await Promise.all([staffHours(win, period, rates), operations(win)]);
  const siteUrl = (process.env.URL || '').replace(/\/$/, '');
  return { ...renderEmail(period, win, hours, ops, siteUrl), window: win };
}

module.exports = { buildReport, reportWindow };
