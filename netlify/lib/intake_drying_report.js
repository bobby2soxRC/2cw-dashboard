// Intake & Drying report: what came in (by farm, with strain and room), what
// is in each drying room right now and for how long, and how full each room
// and the whole facility is. One builder shared by everything that produces
// it, so the numbers always agree:
//   - netlify/functions/intake-drying-report-daily.js  (7 pm email)
//   - netlify/functions/admin.js                       (Reports tab: preview, send now, drying rooms)
//   - scripts/intake_drying_report.js                  (the /intake-drying-report Claude skill)
// See docs/REPORTS.md.
//
// Sources (Supabase operations_forms):
//   intake_wet  Harvest Intake — Wet. Net lb per weigh-in row = weight −
//               binCount × tareEachLb (the form's Total Wet Weight). Farm (pid)
//               and drying room (dryRoom) are per intake; strain per row.
//   dry_check   Take Down — Dry. A submitted one whose incomingUid matches an
//               intake's farm UID takes that intake out of its room.
// An intake is also out of its room once fields.takenDownAt is set — the
// admin panel's "Mark taken down", for take-downs never entered in the app.
// Room capacities: data/operations/reference.json dryRooms[].capacityLb.
// In-progress (draft) intakes count as entered so far and are flagged.

const reference = require('../../data/operations/reference.json');

const TZ = 'America/Los_Angeles';

// ── Dates ──────────────────────────────────────────────────────────────────
// The business day in California, YYYY-MM-DD — what work_date holds.
function pacificDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function pacificHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(d));
}
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 864e5);
const longDate = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const shortDate = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const rangeLabel = (from, to) => from === to ? longDate(from) : `${longDate(from)} – ${longDate(to)}`;

