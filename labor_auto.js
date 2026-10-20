// Labor Log Auto-assign, shared by labor_log.html (its Timeline's
// "Auto-assign scheduled" button and right-click menu) and
// scripts/labor_autoassign.js (the hourly run for people checked in on Crew
// Check-In). In the browser it's the global `LaborAuto`; in Node,
// require('./labor_auto.js'). Uses projectRunsOn / projectHours /
// projectRoles / personSpans / hasOwnTimes / WORK_LOCATIONS from
// operations_stations.js.
//
// A day's rows (laborDayRows) are each person's Connecteam clock-ins
// (data/connecteam_shifts.json) and their Labor Log entries, with the
// clocked time no entry covers as `gaps`. autoPlan puts each gap on the one
// project the person is scheduled on then (their own role, that day's
// changes applied) when they clocked in at that project's location —
// Connecteam's job "Airway Distribution" matches the location Airway — and
// at least half of it is inside their hours there (so an overnight shift's
// early hours don't land on a project starting at 7). Someone Crew Check-In
// moved has their own hours on each project, and the gap is split at the
// move first. A gap with no such project, or more than one, is left to log
// by hand.
(function (root) {
  const S = typeof projectRunsOn === 'function'
    ? { projectRunsOn, projectHours, projectRoles, personSpans, hasOwnTimes, WORK_LOCATIONS }
    : require('./operations_stations.js');
  const ENTRY_KEY = 'labor_entry';
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const num = (x) => (Number.isFinite(+x) ? +x : 0);
  const hhmm = (m) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
  const toMin = (s) => { const [h, mi] = String(s || '').split(':').map(Number); return Number.isFinite(h) && Number.isFinite(mi) ? h * 60 + mi : null; };
  const personKey = (p) => p.userId ? 'id:' + p.userId : 'name:' + fold(p.name);
  const prevDay = (date) => {
    const d0 = new Date(date + 'T12:00:00'); d0.setDate(d0.getDate() - 1);
    return new Date(d0.getTime() - d0.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  // Union of [a,b) minute intervals, merged and sorted.
  const union = (iv) => iv.slice().sort((x, y) => x[0] - y[0]).reduce((o, [a, b]) => {
    if (o.length && a <= o[o.length - 1][1]) o[o.length - 1][1] = Math.max(o[o.length - 1][1], b); else o.push([a, b]);
    return o;
  }, []);
  // Parts of `iv` not covered by `cover`; pieces under 5 minutes are noise.
  const minus = (iv, cover) => {
    const out = [];
    union(iv).forEach(([a, b]) => {
      let cur = a;
      union(cover).forEach(([c, d]) => { if (d <= cur || c >= b) return; if (c > cur) out.push([cur, c]); cur = Math.max(cur, d); });
      if (cur < b) out.push([cur, b]);
    });
    return out.filter(([a, b]) => b - a >= 5);
  };

  // Each person's day: everyone clocked in that day, plus anyone with an
  // entry. `day0` is the day's local midnight (ms) and `nowMin` minutes past
  // it; a shift still open runs to now on today, else counts for nothing.
  function laborDayRows(shifts, entries, { day0, nowMin, isToday }) {
    const rows = new Map();
    const rowFor = (key, name, userId) => rows.get(key) || rows.set(key, { key, name, userId, shifts: [], shiftInfo: [], places: new Set(), timed: [], untimed: 0, logged: 0, open: false }).get(key);
    (shifts || []).forEach((sh) => {
      const a = (Date.parse(sh.start) - day0) / 60000;
      const openShift = !sh.end;
      const b = openShift ? (isToday ? nowMin : a) : (Date.parse(sh.end) - day0) / 60000;
      if (!(b > 0 && a < 1440) || b <= a) return;
      const row = rowFor(String(sh.userId), sh.name, String(sh.userId));
      row.shifts.push([Math.max(0, a), Math.min(1440, b)]);
      // Where they clocked in: the Connecteam job, else the time clock's name.
      // What they said they did: the Connecteam sub-job and/or their answers
      // to the clock-in/out questions.
      const place = sh.job || sh.clock || '';
      row.shiftInfo.push({ a: Math.max(0, a), b: Math.min(1440, b), place, activity: sh.activity || '', open: openShift });
      if (place) row.places.add(place);
      if (openShift && isToday) row.open = true;
    });
    (entries || []).forEach((r) => {
      const f = r.fields || {};
      const key = f.employeeId ? String(f.employeeId) : 'name:' + fold(f.employeeName);
      const row = rowFor(key, f.employeeName, f.employeeId || '');
      row.logged += num(f.hours);
      const a = toMin(f.start), b0 = toMin(f.end);
      if (a == null || b0 == null) { row.untimed += num(f.hours); return; }
      const b = b0 <= a ? b0 + 1440 : b0;   // past midnight
      row.timed.push({ a, b, f, rec: r });
    });
    return [...rows.values()].map((row) => {
      const clocked = union(row.shifts).reduce((x, [a, b]) => x + (b - a), 0) / 60;
      const timedIv = row.timed.map((e) => [e.a, e.b]);
      return { ...row, clocked, unalloc: Math.max(0, clocked - row.logged),
               gaps: minus(row.shifts, timedIv), outside: row.shifts.length ? minus(timedIv, row.shifts) : [] };
    });
  }

  // The clock-in a not-logged stretch overlaps most (a gap never spans two,
  // but be safe), for its place and activity.
  function gapShift(r, a, b) {
    let best = null, most = 0;
    r.shiftInfo.forEach((s) => { const o = Math.min(b, s.b) - Math.max(a, s.a); if (o > most) { most = o; best = s; } });
    return best;
  }

  // A project's roles on one day, with Master Schedule's Change this day
  // applied (fields.overrides[date]: people out, people added).
  function dayRoles(f, date, leadLabel) {
    const ov = (f.overrides || {})[date] || {};
    const out = new Set(ov.out || []);
    return S.projectRoles(f, leadLabel).map((r) => ({ ...r, people: [
      ...r.people.filter((x) => !out.has(personKey(x))),
      ...(ov.extra || []).filter((x) => x.roleId === r.id).map((x) => ({ userId: x.userId || '', name: x.name }))] }));
  }
  // The projects running around [a, b) that day — the day's shifts, and the
  // day before's overnight ones running past midnight into it (their hours
  // less 24 h). The person's own roles come first (`mine`, at their own
  // hours there — personSpans, Crew Check-In's moves — else the role's,
  // and `here` when they're checked in there), then the other projects
  // whose hours overlap. `all` (the Labor Log's right-click menu) takes
  // every project on that day whatever its hours or status (done, day
  // skipped); those overlapping [a, b) are listed first (`near`).
  function scheduledAround(projects, date, a, b, userId, name, leadLabel, { all = false } = {}) {
    const out = [];
    const isMe = (p) => userId ? String(p.userId) === String(userId) : fold(p.name) === fold(name);
    const prev = prevDay(date);
    projects.forEach((p) => {
      const f = p.fields;
      [[date, 0], [prev, 1440]].forEach(([d, off]) => {
        const ov = (f.overrides || {})[d] || {};
        const any = all && !off;
        if (out.some((o) => o.p === p)) return;
        if (any ? !S.projectRunsOn({ ...f, status: 'active' }, d) : (!S.projectRunsOn(f, d) || ov.skip)) return;
        const overlaps = (spans) => spans.some(([s, e]) => s == null ? !off : s - off < b && e - off > a);
        let mine = 0;
        dayRoles(f, d, leadLabel).forEach((role) => {
          const x = role.people.find(isMe);
          const spans = x ? S.personSpans(f, role, d, personKey(x)) : [];
          const near = x && overlaps(spans);
          if (near || (x && any)) { out.push({ p, role, mine: true, near, here: (ov.here || []).includes(personKey(x)), off, spans }); mine++; }
        });
        const near = overlaps([S.projectHours(f)]);
        if (!mine && (near || any)) out.push({ p, role: null, mine: false, near, here: false, off, spans: [S.projectHours(f)] });
      });
    });
    return out.sort((x, y) => y.mine - x.mine || y.near - x.near || String(x.p.fields.name).localeCompare(String(y.p.fields.name)));
  }

  const locLabel = (f) => f.location === 'other' ? (f.locationName || '') : ((S.WORK_LOCATIONS.find((l) => l[0] === f.location) || [])[1] || '');
  const samePlace = (place, f) => {
    const x = fold(place).trim(), y = fold(locLabel(f)).trim();
    return !!x && !!y && (x.includes(y) || y.includes(x));
  };
  // Where Crew Check-In moved the person that day (their own times on any
  // project, as minutes into `date`): a stretch is split there first, so the
  // time before a move and after it each find their own project.
  function moveCuts(projects, date, r) {
    const cuts = new Set();
    const prev = prevDay(date);
    const isMe = (p) => r.userId ? String(p.userId) === String(r.userId) : fold(p.name) === fold(r.name);
    projects.forEach((p) => [[date, 0], [prev, 1440]].forEach(([d, off]) => {
      if (!S.projectRunsOn(p.fields, d)) return;
      dayRoles(p.fields, d).forEach((role) => {
        const x = role.people.find(isMe);
        if (!x || !S.hasOwnTimes(p.fields, d, personKey(x))) return;
        // Only the move times: a span's edge at the role's own start or end
        // isn't one, and the usual slack around a shift stays with it.
        const [s0, e0] = S.projectHours(p.fields, role);
        S.personSpans(p.fields, role, d, personKey(x)).forEach(([s, e]) => {
          if (s !== s0 && !(s0 == null && s === 0)) cuts.add(s - off);
          if (e !== e0 && !(s0 == null && e === 1440)) cuts.add(e - off);
        });
      });
    }));
    return [...cuts].sort((x, y) => x - y);
  }
  // [{r, a, b, o, ext}] — each stretch to log, and `ext`, an entry it
  // continues instead (below). Options: `checkedIn` only takes projects the
  // person is checked in on (Crew Check-In's `here`); `closedOnly` leaves
  // shifts they're still clocked in on, so a move recorded later in the day
  // still splits the time.
  function autoPlan(projects, list, date, { checkedIn = false, closedOnly = false } = {}) {
    const plan = [];
    list.forEach((r) => {
      const cuts = moveCuts(projects, date, r);
      r.gaps.flatMap(([a, b]) => {
        const at = cuts.filter((c) => c > a && c < b), pts = [a, ...at, b];
        return pts.slice(1).map((x, i) => [pts[i], x]);
      }).forEach(([a, b]) => {
        const sh = gapShift(r, a, b);
        if (!sh || !sh.place || (closedOnly && sh.open)) return;
        const inHours = (o) => o.spans.reduce((x, [s, e]) => s == null ? b - a : x + Math.max(0, Math.min(b, e - o.off) - Math.max(a, s - o.off)), 0) >= (b - a) / 2;
        const opts = scheduledAround(projects, date, a, b, r.userId, r.name)
          .filter((o) => o.mine && (!checkedIn || o.here) && samePlace(sh.place, o.p.fields) && inHours(o));
        if (opts.length !== 1) return;
        const o = opts[0];
        // Right after an entry on the same project and role (an earlier
        // auto-assign, while they were still on the clock)? Stretch that one
        // instead of adding another, so running it again later in the day
        // picks up the time since.
        const ext = r.timed.find((e) => Math.abs(e.b - a) < 1 && e.f.project === o.p.id && (e.f.role || '') === ((o.role && o.role.id) || ''));
        plan.push({ r, a: Math.round(a), b: Math.round(b), o, ext });
      });
    });
    return plan;
  }
  // A not-logged stretch [a, b) as an entry on a project (o from
  // scheduledAround): the role's process, else the project's, else Other.
  function projectEntry(r, a, b, date, o, by, extra) {
    const hours = Math.round((b - a) / 60 * 100) / 100;
    return {
      station_key: ENTRY_KEY, status: 'submitted', owner_user: by || null, updated_by: by || null,
      strain: null, work_date: date, submitted_at: new Date().toISOString(),
      fields: {
        process: (o.role && o.role.process) || o.p.fields.process || 'other',
        employeeId: r.userId || '', employeeName: r.name, uids: [],
        project: o.p.id, projectName: o.p.fields.name,
        ...(o.role ? { role: o.role.id, roleName: o.role.name } : {}),
        start: hhmm(a), end: hhmm(b), hours, notes: '', enteredBy: by, ...(extra || {})
      }
    };
  }
  // An earlier entry `ext` stretched to end at b.
  function extendedFields(ext, b, by) {
    const a = Math.round(ext.a);
    return { ...ext.rec.fields, end: hhmm(b), hours: Math.round((b - a) / 60 * 100) / 100, extendedBy: by, extendedAt: new Date().toISOString() };
  }

  const api = { ENTRY_KEY, hhmm, toMin, union, minus, laborDayRows, gapShift, dayRoles, scheduledAround, locLabel, samePlace, moveCuts, autoPlan, projectEntry, extendedFields };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LaborAuto = api;
})(this);
