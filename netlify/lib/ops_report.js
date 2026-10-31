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
//   Labor $      — hourly (Connecteam hours × rate) and Hand Trim's trimmer
//                  piece pay (lb weighed × the lot's $/lb) kept apart, then
//                  $/lb per process: each Connecteam activity's hours put on
//                  a station (PROCESS_RULES) over that station's pounds.
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

// Monday of the week a day is in: the weekly report's Mon–Sun week, used for
// week-to-date hours (who's heading past 40).
const weekStart = (day) => addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));

// Which station a Connecteam clock-in's hours count toward for $/lb, by its
// activity (sub-job); first match wins, so Take down ("Descolgar") is tested
// before Hanging ("Colgar"). Hours at a farm site (any job but the ones in
// NOT_FARM) with no activity below are Harvest: people there often clock in
// as Maintenance when they're harvesting. Everything else (Maintenance at
// Adobe, Packaging, Deleafing, …) stays out of $/lb.
const PROCESS_RULES = [
  [/take ?down|descolgar/i, 'dry_check'],
  [/hanging|colgar/i, 'intake_wet'],
  [/bucking|destronchar/i, 'buck'],
  [/smalls/i, 'smalls_trim'],
  [/trimming/i, 'hand_trim'],
  [/twister|machine trim/i, 'machine_trim'],
  [/pre-?rolls?/i, 'preroll_production']
];
const NOT_FARM = /^(adobe|airway|customer|—|)$/i;
function processOf(job, act) {
  const hit = PROCESS_RULES.find(([re]) => re.test(act));
  if (hit) return hit[1];
  if (!NOT_FARM.test(String(job || '').split(' ')[0]) && !/packag/i.test(act)) return 'harvest';
  return null;
}

// California overtime on one person's day: over 8 hrs is time and a half,
// over 12 double time.
const dayOT = (hrs) => ({ ot: Math.max(0, Math.min(hrs, 12) - 8), dt: Math.max(0, hrs - 12) });

