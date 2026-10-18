#!/usr/bin/env node
// Hourly Labor Log auto-assign for people checked in on Crew Check-In
// (crew_checkin.html). Runs in the Connecteam Hourly Sync workflow, right
// after data/connecteam_shifts.json is refreshed.
//
// For today and yesterday (Pacific — run with TZ=America/Los_Angeles), each
// stretch someone was clocked in with no Labor Log entry covering it goes to
// their project the same way the Labor Log Timeline's "Auto-assign
// scheduled" button does (autoPlan in labor_auto.js), with two limits:
//   - only projects they're checked in on that day (a lead marked them Here,
//     added them, or moved them there), and
//   - only shifts they've clocked out of, so a move a lead records later in
//     the day still splits the time.
// Each entry is a normal labor_entry row, enteredBy "Auto-assign (Crew
// Check-In)"; it shows in the Labor Log and can be removed there like any
// other. Running again finds nothing new, because the time is logged.
//
// Env: SUPABASE_URL (defaults to the project's), SUPABASE_SERVICE_ROLE_KEY.
// DRY_RUN=1 prints the plan without writing. DAYS=n looks back n days
// (default 2: today and yesterday). SHIFTS_FILE overrides the clock-in file.

const fs = require('fs');
const path = require('path');
const LA = require('../labor_auto.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ugtxmyciyuelxxzqmrdx.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DRY = !!process.env.DRY_RUN;
const DAYS = Math.max(1, Number(process.env.DAYS) || 2);
const BY = 'Auto-assign (Crew Check-In)';

const localDay = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localDay(d); };

async function rest(pathQ, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathQ}`, {
    ...opts,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) }
  });
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${pathQ.split('?')[0]}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  if (!KEY) { console.log('SUPABASE_SERVICE_ROLE_KEY not set — skipping.'); return; }
  const shiftFile = process.env.SHIFTS_FILE || path.join(__dirname, '..', 'data', 'connecteam_shifts.json');
  const shiftData = JSON.parse(fs.readFileSync(shiftFile, 'utf8'));
  const shifts = shiftData.shifts || [];
  const projects = (await rest('operations_forms?select=id,fields&station_key=eq.work_project&status=eq.submitted'))
    .filter((r) => r.fields && !r.fields.voided);
  const today = localDay();
  let added = 0, extended = 0;
  for (let i = DAYS - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const entries = (await rest(`operations_forms?select=id,fields&station_key=eq.${LA.ENTRY_KEY}&status=eq.submitted&work_date=eq.${date}`))
      .filter((r) => !(r.fields || {}).voided);
    const day0 = new Date(date + 'T00:00:00').getTime();
    const rows = LA.laborDayRows(shifts, entries, { day0, nowMin: (Date.now() - day0) / 60000, isToday: date === today });
    const plan = LA.autoPlan(projects, rows, date, { checkedIn: true, closedOnly: true });
    plan.forEach(({ r, a, b, o, ext }) => console.log(`${date} ${r.name} ${LA.hhmm(a)}–${LA.hhmm(b)} → ${o.p.fields.name}${ext ? ' (extends ' + ext.f.start + ')' : ''}`));
    if (DRY || !plan.length) continue;
    const adds = plan.filter((x) => !x.ext).map(({ r, a, b, o }) => LA.projectEntry(r, a, b, date, o, BY));
    if (adds.length) { await rest('operations_forms', { method: 'POST', body: JSON.stringify(adds) }); added += adds.length; }
    for (const { b, ext } of plan.filter((x) => x.ext)) {
      await rest(`operations_forms?id=eq.${ext.rec.id}&status=eq.submitted`, { method: 'PATCH', body: JSON.stringify({ fields: LA.extendedFields(ext, b, BY), updated_by: BY }) });
      extended++;
    }
  }
  console.log(DRY ? 'Dry run — nothing written.' : `Auto-assigned: ${added} new entries, ${extended} extended.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
