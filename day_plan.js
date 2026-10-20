// Day plan import — reads the crew lead's "Plan del Día" spreadsheet
// (Plan_Proyectos_Template.xlsx, or the same cells pasted from Google
// Sheets) into Master Schedule projects. In the browser it's the global
// `DayPlan` (master_schedule.html's "Import day plan"); in Node,
// require('./day_plan.js') (scripts/test_day_plan.js).
//
// The sheet: column A holds the row labels (Proyecto, Sitio, Horario, Líder,
// Contratista 1/2 nombre | cuántos and inicio | fin, Notas) and then a
// "Responsabilidad | Nombre" header row with one person per row under it.
// Each project is a 2-column block (B:C, D:E, …) found from that header row,
// so hidden helper columns and moved rows don't matter. A blank
// responsibility means the one above; text in parentheses is a note
// ("Jorge Rojas (sale 5am)"), or a responsibility's own hours
// ("Colgar (5:30pm-2am)").
//
// parseGrid(rows) → { date, blocks, problems } from a grid of cell values;
// buildProject(block, date, ctx) → { fields, issues, names } with fields
// shaped like a saved work_project (see projectRunsOn in
// operations_stations.js). Names are matched to the Connecteam roster by
// matchPerson; the import screen lets someone settle the unsure ones.
(function (root) {
  const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const words = (s) => fold(s).replace(/[^a-z0-9ñ ]+/g, ' ').split(/\s+/).filter(Boolean);
  const text = (v) => v == null ? '' : String(v).replace(/\s+/g, ' ').trim();

  // Responsibility → Labor Log process, as on the template's Listas tab. '' =
  // the project's own process (the Labor Log falls back to it).
  const ROLE_PROCESS = {
    'cortar': 'harvest', 'fresh frozen': 'fresh_frozen', 'frozen': 'fresh_frozen',
    'colgar': 'intake_wet', 'pesar cajas': 'intake_wet', 'metrc': '', 'cuartos': 'other',
    'descolgar': 'dry_check', 'descogar': 'dry_check', 'destronche': 'buck', 'desoje': 'buck', 'pesar': 'buck',
    'comodin proceso': 'buck', 'comodin': 'buck', 'mobius': 'machine_trim', 'movius': 'machine_trim',
    'trim': 'hand_trim', 'trimming': 'hand_trim', 'smalls': 'smalls_trim', 'prerolls': 'preroll_production',
    'packing': '', 'chofer': 'transport', 'choferes': 'transport', 'regar': 'other', 'riego': 'other',
    'watering': 'other', 'bomba': 'other', 'security': 'other', 'otro': 'other'
  };

  // "Name (note)" → { base: 'Name', note: 'note' }.
  function splitNote(v) {
    const s = text(v), i = s.indexOf('(');
    if (i < 0) return { base: s, note: '' };
    return { base: s.slice(0, i).trim(), note: s.slice(i + 1).replace(/\)\s*$/, '').replace(/[()]/g, '').trim() };
  }

  // A clock time → 'HH:MM', or null. Takes "7am", "5:30 pm", "7 a.m.", "16:00",
  // "7" (7 AM), "12pm", "7:00:00 AM" (Google Sheets), and a spreadsheet time
  // (a fraction of a day).
  function parseTime(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') {
      if (!(v >= 0 && v < 1)) return v >= 1 && v <= 24 && Number.isInteger(v) ? hm(v % 24, 0) : null;
      const m = Math.round(v * 1440) % 1440;
      return hm(Math.floor(m / 60), m % 60);
    }
    const s = fold(v).replace(/\./g, '').replace(/\s+/g, '');
    const m = s.match(/^(\d{1,2})(?::?(\d{2})(?::\d{2})?)?(am|pm|a|p|hrs|h)?$/);
    if (!m) return null;
    let h = +m[1]; const mi = m[2] ? +m[2] : 0, ap = (m[3] || '')[0];
    if (mi > 59 || h > 24 || (ap && (ap === 'a' || ap === 'p') && (h < 1 || h > 12))) return null;
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    return hm(h % 24, mi);
  }
  const hm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  // "5:30pm-2am" / "5:30pm a 2am" → ['17:30', '02:00'], else null.
  function parseRange(s) {
    const parts = fold(s).split(/\s*(?:-|–|a|to|hasta)\s+|\s*[-–]\s*/).filter(Boolean);
    if (parts.length !== 2) return null;
    const a = parseTime(parts[0]), b = parseTime(parts[1]);
    return a && b ? [a, b] : null;
  }

  // A date cell → 'YYYY-MM-DD', or ''. Spreadsheet serials, ISO, M/D/YYYY.
  function parseDate(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
    if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
    const s = text(v);
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return '';
  }

  // Which labelled row is which (column A, accents and case ignored).
  const ROW_LABELS = [
    ['c1name', /^contratista 1.*nombre/], ['c1time', /^contratista 1.*inicio/],
    ['c2name', /^contratista 2.*nombre/], ['c2time', /^contratista 2.*inicio/],
    ['name', /^proyecto/], ['site', /^sitio/], ['hours', /^horario/], ['lead', /^lider/],
    ['notes', /^notas/], ['people', /^responsabilidad/]
  ];

  // rows: an array of rows, each an array of cell values (strings, numbers).
  function parseGrid(rows) {
    rows = (rows || []).map((r) => Array.isArray(r) ? r : []);
    const at = {};
    let date = '';
    rows.forEach((r, i) => {
      const a = fold(r[0]);
      if (!a) return;
      const hit = ROW_LABELS.find(([, re]) => re.test(a));
      if (hit && at[hit[0]] == null) at[hit[0]] = i;
    });
    // "Fecha / Date:" anywhere in the first rows; the date is the next filled cell.
    rows.slice(0, 6).forEach((r) => r.forEach((v, j) => {
      if (date || !/^fecha/.test(fold(v))) return;
      for (let k = j + 1; k < r.length && k < j + 4; k++) { const d = parseDate(r[k]); if (d) { date = d; break; } }
    }));
    if (at.people == null) return { date, blocks: [], problems: ['noHeader'] };
    const head = rows[at.people], cols = [];
    for (let j = 1; j < head.length; j++) if (/^responsabilidad/.test(fold(head[j])) && /^nombre/.test(fold(head[j + 1]))) cols.push(j);
    if (!cols.length) return { date, blocks: [], problems: ['noHeader'] };
    const cell = (key, j) => at[key] == null ? '' : (rows[at[key]] || [])[j];
    const blocks = [];
    cols.forEach((j) => {
      const b = {
        col: j, name: text(cell('name', j)), site: text(cell('site', j)),
        start: cell('hours', j), end: cell('hours', j + 1), lead: text(cell('lead', j)), notes: text(cell('notes', j)),
        contractors: [1, 2].map((n) => ({ name: text(cell(`c${n}name`, j)), count: cell(`c${n}name`, j + 1),
                                          start: cell(`c${n}time`, j), end: cell(`c${n}time`, j + 1) }))
                            .filter((c) => c.name || text(c.count)),
        people: []
      };
      let role = '';
      for (let i = at.people + 1; i < rows.length; i++) {
        const r = rows[i], rv = text(r[j]), nv = text(r[j + 1]);
        if (rv) role = rv;
        if (nv) b.people.push({ role, name: nv });
        else if (rv) b.people.push({ role, name: '' });   // a responsibility with nobody named (yet)
      }
      if (b.name || b.lead || b.people.length || b.contractors.length) blocks.push(b);
    });
    return { date, blocks, problems: [] };
  }

  // Edit distance, for spelling slips ("Dalet" / "Dalett", "Munis" / "Muniz").
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  // w typed, r on the roster: the same, a shortened word, or a slip.
  const wordLike = (w, r) => w === r || (w.length >= 3 && r.startsWith(w))
    || (w.length >= 4 && lev(w, r) <= 1) || (w.length >= 7 && lev(w, r) <= 2);

  // A typed name against the roster [{userId, name}] →
  // { person, how: 'exact' | 'close' | 'pick' | 'none', candidates }.
  // 'close' = one roster name has every typed word (allowing a slip or a
  // shortened word): used, but shown. 'pick' = several fit: someone chooses.
  function matchPerson(name, roster) {
    const key = words(name).join(' ');
    if (!key) return { person: null, how: 'none', candidates: [] };
    const exact = roster.filter((p) => words(p.name).join(' ') === key);
    if (exact.length === 1) return { person: exact[0], how: 'exact', candidates: exact };
    if (exact.length > 1) return { person: null, how: 'pick', candidates: exact };
    const ws = words(name);
    const scored = roster.map((p) => {
      const rw = words(p.name), used = new Set();
      let ok = true, exactWords = 0;
      for (const w of ws) {
        const k = rw.findIndex((r, i) => !used.has(i) && wordLike(w, r));
        if (k < 0) { ok = false; break; }
        used.add(k); if (rw[k] === w) exactWords++;
      }
      return ok ? { p, exactWords } : null;
    }).filter(Boolean);
    if (!scored.length) {
      // The other way round: a roster name inside what was typed ("David Cruz Cruz" → David Cruz).
      const inside = ws.length >= 2 ? roster.filter((p) => { const rw = words(p.name); return rw.length >= 2 && rw.every((r) => ws.some((w) => wordLike(r, w))); }) : [];
      return { person: null, how: inside.length ? 'pick' : 'none', candidates: inside.slice(0, 8) };
    }
    const best = Math.max(...scored.map((x) => x.exactWords));
    const top = scored.filter((x) => x.exactWords === best).map((x) => x.p);
    if (ws.length >= 2 && top.length === 1) return { person: top[0], how: 'close', candidates: scored.map((x) => x.p) };
    return { person: null, how: 'pick', candidates: scored.map((x) => x.p).slice(0, 8) };
  }

  const addDay = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const shortDate = (iso) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;

  // ctx: { roster, locations (WORK_LOCATIONS), roleProcess (fold(name) →
  // process, from the file's Listas tab; ROLE_PROCESS fills the rest),
  // resolve(rawName) → {userId, name} | undefined (the import screen's picks),
  // newId }.
  // issues: [{ level: 'error' | 'warn', code, ... }] — errors stop the import.
  function buildProject(b, date, ctx) {
    const roster = ctx.roster || [], issues = [], names = [];
    const newId = ctx.newId || (() => 'r' + Math.random().toString(36).slice(2, 10));
    const procOf = (role) => { const k = fold(role); const m = ctx.roleProcess || {}; return k in m ? m[k] : (ROLE_PROCESS[k] || ''); };
    const person = (raw) => {
      const picked = ctx.resolve && ctx.resolve(raw);
      const m = matchPerson(raw, roster);
      names.push({ raw, match: m, picked });
      if (picked) return picked.name ? { userId: picked.userId || '', name: picked.name } : null;
      return m.person ? { userId: String(m.person.userId), name: m.person.name } : { userId: '', name: raw };
    };

    if (!b.name) issues.push({ level: 'error', code: 'noName' });
    // Location: the app's list (Adobe, Wildcat …, a slip like "Wiltcat" too), else Other with the typed name.
    let location = '', locationName = '';
    const site = fold(b.site);
    if (!site) issues.push({ level: 'error', code: 'noSite' });
    else {
      const locs = (ctx.locations || []).filter((l) => l[1]);
      const hit = locs.find((l) => fold(l[1]) === site || l[0] === site.replace(/\s+/g, '_'))
        || locs.find((l) => site.startsWith(fold(l[1])) || lev(site, fold(l[1])) <= 2);
      if (hit) location = hit[0];
      else { location = 'other'; locationName = site === 'otro' || site === 'other' ? (b.notes || 'Otro') : text(b.site); }
    }
    const startTime = parseTime(b.start) || '', endTime0 = parseTime(b.end) || '';
    if (text(b.start) && !startTime) issues.push({ level: 'error', code: 'badTime', value: text(b.start) });
    if (text(b.end) && !endTime0) issues.push({ level: 'error', code: 'badTime', value: text(b.end) });
    const endTime = startTime ? endTime0 : '';
    if (!startTime) issues.push({ level: 'warn', code: 'allDay' });
    else if (!endTime) issues.push({ level: 'warn', code: 'noEnd' });

    const notes = [];
    if (b.notes) notes.push(b.notes);
    let lead = null;
    if (b.lead) {
      const { base, note } = splitNote(b.lead);
      lead = person(base);
      if (note && lead) notes.push(`${lead.name}: ${note}`);
    }

    // Responsibilities, in the order they first appear.
    const roles = [], byRole = new Map(), seen = new Set();
    let unassigned = 0;
    b.people.forEach((x) => {
      const r = splitNote(x.role);
      const rname = r.base || 'Personal';
      if (!r.base && x.name) unassigned++;
      const rkey = fold(rname) + '|' + fold(r.note);
      let role = byRole.get(rkey);
      if (!role) {
        role = { id: newId(), name: rname, process: procOf(rname), startTime: '', endTime: '', people: [] };
        if (r.note) {
          const range = parseRange(r.note), one = parseTime(r.note);
          if (range) [role.startTime, role.endTime] = range;
          else if (one) role.startTime = one;
          else notes.push(`${rname}: ${r.note}`);
        }
        byRole.set(rkey, role); roles.push(role);
      }
      if (!x.name) return;
      const { base, note } = splitNote(x.name);
      if (!base) return;
      const p = person(base);
      if (!p) return;
      const k = (p.userId ? 'id:' + p.userId : 'name:' + fold(p.name)) + '|' + role.id;
      if (seen.has(k)) return;
      seen.add(k);
      role.people.push(p);
      if (note) notes.push(`${p.name}: ${note}`);
    });
    if (unassigned) issues.push({ level: 'warn', code: 'noRole', n: unassigned });
    // A responsibility's hours are kept only where they differ from the project's.
    roles.forEach((r) => { if (r.startTime === startTime) r.startTime = ''; if (r.endTime === endTime) r.endTime = ''; });

    // Contractors: the same name on both rows is one contractor with two times.
    const contractors = [];
    b.contractors.forEach((c) => {
      const count = Math.round(Number(String(c.count == null ? '' : c.count).replace(/[^\d.]/g, '')));
      if (!(count >= 1)) { issues.push({ level: 'error', code: 'flcCount', name: c.name || '?' }); return; }
      const cname = c.name || 'Contratista';
      const s = parseTime(c.start) || '', e = parseTime(c.end) || '';
      if ((text(c.start) && !s) || (text(c.end) && !e)) issues.push({ level: 'error', code: 'badTime', value: text(c.start) + ' ' + text(c.end) });
      let k = contractors.find((x) => fold(x.name) === fold(cname));
      if (!k) contractors.push(k = { id: newId(), name: cname, shifts: [] });
      k.shifts.push({ id: newId(), count, startTime: s && s !== startTime ? s : '', endTime: e && e !== endTime ? e : '' });
    });

    // The project's process: its responsibilities' one station process, if
    // they share one (Harvest Intake: Colgar + Pesar cajas → intake_wet).
    const procs = [...new Set(roles.map((r) => r.process).filter((p) => p && p !== 'other' && p !== 'transport'))];
    const name = b.name && !/\b\d{1,2}\/\d{1,2}\b/.test(b.name) && date ? `${b.name} ${shortDate(date)}` : b.name;
    const fields = {
      name, location, locationName, cid: '', process: procs.length === 1 ? procs[0] : '', status: 'active',
      start: date, end: date && startTime && endTime && endTime <= startTime ? addDay(date, 1) : date,
      days: [], startTime, endTime, lead, roles, contractors, uids: [], notes: notes.join('\n')
    };
    if (!roles.length && !lead && !contractors.length) issues.push({ level: 'error', code: 'empty' });
    return { fields, issues, names };
  }

  // A workbook read by SheetJS → { rows, roleProcess }: the "Plan del Día"
  // sheet (else the first sheet with the labels), and the Listas tab's
  // responsibility → process column.
  function fromWorkbook(XLSX, wb, sheetName) {
    const grid = (ws) => XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const names = wb.SheetNames;
    const pick = sheetName && names.includes(sheetName) ? sheetName
      : names.find((n) => fold(n) === 'plan del dia')
      || names.find((n) => !/ejemplo|resumen|listas|personal|como usar/.test(fold(n)) && !parseGrid(grid(wb.Sheets[n])).problems.length)
      || names[0];
    const roleProcess = {};
    const listas = names.find((n) => fold(n) === 'listas');
    if (listas) grid(wb.Sheets[listas]).slice(1).forEach((r) => {
      const k = fold(r[0]), p = text(r[2]);
      if (k && p) roleProcess[k] = p.startsWith('(') ? '' : p;
    });
    return { rows: grid(wb.Sheets[pick]), roleProcess, sheet: pick, sheets: names };
  }

  // Tab-separated text (cells copied from Google Sheets or Excel) → rows.
  const fromText = (s) => String(s || '').replace(/\r/g, '').split('\n').map((line) => line.split('\t'));

  const api = { ROLE_PROCESS, fold, splitNote, parseTime, parseRange, parseDate, parseGrid, matchPerson, buildProject, fromWorkbook, fromText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DayPlan = api;
})(this);