// ── Staff hours ─────────────────────────────────────────────────────────────
// `rates` (labor_rates rows, or null to leave cost out): each shift costed
// at the person's rate on that day — straight time only, no overtime premium.
async function staffHours(win, period, rates) {
  const res = await fetch(`${SHIFTS_URL}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`connecteam_shifts.json: HTTP ${res.status}`);
  const data = await res.json();
  const now = Date.now();

  const people = {}, jobs = {}, activities = {}, processes = {};
  const missingClockOut = [];
  const weekFrom = weekStart(win.to), weekHours = {};
  let total = 0, shifts = 0, cost = 0, unratedHours = 0;
  const add = (o, k, hrs, c) => { o[k] = o[k] || { name: k, hours: 0, cost: 0 }; o[k].hours += hrs; o[k].cost += c; };

  (data.shifts || []).forEach((s) => {
    const start = new Date(s.start);
    const day = localDay(start);
    const inWin = day >= win.from && day <= win.to;
    // The daily report also adds up each person's week so far (Monday on).
    const inWeek = period === 'daily' && day >= weekFrom && day <= win.to;
    if (!inWin && !inWeek) return;
    let end = s.end ? new Date(s.end).getTime() : null;
    if (!end) {
      // Still clocked in today counts up to now; an open shift on an earlier
      // day is a forgotten clock-out — listed, not counted.
      if (day < win.today) { if (inWin) missingClockOut.push({ name: s.name, day }); return; }
      end = now;
    }
    const hrs = Math.max(0, (end - start.getTime()) / 3600000);
    if (inWeek) weekHours[s.userId] = (weekHours[s.userId] || 0) + hrs;
    if (!inWin) return;
    const rate = rates ? OpsAnalytics.rateFor(rates, s.userId, day) : null;
    const c = rate != null ? hrs * rate : 0;
    if (rates && rate == null) unratedHours += hrs;
    total += hrs; shifts += 1; cost += c;
    const p = (people[s.userId] = people[s.userId] || { id: s.userId, name: s.name, hours: 0, cost: 0, days: {}, rate: null });
    p.hours += hrs; p.cost += c;
    if (rate != null) p.rate = rate;
    p.days[day] = (p.days[day] || 0) + hrs;
    // "Hanging / Colgar · Esensia" counts as Hanging: the part after the dot
    // is a sub-location, not a different kind of work.
    const act = String(s.activity || '').split(' · ')[0].trim() || '(no activity)';
    const job = s.job || '—';
    add(jobs, job, hrs, c);
    add((jobs[job].acts = jobs[job].acts || {}), act, hrs, c);
    add(activities, act, hrs, c);
    const proc = processOf(job, act === '(no activity)' ? '' : act);
    if (proc) add(processes, proc, hrs, c);
  });

  const byPerson = Object.values(people).map((p) => {
    const dayHrs = Object.values(p.days);
    const maxDay = Math.max(...dayHrs);
    // Overtime hours: past 8 (or 12) on each day; on a week, also anything
    // past 40, whichever is more.
    const daily = dayHrs.reduce((a, h) => { const o = dayOT(h); return { ot: a.ot + o.ot, dt: a.dt + o.dt }; }, { ot: 0, dt: 0 });
    const ot = period === 'weekly' ? Math.max(daily.ot, p.hours - 40 - daily.dt) : daily.ot;
    const dt = daily.dt;
    const flag = period === 'weekly'
      ? (p.hours > 40 ? 'Overtime (40+ hrs)' : maxDay > 8 ? 'Daily overtime' : '')
      : (p.hours > 12 ? 'Double time' : p.hours > 8 ? 'Overtime' : '');
    // The premium on top of straight time (½ rate on OT hours, 1× on DT).
    const premium = p.rate != null ? ot * p.rate * 0.5 + dt * p.rate : 0;
    return { name: p.name, hours: p.hours, cost: p.cost, days: Object.keys(p.days).length, flag, ot, dt, premium,
             week: period === 'daily' ? weekHours[p.id] || p.hours : null };
  }).sort((a, b) => b.hours - a.hours);

  // Daily: everyone already at 32+ hours this week — past 40 by the end of
  // it at another full day.
  const nearForty = period === 'daily'
    ? Object.entries(weekHours).filter(([, h]) => h >= 32).map(([id, h]) => ({ name: (people[id] || {}).name || nameOf(data, id), week: h }))
        .sort((a, b) => b.week - a.week)
    : [];

  const sortHours = (o) => Object.values(o).sort((a, b) => b.hours - a.hours);
  return {
    lastSync: data.last_sync, total, shifts, people: byPerson.length,
    withCost: Boolean(rates), cost, unratedHours,
    byPerson, byActivity: sortHours(activities), missingClockOut,
    byJob: sortHours(jobs).map((j) => ({ ...j, acts: sortHours(j.acts) })),
    processes, weekFrom, nearForty,
    otHours: byPerson.reduce((a, p) => a + p.ot + p.dt, 0),
    otPremium: byPerson.reduce((a, p) => a + p.premium, 0)
  };
}

const nameOf = (data, id) => ((data.shifts || []).find((s) => String(s.userId) === String(id)) || {}).name || id;

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
      // Bucking's recovered from leaf: weighed, but nobody's.
      if (cfg.extra) ((p.fields || {})[cfg.extra.lines] || []).forEach((r) => {
        const day = cfg.dateCol ? String(r[cfg.dateCol] || p.work_date) : p.work_date;
        const v = num(r[cfg.extra.valueCol]);
        if (day < win.from || day > win.to || !v) return;
        lb += v * toLb;
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
    supaGet(`operations_forms?station_key=in.${encodeURIComponent(`(${tallyKeys.join(',')})`)}&work_date=gte.${addDays(win.from, -45)}&work_date=lte.${win.to}&select=id,station_key,status,strain,work_date,submitted_at,fields&limit=10000`)
  ]);
  const weighed = weighedByStation(tallyPages, win);
  const trim = trimming(tallyPages, win);

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
  const lbFor = (k) => { const r = rows.find((x) => x.key === k); return r ? r.lbShown : 0; };
  return { rows, forms: submitted.length, lb: rows.reduce((a, r) => a + r.lbShown, 0), trim, lbFor };
}

// Hand Trim in the window: finished flower weighed (each bag on its own
// day), the trimmers who weighed it, and their piece pay — each bag × its
// page's Trimmer Rate ($/lb); bags on a page with no rate yet are counted
// but not paid. Smalls pulled are the end-of-run weight on pages submitted
// in the window: unfinished smalls, cleaned later on Smalls Hand Trim.
function trimming(pages, win) {
  let lb = 0, pay = 0, unpricedLb = 0, smallsLb = 0;
  const people = new Set();
  pages.filter((p) => p.station_key === 'hand_trim').forEach((p) => {
    const f = p.fields || {};
    const rate = num(f.trimRatePerLb);
    (f.weights || []).forEach((r) => {
      const day = String(r.day || p.work_date);
      const v = num(r.grams) / G_PER_LB;
      if (day < win.from || day > win.to || !v) return;
      lb += v;
      if (rate) pay += v * rate; else unpricedLb += v;
      const who = String(r.employeeNo || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (who) people.add(who);
    });
    const sub = p.status === 'submitted' && p.submitted_at ? localDay(new Date(p.submitted_at)) : null;
    if (sub && sub >= win.from && sub <= win.to) smallsLb += num(f.smallsLb);
  });
  return { lb, pay, unpricedLb, smallsLb, trimmers: people.size };
}

// ── Labor cost ──────────────────────────────────────────────────────────────
// $/hr from the labor_rates table (admin panel → Labor Rates), keyed by
// Connecteam user id with '*' as the default — the same rates and lookup
// (OpsAnalytics.rateFor) the Labor Log's cost reports use.
const laborRates = async () => (await supaGet('labor_rates?select=employee_id,rate,effective_from'))
  .map((r) => ({ employeeId: r.employee_id, rate: Number(r.rate), from: r.effective_from }));

// $/lb per process: the hours Connecteam puts on each station (processOf)
// at their rates, plus trimmer piece pay on Hand Trim, over the station's
// pounds in the window (lbShown: weighed for Bucking / Hand Trim / Smalls,
// else lbs out on submitted forms).
const PROCESS_ORDER = ['harvest', 'intake_wet', 'dry_check', 'buck', 'machine_trim', 'hand_trim', 'smalls_trim', 'preroll_production'];
const PROCESS_LABEL = { harvest: 'Harvest', intake_wet: 'Wet intake & hanging', dry_check: 'Take down', buck: 'Bucking',
  machine_trim: 'Machine trim', hand_trim: 'Hand trim', smalls_trim: 'Smalls trim', preroll_production: 'Pre-rolls' };
function costPerLb(hours, ops) {
  return PROCESS_ORDER.map((k) => {
    const h = hours.processes[k] || { hours: 0, cost: 0 };
    const piece = k === 'hand_trim' ? ops.trim.pay : 0;
    // What's harvested is what comes in wet, so with no Harvest form in the
    // window Harvest is costed over the Wet Intake pounds.
    const lb = ops.lbFor(k) || (k === 'harvest' ? ops.lbFor('intake_wet') : 0);
    const total = h.cost + piece;
    return { key: k, name: PROCESS_LABEL[k], hours: h.hours, hourly: h.cost, piece, total, lb, perLb: lb > 0 && total > 0 ? total / lb : null };
  }).filter((r) => r.hours || r.lb || r.piece);
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

const box = (rows) => `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:0 0 8px;background:#f6f8fa;border:1px solid #e1e4ea;border-radius:6px">${rows.map(([l, v, note, bold]) =>
  `<tr><td style="padding:7px 12px;font-size:14px${bold ? ';font-weight:700;border-top:1px solid #d0d4dc' : ''}">${escapeHtml(l)}${note ? `<div style="font-size:12px;color:#777;font-weight:400">${escapeHtml(note)}</div>` : ''}</td><td style="padding:7px 12px;font-size:${bold ? 17 : 15}px;${NUM}${bold ? ';font-weight:700;border-top:1px solid #d0d4dc' : ''}">${escapeHtml(v)}</td></tr>`).join('')}</table>`;
const fmtUsd2 = (x) => '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function renderEmail(period, win, hours, ops, siteUrl) {
  const title = period === 'weekly' ? 'Weekly Operations & Staff Hours' : 'Daily Operations & Staff Hours';
  const subject = `${title} — ${win.label}`;
  const flagged = hours.byPerson.filter((p) => p.flag);
  // Daily: name everyone past 10 hrs; the 8–10 crowd is a count (they're
  // all in Hours by person).
  const otListed = period === 'daily' ? flagged.filter((p) => p.hours > 10) : flagged;
  const otRest = flagged.length - otListed.length;
  const $col = hours.withCost ? [{ t: 'Labor $', num: true, v: (r) => fmtUsd(r.cost) }] : [];
  const trim = ops.trim;
  const buck = ops.rows.find((r) => r.key === 'buck');
  const smalls = ops.rows.find((r) => r.key === 'smalls_trim' && r.weighed);
  const procs = costPerLb(hours, ops);
  const totalLabor = hours.cost + trim.pay;
  const weekLabel = `since ${prettyDay(hours.weekFrom, { weekday: 'short', month: 'short', day: 'numeric' })}`;

  const laborBox = hours.withCost ? h2('Labor cost') + box([
    ['Hourly staff (Connecteam)', fmtUsd(hours.cost), `${fmt1(hours.total)} clocked hrs × each person's rate, straight time`],
    ['Trimmer piece pay (Hand Trim)', fmtUsd(trim.pay), `${fmt1(trim.lb - trim.unpricedLb)} lb trimmed × each lot's $/lb — trimmers aren't in Connecteam${trim.unpricedLb ? `; ${fmt1(trim.unpricedLb)} lb on lots with no rate yet not counted` : ''}`],
    ['Total labor', fmtUsd(totalLabor), '', true],
    ...(hours.otHours ? [['Overtime premium (not in the total)', fmtUsd(hours.otPremium), `${fmt1(hours.otHours)} hrs past 8 a day${period === 'weekly' ? ' / 40 a week' : ''}: the extra ½ (or 1× past 12) on top of straight time`]] : [])
  ]) : '';

  const otCols = [
    { t: 'Name', v: (r) => r.name },
    { t: 'Hours', num: true, v: (r) => fmt1(r.hours) },
    { t: 'OT hrs', num: true, v: (r) => (r.ot + r.dt ? fmt1(r.ot + r.dt) : '') },
    ...(period === 'daily' ? [{ t: 'Week so far', num: true, v: (r) => fmt1(r.week) }] : []),
    ...(hours.withCost ? [{ t: 'OT premium', num: true, v: (r) => (r.premium ? fmtUsd(r.premium) : '') }] : []),
    { t: '', v: (r) => r.flag }
  ];
  const overtime = (flagged.length ? h2(`Overtime — ${flagged.length} ${flagged.length === 1 ? 'person' : 'people'}, ${fmt1(hours.otHours)} OT hrs`) +
      (period === 'daily' ? `<p style="font-size:14px;margin:0 0 10px">${otListed.length} over 10 hrs${otRest ? `, ${otRest} more between 8 and 10 hrs` : ''}.${otListed.length ? ' Over 10:' : ''}</p>` : '') +
      (otListed.length ? table(otCols, otListed) : '') : '') +
    (hours.nearForty.length ? h2(`Heading past 40 hrs this week (${weekLabel})`) + table([{ t: 'Name', v: (r) => r.name }, { t: 'Hours this week', num: true, v: (r) => fmt1(r.week) }, { t: 'Left before 40', num: true, v: (r) => (r.week >= 40 ? 'over' : fmt1(40 - r.week)) }], hours.nearForty) : '');

  const procCols = [
    { t: 'Process', v: (r) => r.name },
    { t: 'Lbs', num: true, v: (r) => (r.lb ? fmt1(r.lb) : '—') },
    { t: 'Hours', num: true, v: (r) => (r.hours ? fmt1(r.hours) : '') },
    ...(hours.withCost ? [
      { t: 'Hourly $', num: true, v: (r) => (r.hourly ? fmtUsd(r.hourly) : '') },
      { t: 'Trimmer pay $', num: true, v: (r) => (r.piece ? fmtUsd(r.piece) : '') },
      { t: '$ / lb', num: true, html: true, v: (r) => (r.perLb != null ? `<b>${escapeHtml(fmtUsd2(r.perLb))}</b>` : '—') }
    ] : [{ t: 'Lbs / hr', num: true, v: (r) => (r.lb && r.hours ? fmt1(r.lb / r.hours) : '—') }])
  ];

  // Smalls trimmers are hourly (Connecteam "Smalls"): no piece pay.
  const smallsCost = (hours.processes.smalls_trim || { cost: 0 }).cost;
  const trimBox = (trim.lb || trim.smallsLb || smalls || buck) ? h2('Trimming & bucking') + box([
    ['Finished flower trimmed', `${fmt1(trim.lb)} lb`, `${trim.trimmers} trimmer${trim.trimmers === 1 ? '' : 's'} weighed in${trim.trimmers ? ` · ${fmt1(trim.lb / trim.trimmers)} lb each` : ''}`],
    ...(hours.withCost && trim.lb ? [['Trimming cost per lb', fmtUsd2((trim.pay + (hours.processes.hand_trim || { cost: 0 }).cost) / trim.lb), `piece pay ${fmtUsd(trim.pay)} + hourly on Trimming ${fmtUsd((hours.processes.hand_trim || { cost: 0 }).cost)}`]] : []),
    ['Unfinished smalls pulled', `${fmt1(trim.smallsLb)} lb`, 'end-of-run weight on Hand Trim lots finished in this period; cleaned later on Smalls Hand Trim'],
    ...(smalls ? [['Finished smalls trimmed', `${fmt1(smalls.lbShown)} lb`, `Smalls Hand Trim, ${smalls.weighed.people} trimmer${smalls.weighed.people === 1 ? '' : 's'} weighed in${smalls.weighed.people ? ` · ${fmt1(smalls.lbShown / smalls.weighed.people)} lb each` : ''}${hours.withCost && smallsCost ? ` · ${fmtUsd2(smallsCost / smalls.lbShown)}/lb hourly on Smalls` : ''}`]] : []),
    ...(buck ? [['Bucked flower produced', `${fmt1(buck.lbShown)} lb`, `${buck.weighed ? buck.weighed.people : 0} buckers weighed in`]] : [])
  ]) : '';

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;color:#222">
<h1 style="font-size:21px;margin:0 0 4px">${escapeHtml(title)}</h1>
<div style="color:#666;font-size:14px;margin-bottom:12px">${escapeHtml(win.label)}</div>
<table cellspacing="0" cellpadding="0"><tr>
${stat('staff hours (Connecteam)', fmt1(hours.total))}${hours.withCost ? stat('total labor (hourly + trimmers)', fmtUsd(totalLabor)) : ''}${stat('people', String(hours.people))}${stat('lbs worked', fmt1(ops.lb))}${stat('forms submitted', String(ops.forms))}
</tr></table>