// ── Fetch ──────────────────────────────────────────────────────────────────
// `key` is the service role key server-side, or the public anon key from the
// skill's script (anon can read operations_forms and ref_codes).
async function rest(supaUrl, key, path) {
  const res = await fetch(`${supaUrl}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Supabase ${path.split('?')[0]}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Every intake (any date — anything not taken down is still in a room), every
// submitted take-down's farm UID, and farm names.
async function fetchData(supaUrl, key) {
  const [intakes, takeDowns, codes] = await Promise.all([
    rest(supaUrl, key, 'operations_forms?station_key=eq.intake_wet&select=id,status,work_date,owner_user,submitted_at,fields&order=work_date.asc,submitted_at.asc'),
    rest(supaUrl, key, 'operations_forms?station_key=eq.dry_check&status=eq.submitted&select=work_date,incomingUid:fields->>incomingUid'),
    rest(supaUrl, key, 'ref_codes?kind=eq.pid&select=code,name').catch(() => [])
  ]);
  return { intakes, takeDowns, codes };
}

// ── Build ──────────────────────────────────────────────────────────────────
const num = (x) => { const v = Number(x); return Number.isFinite(v) ? v : 0; };
const blank = (x) => x === undefined || x === null || x === '';
const uniq = (arr) => [...new Set(arr)];

// Crews write the last 4–5 of a Metrc tag as often as the whole thing, on
// either form — so match when one ends with the other (ops_common.js uidMatches).
const normUid = (u) => String(u || '').toUpperCase().replace(/\s/g, '');
function uidsMatch(a, b) {
  const x = normUid(a), y = normUid(b);
  if (x.length < 4 || y.length < 4) return false;
  return x === y || x.endsWith(y) || y.endsWith(x);
}

function labelers(codes) {
  // Farm: "Sulphur Bank: 167", like the forms show it (ops_common.js refCodeLabel).
  const farmNames = new Map((reference.properties || []).map((p) => [String(p.pid), p.farm || p.label]));
  for (const c of codes || []) if (c.name) farmNames.set(String(c.code), c.name);
  const rooms = new Map((reference.dryRooms || []).map((r) => [String(r.id), r]));
  return {
    farm: (pid) => blank(pid) ? '(no farm)' : farmNames.has(String(pid)) ? `${farmNames.get(String(pid))}: ${pid}` : String(pid),
    room: (id) => blank(id) ? '(no room)' : (rooms.get(String(id)) || {}).label || String(id)
  };
}

function group(lines, keyFn) {
  const m = new Map();
  for (const l of lines) {
    const k = keyFn(l);
    if (!m.has(k)) m.set(k, { key: k, lb: 0, bins: 0, lines: [], draftLb: 0 });
    const g = m.get(k);
    g.lb += l.lb; g.bins += l.bins; g.lines.push(l);
    if (l.draft) g.draftLb += l.lb;
  }
  return [...m.values()].sort((a, b) => b.lb - a.lb);
}

// One intake record → its weigh-in rows with net lb, skipping empty rows.
function intakeLines(r, L) {
  const f = r.fields || {};
  const farm = L.farm(f.pid), room = L.room(f.dryRoom), draft = r.status === 'draft';
  return (f.lines || []).filter((ln) => !(blank(ln.weight) && blank(ln.binCount))).map((ln) => ({
    farm, room, draft,
    strain: blank(ln.strain) ? (f.strain || '(no strain)') : String(ln.strain),
    uid: ln.sourceUid || f.sourceUid || '',
    lb: num(ln.weight) - num(ln.binCount) * num(ln.tareEachLb),
    bins: num(ln.binCount)
  }));
}

// intakes/takeDowns/codes as from fetchData; from/to bound the intake section.
function buildReport({ intakes, takeDowns, codes, from, to, today = pacificDate() }) {
  const L = labelers(codes);

  // ── What came in, from..to
  const inRange = intakes.filter((r) => r.work_date >= from && r.work_date <= to);
  const lines = inRange.flatMap((r) => intakeLines(r, L));
  const received = {
    totalLb: lines.reduce((a, l) => a + l.lb, 0),
    draftLb: lines.filter((l) => l.draft).reduce((a, l) => a + l.lb, 0),
    bins: lines.reduce((a, l) => a + l.bins, 0),
    intakeCount: inRange.length,
    draftCount: inRange.filter((r) => r.status === 'draft').length,
    packages: uniq(lines.map((l) => l.uid).filter(Boolean)).length,
    trucks: uniq(inRange.map((r) => (r.fields || {}).manifestNo).filter(Boolean)).length,
    farms: group(lines, (l) => l.farm).map((g) => ({
      ...g,
      rooms: group(g.lines, (l) => l.room),
      strainRooms: group(g.lines, (l) => `${l.strain}\u0000${l.room}`).map((x) => ({ ...x, strain: x.lines[0].strain, room: x.lines[0].room }))
    }))
  };

  // ── What's in each room now
  const tdUids = takeDowns.map((t) => t.incomingUid).filter(Boolean);
  const packages = [];
  for (const r of intakes) {
    const f = r.fields || {};
    if (f.takenDownAt) continue;
    const ls = intakeLines(r, L);
    const uids = uniq([f.sourceUid, ...(f.lines || []).map((x) => x.sourceUid)].filter(Boolean));
    if (uids.length && uids.every((u) => tdUids.some((t) => uidsMatch(t, u)))) continue;
    const lb = ls.reduce((a, l) => a + l.lb, 0);
    if (!ls.length && !lb) continue;
    packages.push({
      id: r.id, status: r.status, draft: r.status === 'draft',
      roomId: blank(f.dryRoom) ? '' : String(f.dryRoom), room: L.room(f.dryRoom),
      farm: L.farm(f.pid), strains: uniq(ls.map((l) => l.strain)).join(', '), uids: uids.join(', '),
      lb, bins: ls.reduce((a, l) => a + l.bins, 0),
      since: r.work_date, days: Math.max(0, daysBetween(r.work_date, today))
    });
  }
  packages.sort((a, b) => a.since.localeCompare(b.since) || b.lb - a.lb);

  const roomDefs = (reference.dryRooms || []).filter((r) => r.active !== false);
  const rooms = roomDefs.map((def) => {
    const pk = packages.filter((p) => p.roomId === String(def.id));
    const lb = pk.reduce((a, p) => a + p.lb, 0);
    const cap = num(def.capacityLb) || null;
    return {
      id: def.id, room: def.label, capacityLb: cap, lb, freeLb: cap === null ? null : cap - lb, pct: cap ? lb / cap : null,
      packages: pk, oldestDays: pk.length ? Math.max(...pk.map((p) => p.days)) : null,
      farmNames: uniq(pk.map((p) => p.farm)), strainNames: uniq(pk.flatMap((p) => p.strains.split(', ')).filter(Boolean))
    };
  });
  // Intakes logged to a room that isn't on the active list (old "Room 2", a typed-in name, none).
  const known = new Set(roomDefs.map((d) => String(d.id)));
  const elsewhere = group(packages.filter((p) => !known.has(p.roomId)).map((p) => ({ ...p, bins: p.bins })), (p) => p.room)
    .map((g) => ({ id: null, room: g.key, capacityLb: null, lb: g.lb, freeLb: null, pct: null, packages: g.lines,
      oldestDays: Math.max(...g.lines.map((p) => p.days)), farmNames: uniq(g.lines.map((p) => p.farm)),
      strainNames: uniq(g.lines.flatMap((p) => p.strains.split(', ')).filter(Boolean)) }));
  const capacityLb = rooms.reduce((a, r) => a + (r.capacityLb || 0), 0);
  const inRoomsLb = rooms.reduce((a, r) => a + r.lb, 0);
  const drying = {
    capacityLb, inRoomsLb, pct: capacityLb ? inRoomsLb / capacityLb : null, freeLb: capacityLb - inRoomsLb,
    elsewhereLb: elsewhere.reduce((a, r) => a + r.lb, 0),
    packageCount: packages.length, rooms, elsewhere,
    roomsInUse: rooms.filter((r) => r.packages.length).length
  };

  return { from, to, today, received, drying };
}

// Fetch + build in one call: what the server functions use.
async function intakeDryingReport(supaUrl, key, { from, to, today = pacificDate() }) {
  const data = await fetchData(supaUrl, key);
  return buildReport({ ...data, from, to, today });
}

// ── Render ─────────────────────────────────────────────────────────────────
const fmt = (x, dp = 1) => num(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pctOf = (x, total) => total ? `${fmt(100 * x / total, 1)}%` : '—';
const pctStr = (p) => p === null || p === undefined ? '—' : `${fmt(100 * p, 0)}%`;
const daysStr = (d) => d === null || d === undefined ? '—' : d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'}`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function subjectLine(rep) {
  const d = rep.drying;
  return `Intake & Drying — ${rangeLabel(rep.from, rep.to)} — ${fmt(rep.received.totalLb, 0)} lb in · rooms ${pctStr(d.pct)} full`;
}

// Email HTML: inline styles and plain tables, since mail apps drop <style>
// and most CSS. Light background so it reads in any inbox.
function renderHtml(rep, { siteUrl } = {}) {
  const C = { text: '#1d2129', muted: '#6b7280', line: '#e5e7eb', head: '#f3f4f6', green: '#15803d', gold: '#a16207', red: '#b91c1c', barBg: '#e5e7eb' };
  const td = (v, n, extra = '') => `<td style="padding:6px 10px;border-bottom:1px solid ${C.line};vertical-align:top;${n ? 'text-align:right;white-space:nowrap;' : ''}${extra}">${v}</td>`;
  const th = (v, n) => `<th style="padding:6px 10px;background:${C.head};border-bottom:1px solid ${C.line};font-size:12px;color:${C.muted};font-weight:600;${n ? 'text-align:right;' : 'text-align:left;'}">${v}</th>`;
  const table = (heads, rows, foot = '') => `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px;margin:6px 0 18px">` +
    `<tr>${heads.map(([h, n]) => th(h, n)).join('')}</tr>${rows.join('')}${foot}</table>`;
  const h2 = (t) => `<h2 style="font-size:18px;margin:28px 0 6px;color:${C.text};border-bottom:2px solid ${C.text};padding-bottom:4px">${t}</h2>`;
  const h3 = (t) => `<h3 style="font-size:15px;margin:16px 0 4px;color:${C.text}">${t}</h3>`;
  const ip = (g) => g.draftLb ? ` <span style="color:${C.gold};font-size:12px">(${fmt(g.draftLb, 0)} lb in progress)</span>` : '';
  const totRow = (cells) => `<tr>${cells.map(([v, n]) => `<td style="padding:6px 10px;font-weight:700;border-top:2px solid ${C.text};${n ? 'text-align:right;' : ''}">${v}</td>`).join('')}</tr>`;
  const kpi = (label, value, note = '') => `<td style="padding:10px 14px;border:1px solid ${C.line};vertical-align:top">
    <div style="font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.06em">${label}</div>
    <div style="font-size:20px;font-weight:700;margin-top:2px">${value}</div>${note ? `<div style="font-size:11px;color:${C.muted}">${note}</div>` : ''}</td>`;
  const fillColor = (p) => p === null ? C.muted : p >= 1 ? C.red : p >= 0.85 ? C.gold : C.green;
  const bar = (p) => p === null ? '' : `<div style="background:${C.barBg};height:8px;width:56px;border-radius:4px;overflow:hidden;display:inline-block;vertical-align:middle;margin-right:6px">` +
    `<div style="background:${fillColor(p)};height:8px;width:${Math.min(100, Math.round(100 * p))}%"></div></div>`;

  const R = rep.received, D = rep.drying;

  const receivedHtml = !R.intakeCount ? `<p style="color:${C.muted}">No wet intakes were recorded.</p>` : `
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:10px 0 4px"><tr>
      ${kpi('Wet weight received', `${fmt(R.totalLb, 1)} lb`, 'net of bin tare')}
      ${kpi('Farms', R.farms.length)}
      ${kpi('Trucks', R.trucks || '—')}
      ${kpi('Packages', R.packages)}
      ${kpi('Bins', fmt(R.bins, 0))}
    </tr></table>
    ${R.draftCount ? `<p style="color:${C.gold};font-size:13px;margin:6px 0">${R.draftCount} intake${R.draftCount === 1 ? ' is' : 's are'} still being entered (${fmt(R.draftLb, 1)} lb so far) — counted as entered so far.</p>` : ''}
    ${R.farms.map((f) => `
      ${h3(`${esc(f.key)} — <span style="color:${C.green}">${fmt(f.lb, 1)} lb</span> <span style="color:${C.muted};font-weight:400">(${pctOf(f.lb, R.totalLb)} · ${fmt(f.bins, 0)} bins)</span>${ip(f)}`)}
      ${table([['Strain'], ['Room'], ['Bins', 1], ['Net lb', 1]],
        f.strainRooms.map((g) => `<tr>${td(esc(g.strain) + ip(g))}${td(esc(g.room))}${td(fmt(g.bins, 0), 1)}${td(fmt(g.lb, 1), 1)}</tr>`))}`).join('')}`;

  const roomRow = (r) => `<tr>${td(`<b>${esc(r.room)}</b>`, 0, 'white-space:nowrap;')}${td(r.lb ? fmt(r.lb, 0) : '—', 1)}${td(r.capacityLb ? fmt(r.capacityLb, 0) : '—', 1)}` +
    `${td(bar(r.pct) + `<span style="color:${fillColor(r.pct)};font-weight:600">${pctStr(r.pct)}</span>`, 1)}` +
    `${td(r.freeLb === null ? '—' : r.freeLb < 0 ? `<span style="color:${C.red}">over by ${fmt(-r.freeLb, 0)}</span>` : fmt(r.freeLb, 0), 1)}` +
    `${td(r.packages.length || '—', 1)}${td(daysStr(r.oldestDays), 1)}${td(esc(r.farmNames.join(', ')) || '<span style="color:#9ca3af">empty</span>')}</tr>`;

  const roomDetail = (r) => !r.packages.length ? '' : `
    ${h3(`${esc(r.room)} — ${fmt(r.lb, 0)} lb${r.capacityLb ? ` of ${fmt(r.capacityLb, 0)} (${pctStr(r.pct)})` : ''}`)}
    ${table([['Farm'], ['Strain'], ['Package UID'], ['In since'], ['Days in', 1], ['Net lb', 1]],
      r.packages.map((p) => `<tr>${td(esc(p.farm))}${td(esc(p.strains || '—'))}${td(esc(p.uids || '—'))}${td(esc(shortDate(p.since)))}` +
        `${td(daysStr(p.days), 1, p.days === r.oldestDays && r.packages.length > 1 ? 'font-weight:700;' : '')}${td(fmt(p.lb, 1) + (p.draft ? ` <span style="color:${C.gold};font-size:11px">being entered</span>` : ''), 1)}</tr>`))}`;

  const dryingHtml = `
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:10px 0 4px"><tr>
      ${kpi('Facility capacity used', `<span style="color:${fillColor(D.pct)}">${pctStr(D.pct)}</span>`, `${fmt(D.inRoomsLb, 0)} of ${fmt(D.capacityLb, 0)} lb`)}
      ${kpi('Free capacity', `${fmt(Math.max(0, D.freeLb), 0)} lb`, `≈ ${fmt(Math.max(0, D.freeLb) / 2100, 1)} trucks`)}
      ${kpi('Rooms in use', `${D.roomsInUse} / ${D.rooms.length}`)}
      ${kpi('Packages drying', D.packageCount)}
    </tr></table>
    ${table([['Room'], ['In room (lb)', 1], ['Capacity', 1], ['Full', 1], ['Free (lb)', 1], ['Pkgs', 1], ['Oldest', 1], ['Farms']],
      D.rooms.map(roomRow),
      totRow([['Facility'], [fmt(D.inRoomsLb, 0), 1], [fmt(D.capacityLb, 0), 1], [pctStr(D.pct), 1], [fmt(D.freeLb, 0), 1], [D.rooms.reduce((a, r) => a + r.packages.length, 0), 1], [''], ['']]))}
    ${D.elsewhere.length ? `<p style="color:${C.gold};font-size:13px">Also ${fmt(D.elsewhereLb, 0)} lb logged to a room not on the room list (${D.elsewhere.map((r) => esc(r.room)).join(', ')}) — not counted in capacity. Fix the intake's Drying Location in Harvest Intakes, or move it from the admin panel's Reports tab.</p>` : ''}
    ${[...D.rooms, ...D.elsewhere].map(roomDetail).join('')}`;

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C.text};max-width:800px">
    <h1 style="font-size:22px;margin:0 0 2px">Intake &amp; Drying Report</h1>
    <div style="color:${C.muted};font-size:14px">${esc(rangeLabel(rep.from, rep.to))}</div>
    ${h2(rep.from === rep.to && rep.to === rep.today ? 'Received today' : 'Received')}
    ${receivedHtml}
    ${h2('Drying rooms now')}
    ${dryingHtml}
    <p style="color:${C.muted};font-size:12px;margin-top:22px;border-top:1px solid ${C.line};padding-top:10px">
      Weights are net of bin tare, from each weigh-in row on Harvest Intake — Wet. A package stays in its room from intake
      until a Take Down — Dry form is submitted for its farm UID (or it's marked taken down in the admin panel). Days in room
      count from the intake date. Capacity: hoops-based estimate per room; Room 2A–2D split evenly for now.
      ${siteUrl ? `Full records: <a href="${esc(siteUrl)}/harvest_intakes.html">Harvest Intakes</a>.` : ''}
      To stop getting this email, ask a 2CW admin to remove you from the report list.
    </p></div>`;
}

function renderText(rep) {
  const R = rep.received, D = rep.drying;
  const out = [`INTAKE & DRYING REPORT — ${rangeLabel(rep.from, rep.to)}`, '', 'RECEIVED'];
  if (!R.intakeCount) out.push('No wet intakes were recorded.');
  else {
    out.push(`Total: ${fmt(R.totalLb, 1)} lb net · ${R.farms.length} farms · ${R.trucks} trucks · ${R.packages} packages · ${fmt(R.bins, 0)} bins`);
    if (R.draftCount) out.push(`${R.draftCount} still being entered (${fmt(R.draftLb, 1)} lb so far).`);
    for (const f of R.farms) {
      out.push(`${f.key}: ${fmt(f.lb, 1)} lb (${pctOf(f.lb, R.totalLb)})`);
      for (const g of f.strainRooms) out.push(`  ${g.strain} — ${g.room}: ${fmt(g.lb, 1)} lb`);
    }
  }
  out.push('', `DRYING ROOMS NOW — facility ${pctStr(D.pct)} full (${fmt(D.inRoomsLb, 0)} of ${fmt(D.capacityLb, 0)} lb)`);
  for (const r of [...D.rooms, ...D.elsewhere]) {
    out.push(`${r.room}: ${fmt(r.lb, 0)} lb${r.capacityLb ? ` / ${fmt(r.capacityLb, 0)} (${pctStr(r.pct)})` : ''}${r.packages.length ? ` · ${r.packages.length} pkgs · oldest ${daysStr(r.oldestDays)}` : ' · empty'}`);
    for (const p of r.packages) out.push(`  ${p.farm} · ${p.strains} · ${p.uids || '—'} · in since ${shortDate(p.since)} (${daysStr(p.days)}) · ${fmt(p.lb, 1)} lb`);
  }
  return out.join('\n');
}

// Markdown for the /intake-drying-report skill to show in chat.
function renderMarkdown(rep) {
  const R = rep.received, D = rep.drying;
  const cell = (s) => String(s).replace(/\|/g, '\\|');
  const tbl = (heads, rows) => [`| ${heads.join(' | ')} |`, `|${heads.map((h) => /lb|%|Bins|Days|Pkgs|Full|Capacity|Oldest/.test(h) ? '---:' : '---').join('|')}|`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
  const ip = (g) => g.draftLb ? ` *(${fmt(g.draftLb, 0)} lb in progress)*` : '';
  const out = [`## Intake & Drying — ${rangeLabel(rep.from, rep.to)}`, '', '### Received', ''];
  if (!R.intakeCount) out.push('No wet intakes were recorded.');
  else {
    out.push(`**${fmt(R.totalLb, 1)} lb** net · ${R.farms.length} farms · ${R.trucks} trucks · ${R.packages} packages · ${fmt(R.bins, 0)} bins`);
    if (R.draftCount) out.push('', `${R.draftCount} intake(s) still being entered, ${fmt(R.draftLb, 1)} lb so far — included as entered so far.`);
    for (const f of R.farms) {
      out.push('', `**${f.key}** — ${fmt(f.lb, 1)} lb (${pctOf(f.lb, R.totalLb)}, ${fmt(f.bins, 0)} bins)${ip(f)}`, '',
        tbl(['Strain', 'Room', 'Bins', 'Net lb'], f.strainRooms.map((g) => [g.strain + ip(g), g.room, fmt(g.bins, 0), fmt(g.lb, 1)])));
    }
  }
  out.push('', `### Drying rooms now — facility ${pctStr(D.pct)} full`, '',
    `${fmt(D.inRoomsLb, 0)} of ${fmt(D.capacityLb, 0)} lb · ${fmt(Math.max(0, D.freeLb), 0)} lb free · ${D.roomsInUse}/${D.rooms.length} rooms in use · ${D.packageCount} packages`, '',
    tbl(['Room', 'In room lb', 'Capacity', 'Full', 'Free lb', 'Pkgs', 'Oldest', 'Farms'],
      [...D.rooms, ...D.elsewhere].map((r) => [r.room, r.lb ? fmt(r.lb, 0) : '—', r.capacityLb ? fmt(r.capacityLb, 0) : '—', pctStr(r.pct),
        r.freeLb === null ? '—' : fmt(r.freeLb, 0), r.packages.length || '—', daysStr(r.oldestDays), r.farmNames.join(', ') || 'empty'])));
  for (const r of [...D.rooms, ...D.elsewhere].filter((x) => x.packages.length)) {
    out.push('', `**${r.room}** — ${fmt(r.lb, 0)} lb`, '',
      tbl(['Farm', 'Strain', 'Package UID', 'In since', 'Days in', 'Net lb'],
        r.packages.map((p) => [p.farm, p.strains || '—', p.uids || '—', shortDate(p.since), daysStr(p.days), fmt(p.lb, 1) + (p.draft ? ' *(being entered)*' : '')])));
  }
  return out.join('\n');
}

module.exports = {
  pacificDate, pacificHour, addDays, rangeLabel,
  fetchData, buildReport, intakeDryingReport,
  subjectLine, renderHtml, renderText, renderMarkdown
};