${laborBox}

${h2(hours.withCost ? 'Cost per pound by process' : 'Pounds and hours by process')}
${table(procCols, procs)}
<p style="color:#888;font-size:12px;margin:-12px 0 0">Hours come from each Connecteam clock-in's activity: Hanging → wet intake, Take down, Bucking, Trimming → hand trim, Smalls, Twister → machine trim, Pre-rolls. Any hours at a farm site (not Adobe or Airway) are Harvest, whatever activity was picked, costed over the Harvest forms' pounds or, with none, the Wet Intake pounds. Maintenance, Deleafing, Packaging and the rest at Adobe aren't in a process. Lbs as in Operations by station below.</p>

${trimBox}

${overtime}

${h2('Operations by station')}
${table([
    { t: 'Station', v: (r) => r.title },
    { t: 'Lbs', num: true, v: (r) => (r.lbShown ? fmt1(r.lbShown) : '—') },
    { t: 'People', num: true, v: (r) => (r.weighed ? String(r.weighed.people) : '') },
    { t: 'Submitted', num: true, v: (r) => String(r.forms) },
    { t: 'Open now', num: true, v: (r) => (r.open ? String(r.open) : '') },
    { t: 'Strains', v: (r) => r.strains.slice(0, 4).join(', ') + (r.strains.length > 4 ? ` +${r.strains.length - 4}` : '') }
  ], ops.rows)}
<p style="color:#888;font-size:12px;margin:-12px 0 0">Bucking, hand trim and smalls hand trim: pounds weighed in this period on every page, finished or still open (the forms' Daily Summary). Other stations: pounds out on submitted forms.</p>

${h2('Labor by site and activity')}
${siteActivityTable(hours.byJob, hours.withCost)}

${h2('Hours by activity')}
${table([{ t: 'Activity', v: (r) => r.name }, { t: 'Hours', num: true, v: (r) => fmt1(r.hours) }, ...$col], hours.byActivity)}

${hours.missingClockOut.length ? h2('Missing clock-outs') + table([{ t: 'Name', v: (r) => r.name }, { t: 'Day', v: (r) => prettyDay(r.day, { weekday: 'short', month: 'short', day: 'numeric' }) }], hours.missingClockOut) : ''}

${h2('Hours by person')}
${table([
    { t: 'Name', v: (r) => r.name },
    ...(period === 'weekly' ? [{ t: 'Days', num: true, v: (r) => String(r.days) }] : []),
    { t: 'Hours', num: true, v: (r) => fmt1(r.hours) },
    ...$col
  ], hours.byPerson)}

<p style="color:#888;font-size:12px;margin-top:28px">Hours from Connecteam (last synced ${escapeHtml(new Date(hours.lastSync).toLocaleString('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }))}); operations from station forms.${hours.withCost ? ` Hourly $ is hours × each person's rate (admin → Labor Rates), straight time only: the overtime premium is shown on its own.${hours.unratedHours ? ` ${fmt1(hours.unratedHours)} hrs had no rate and aren't costed.` : ''} Trimmer pay is each Hand Trim bag × its lot's Trimmer Rate ($/lb).` : ''}
${siteUrl ? `<a href="${escapeHtml(siteUrl)}/operations_dashboard.html" style="color:#0a8f78">Operations dashboard</a> · <a href="${escapeHtml(siteUrl)}/staff_hours.html" style="color:#0a8f78">Staff hours</a>` : ''}</p>
</div>`;

  const text = [
    `${title} — ${win.label}`, '',
    `Staff hours (Connecteam): ${fmt1(hours.total)} (${hours.people} people)`,
    ...(hours.withCost ? [
      `Labor cost:`,
      `  Hourly staff (Connecteam): ${fmtUsd(hours.cost)} (straight time)`,
      `  Trimmer piece pay: ${fmtUsd(trim.pay)} (${fmt1(trim.lb - trim.unpricedLb)} lb × lot $/lb)`,
      `  Total labor: ${fmtUsd(totalLabor)}`,
      ...(hours.otHours ? [`  Overtime premium (not in total): ${fmtUsd(hours.otPremium)} on ${fmt1(hours.otHours)} OT hrs`] : [])] : []),
    `Lbs worked: ${fmt1(ops.lb)} · Forms submitted: ${ops.forms}`, '',
    ...(flagged.length ? [`Overtime: ${flagged.length} people, ${fmt1(hours.otHours)} OT hrs${otRest ? ` (${otRest} between 8 and 10 hrs; over 10:)` : ''}`, ...otListed.map((r) => `  ${r.name}: ${fmt1(r.hours)} hrs, ${fmt1(r.ot + r.dt)} OT${r.week != null ? `, ${fmt1(r.week)} this week` : ''} (${r.flag})`), ''] : []),
    ...(hours.nearForty.length ? [`Heading past 40 hrs this week (${weekLabel}):`, ...hours.nearForty.map((r) => `  ${r.name}: ${fmt1(r.week)} hrs`), ''] : []),
    hours.withCost ? 'Cost per pound by process:' : 'Pounds and hours by process:',
    ...procs.map((r) => `  ${r.name}: ${r.lb ? `${fmt1(r.lb)} lb` : '— lb'}, ${fmt1(r.hours)} hrs${hours.withCost ? `, ${fmtUsd(r.total)}${r.perLb != null ? ` = ${fmtUsd2(r.perLb)}/lb` : ''}` : ''}`), '',
    `Trimming: ${fmt1(trim.lb)} lb finished flower by ${trim.trimmers} trimmers · unfinished smalls pulled ${fmt1(trim.smallsLb)} lb${smalls ? ` · finished smalls ${fmt1(smalls.lbShown)} lb by ${smalls.weighed.people} trimmers` : ''}${buck ? ` · bucked ${fmt1(buck.lbShown)} lb` : ''}`, '',
    'Operations by station:',
    ...ops.rows.map((r) => `  ${r.title}: ${r.lbShown ? `${fmt1(r.lbShown)} lb, ` : ''}${r.forms} submitted${r.open ? `, ${r.open} open` : ''}`), '',
    'Labor by site and activity:', ...hours.byJob.flatMap((j) => [
      `  ${j.name}: ${fmt1(j.hours)} hrs${hours.withCost ? ` (${fmtUsd(j.cost)})` : ''}`,
      ...j.acts.map((a) => `      ${a.name}: ${fmt1(a.hours)} hrs${hours.withCost ? ` (${fmtUsd(a.cost)})` : ''}`)]), '',
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
