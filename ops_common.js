// ─────────────────────────────────────────────────────────────────────────────
// 2CW Operations — shared runtime for the station forms and the dashboard.
//
// Three jobs:
//   1. Language (EN/ES) — every station label carries both, this picks one.
//   2. Data access — reference lists + the per-stage record files.
//   3. Submitting — including an offline queue, because wifi in the dry rooms
//      and out at the farms is not something a team lead should have to think
//      about mid-count.
// ─────────────────────────────────────────────────────────────────────────────

const OPS_ENDPOINT = '/.netlify/functions/submit-operations';
const QUEUE_KEY = '2cw_ops_queue';
const LANG_KEY = '2cw_lang';

// ── Fixing submitted forms ─────────────────────────────────────────────────
// Who may reopen an already-submitted form (ops_form.html?edit=<id>) to
// correct it: Wet Intakes with Harvest Intakes edit access, any station with
// the admin panel's "Fix submitted forms" plus edit access to that station.
// Both are set at hub login (index.html).
function canFixSubmitted(stationKey) {
  if (stationKey === 'intake_wet' && sessionStorage.getItem('2cw_intake_access') === 'edit') return true;
  if (sessionStorage.getItem('2cw_ops_fix') !== 'true') return false;
  return canEditStationHere(stationKey);
}
// Who gets Delete this record on that page: Wet Intakes with Harvest Intakes
// delete, any station with the admin panel's "Delete submitted forms" plus
// edit access to it. Only shows the button — operations-records.js re-checks.
function canDeleteSubmitted(stationKey) {
  if (stationKey === 'intake_wet' && sessionStorage.getItem('2cw_intake_delete') === 'true') return true;
  return sessionStorage.getItem('2cw_ops_delete') === 'true' && canEditStationHere(stationKey);
}
function canEditStationHere(stationKey) {
  let edit = null;
  try { edit = JSON.parse(sessionStorage.getItem('2cw_ops_edit_access') || 'null'); } catch { edit = null; }
  return edit === 'all' || (Array.isArray(edit) && edit.includes(stationKey));
}

// ── Language ────────────────────────────────────────────────────────────────
function getLang() {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === 'en' || saved === 'es') return saved;
  return (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
}
function setLang(lang) {
  localStorage.setItem(LANG_KEY, lang);
  document.documentElement.lang = lang;
}
// Translate an inline {en, es} label object. Plain strings pass through, so a
// field can skip translation when the term is the same in both languages.
function t(obj) {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj;
  return obj[getLang()] || obj.en || '';
}

const UI = {
  submit:        { en: 'Submit', es: 'Enviar' },
  submitting:    { en: 'Submitting…', es: 'Enviando…' },
  submitted:     { en: '✓ Submitted — thank you!', es: '✓ Enviado — ¡gracias!' },
  queued:        { en: '✓ Saved on this tablet — will send when you are back online.',
                   es: '✓ Guardado en esta tableta — se enviará cuando vuelva la conexión.' },
  failed:        { en: 'Something went wrong — please try again.', es: 'Algo salió mal — intente de nuevo.' },
  required:      { en: 'Fill in every required field.', es: 'Complete todos los campos obligatorios.' },
  addRow:        { en: '+ Add row', es: '+ Agregar fila' },
  remove:        { en: 'Remove', es: 'Quitar' },
  subtotal:      { en: 'Sub-total', es: 'Subtotal' },
  other:         { en: 'Other…', es: 'Otro…' },
  otherPrompt:   { en: 'Type a value', es: 'Escriba un valor' },
  pendingOne:    { en: 'form waiting to send', es: 'formulario pendiente de enviar' },
  pendingMany:   { en: 'forms waiting to send', es: 'formularios pendientes de enviar' },
  sendNow:       { en: 'Send now', es: 'Enviar ahora' },
  offline:       { en: 'Offline', es: 'Sin conexión' },
  calculated:    { en: 'calculated', es: 'calculado' },
  checkValue:    { en: 'Outside the usual range — double-check the scale.',
                   es: 'Fuera del rango habitual — verifique la báscula.' },
  noMatch:       { en: 'No earlier record found for that UID — enter the weights by hand.',
                   es: 'No se encontró un registro anterior para ese UID — ingrese los pesos a mano.' },
  matched:       { en: 'Matched', es: 'Coincide con' },
  back:          { en: '← Hub', es: '← Inicio' }
};

// ── Data access ─────────────────────────────────────────────────────────────
const _cache = {};
async function loadJson(path, fallback) {
  if (_cache[path]) return _cache[path];
  try {
    const res = await fetch(path + '?t=' + Date.now());
    if (!res.ok) throw new Error(res.status);
    _cache[path] = await res.json();
    return _cache[path];
  } catch {
    return fallback;
  }
}
// Farm licenses (kind 'pid') and CIDs are managed in the admin panel ("Farm
// Licenses & CIDs" tab, Supabase table ref_codes) and replace the file's `properties` list when they load;
// the file's list is the fallback when Supabase isn't reachable. Shared by
// the forms and harvest_intakes.html (getRefCodes) for the code → name label.
async function getRefCodes() {
  const client = typeof getClient === 'function' ? getClient() : null;
  if (!client) return null;
  try {
    const { data, error } = await client.from('ref_codes').select('*').order('code');
    return error ? null : (data || []);
  } catch { return null; }
}
// kind 'pid' rows are farm licenses now (the field kept its old key so past
// records still read): "Wildcat: CCL21-0001234". CIDs keep "Name: CID 012".
const refCodeLabel = (r) => !r.name ? r.code : r.kind === 'pid' ? `${r.name}: ${r.code}` : `${r.name}: ${r.kind.toUpperCase()} ${r.code}`;
// Strains are managed on strain_library.html (Supabase table strains) and
// replace the file's `strains` list the same way.
async function getStrains() {
  const client = typeof getClient === 'function' ? getClient() : null;
  if (!client) return null;
  try {
    const { data, error } = await client.from('strains').select('*').order('name');
    return error ? null : (data || []);
  } catch { return null; }
}
async function loadReference() {
  const [ref, codes, strains] = await Promise.all([
    loadJson('/data/operations/reference.json', { strains: [], sites: [] }),
    getRefCodes(),
    getStrains()
  ]);
  if (strains && strains.length) {
    ref.strains = strains.map((s) => ({ name: s.name, abbreviation: s.abbreviation, sources: s.sources, aliases: s.aliases, active: s.active }));
  }
  if (codes && codes.length) {
    const pick = (kind, idKey) => codes.filter((r) => r.kind === kind)
      .map((r) => ({ [idKey]: r.code, label: refCodeLabel(r), active: r.active }));
    ref.properties = pick('pid', 'pid');
    ref.customers = pick('cid', 'id');
  }
  return ref;
}
const loadStage = (key) => loadJson(`/data/operations/${key}.json`, []);

// Reference lists are objects ({id,label}) or bare strains ({name}); normalise
// both into the {v, label} shape the selects want. `name` can also be an array
// of list names, merged in order (Wet Intake: drying rooms, then freezers).
function refOptions(reference, name) {
  const list = [].concat(name).flatMap((n) => (reference && reference[n]) || []);
  return list
    .filter((item) => item.active !== false)
    .map((item) => {
      const v = item.id || item.pid || item.name || String(item);
      const label = item.label || item.name || v;
      return { v, label };
    });
}

// ── UID lookup ──────────────────────────────────────────────────────────────
// Operators write the last 4 of the Metrc tag on paper, so accept either the
// full 24-character tag or just the tail.
function uidMatches(candidate, query) {
  if (!candidate || !query) return false;
  const c = String(candidate).toUpperCase().replace(/\s/g, '');
  const q = String(query).toUpperCase().replace(/\s/g, '');
  if (q.length < 4) return false;
  return c === q || c.endsWith(q);
}

// ── Currently drying ────────────────────────────────────────────────────────
// A Wet Intake is drying until a Take Down (dry_check) is submitted for its
// farm package (`incomingUid`). Fresh-frozen intakes go to a freezer and
// never dry. Either side may hold only the tail of the tag, so two UIDs
// match when one ends with the other (4+ characters).
const normUid = (u) => String(u || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function uidTailMatch(a, b) {
  a = normUid(a); b = normUid(b);
  if (Math.min(a.length, b.length) < 4) return false;
  return a.endsWith(b) || b.endsWith(a);
}
const isFreshFrozen = (i) => i.freshFrozen === true || i.freshFrozen === 'true';

// ── Metrc details from the Canix sync ───────────────────────────────────────
// Wet Intake leaves the farm license, CID and manifest # off the form (its
// `fromCanix` fields); scripts/canix_sync.py fills them in on a submitted
// intake from its package's Metrc transfer and stamps `canixSyncedAt`. Until
// then the intake is waiting for that sync — unless someone typed the
// manifest # in (intakes from before the change, or a farm Canix doesn't see).
function awaitingCanix(rec) {
  const f = (rec && rec.fields) || {};
  return !!rec && rec.station_key === 'intake_wet' && rec.status === 'submitted' &&
    !f.canixSyncedAt && !String(f.manifestNo || '').trim();
}
// Synced, but Canix had no manifest # for it: a farm we have no Canix key
// for, found only from the package received at our facility.
function canixNoManifest(rec) {
  const f = (rec && rec.fields) || {};
  return !!rec && rec.station_key === 'intake_wet' && rec.status === 'submitted' &&
    !!f.canixSyncedAt && !String(f.manifestNo || '').trim();
}

// The strain Canix has for an intake's package (fields.canixSync.strain, from
// the sync) when it isn't the strain on the intake — null when they agree or
// there's nothing to compare. Canix names often differ from the Strain
// Library's ("G41" for "Gelato #41"), so they agree when Canix's name is the
// intake strain's library name or one of its aliases. `reference` is
// loadReference()'s result; worked out on the page rather than stored, so
// fixing the strain on Edit or adding the alias clears it straight away.
function canixStrainMismatch(rec, reference) {
  const f = (rec && rec.fields) || {};
  if (!rec || rec.station_key !== 'intake_wet' || rec.status !== 'submitted') return null;
  const canix = String((f.canixSync && f.canixSync.strain) || '').trim();
  const mine = String(rec.strain || f.strain || '').trim();
  if (!canix || !mine) return null;
  const lc = (s) => String(s || '').trim().toLowerCase();
  if (lc(canix) === lc(mine)) return null;
  const names = new Set([lc(mine)]);
  ((reference && reference.strains) || []).forEach((s) => {
    const all = [s.name, ...(s.aliases || [])].map(lc);
    if (all.includes(lc(mine))) all.forEach((n) => names.add(n));
  });
  return names.has(lc(canix)) ? null : canix;
}

// Package tag → Canix strain name, from the synced inventory
// (data/canix_inventory.json — includes farm packages still In Transit to us).
// Loaded once, on first use; the Wet Intake form uses it to fill a scanned
// row's strain. A full tag is looked up as is; a shorter tail only when one
// package ends with it.
// With `plants` (Harvest's plant tags), plant batches are searched too
// (data/canix_plant_batches.json — each batch is named by its plant tag).
let _canixStrains = null;
let _canixPlantStrains = null;
function canixStrainForUid(uid, plants) {
  if (plants) {
    if (!_canixPlantStrains) {
      _canixPlantStrains = fetch('/data/canix_plant_batches.json').then((r) => (r.ok ? r.json() : []))
        .then((list) => {
          const m = new Map();
          (list || []).forEach((b) => {
            const name = b && b.strain && b.strain.name;
            if (b && b.name && name) m.set(normUid(b.name), name);
          });
          return m;
        })
        .catch(() => new Map());
    }
    const q = normUid(uid);
    if (q.length < 4) return Promise.resolve(null);
    return _canixPlantStrains.then((m) => {
      if (m.has(q)) return m.get(q);
      const hits = q.length >= 24 ? [] : [...m.keys()].filter((tag) => tag.endsWith(q));
      return hits.length === 1 ? m.get(hits[0]) : canixStrainForUid(uid);
    });
  }
  if (!_canixStrains) {
    _canixStrains = fetch('/data/canix_inventory.json').then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        const m = new Map();
        (list || []).forEach((p) => {
          const name = p && p.item && p.item.strain && p.item.strain.name;
          if (p && p.tag && name) m.set(normUid(p.tag), name);
        });
        return m;
      })
      .catch(() => new Map());
  }
  const q = normUid(uid);
  if (q.length < 4) return Promise.resolve(null);
  return _canixStrains.then((m) => {
    if (m.has(q)) return m.get(q);
    if (q.length >= 24) return null;
    const hits = [...m.keys()].filter((tag) => tag.endsWith(q));
    return hits.length === 1 ? m.get(hits[0]) : null;
  });
}

// Which intake each take down took down, as Map(intake id → take-down
// record). Both lists are flat records ({id, sourceUid, date, freshFrozen} /
// {incomingUid, date}). An exact UID wins; otherwise, of the intakes not
// already taken down, the newest one on or before the take-down date.
function matchTakeDowns(intakes, downs) {
  const out = new Map();
  [...downs].sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).forEach((d) => {
    const pool = intakes.filter((i) => !isFreshFrozen(i) && uidTailMatch(i.sourceUid, d.incomingUid));
    const exact = pool.find((i) => normUid(i.sourceUid) === normUid(d.incomingUid));
    const open = pool.filter((i) => !out.has(i.id))
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const hit = exact || open.find((i) => !d.date || !i.date || i.date <= d.date) || open[0];
    if (hit) out.set(hit.id, d);
  });
  return out;
}

// Submitted intakes with no take down yet.
function currentlyDrying(intakes, downs) {
  const taken = matchTakeDowns(intakes, downs);
  return intakes.filter((i) => !isFreshFrozen(i) && !taken.has(i.id));
}

// The submitted Take Downs (flat records) grouped by on-stem UID, as
// Map(on-stem UID → records, newest first). Several farm packages of one
// strain can be taken down into one new dry UID (a Metrc merge), so a group
// can hold several Take Downs; each farm package counts once (its newest
// Take Down — a resubmitted one replaces the earlier one).
function takeDownGroups(downs) {
  const groups = new Map();
  const seen = new Set();
  [...(downs || [])].sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || ''))).forEach((r) => {
    const uid = normUid(r.sourceUid);
    if (!uid) return;
    const farm = `${uid}|${normUid(r.incomingUid) || r.id}`;
    if (seen.has(farm)) return;
    seen.add(farm);
    if (!groups.has(uid)) groups.set(uid, []);
    groups.get(uid).push(r);
  });
  return groups;
}

// One on-stem package from its group of Take Downs: the newest one's
// details, `dryWeightLb` added up over all of them, `unbuckedLb` what's
// still there to buck (released ones, less any parts split off), and
// `result` 'pass' once every Take Down in it is released. `farmUids` lists
// the farm packages merged into it.
function combineTakeDowns(uid, members) {
  const lb = (x) => (x === undefined || x === null || x === '' ? null : Number(x));
  const r2 = (x) => Math.round(x * 100) / 100;
  const parts = (r) => (r.releases || []).reduce((a, x) => a + (Number(x.lb) || 0), 0);
  const weighed = members.filter((r) => lb(r.dryWeightLb) !== null);
  const pass = weighed.filter((r) => r.result === 'pass');
  const held = members.find((r) => r.result !== 'pass');
  return { ...members[0], sourceUid: uid,
    dryWeightLb: weighed.length ? r2(weighed.reduce((a, r) => a + Number(r.dryWeightLb), 0)) : null,
    unbuckedLb: pass.length ? Math.max(0, r2(pass.reduce((a, r) => a + Number(r.dryWeightLb) - parts(r), 0))) : null,
    result: held ? held.result : 'pass',
    farmUids: members.map((r) => r.incomingUid).filter(Boolean) };
}

// What's ready to buck: each on-stem package released to bucking (all its
// Take Downs combined — combineTakeDowns — counting only the released
// ones), plus each part released off a held one under its own tag — less
// any UID that already has a submitted Bucking record. Same shape
// findUpstream returns (sourceUid, strain, unbuckedLb), so picking one fills
// the form the way typing its UID would.
function buckablePackages(downs, bucked) {
  const done = (bucked || []).map((b) => b.sourceUid).filter(Boolean);
  const isDone = (uid) => done.some((d) => uidTailMatch(d, uid));
  const lb = (x) => (x === undefined || x === null || x === '' ? null : Number(x));
  const out = [];
  takeDownGroups(downs).forEach((members, uid) => {
    members.forEach((r) => (r.releases || []).forEach((x) => {
      const p = normUid(x.uid);
      if (p && !isDone(p)) out.push({ ...r, sourceUid: p, dryWeightLb: lb(x.lb), unbuckedLb: lb(x.lb), result: 'pass',
        releasedFrom: uid, date: String(x.at || r.date || '').slice(0, 10) });
    }));
    const pass = members.filter((r) => r.result === 'pass');
    if (pass.length && !isDone(uid)) out.push({ ...combineTakeDowns(uid, pass), date: pass[pass.length - 1].date });
  });
  return out;
}

// Every lot that's been through Bucking (Hand Trim's Lot Number list),
// newest first, one per UID (its latest submitted Bucking record), with the
// customer ID traced back through Take Down to Wet Intake when Take Down
// didn't carry it. `openBucks` (Bucking pages still open) adds the lots
// still being bucked that have some flower logged, `inProgress: true`, with
// `buckedFlowerLb` what's been bucked so far and `buckDraftId` the page.
function buckedLots(bucks, downs, intakes, openBucks) {
  const groups = takeDownGroups(downs);
  const takeDownFor = (uid) => {
    for (const [u, members] of groups) {
      if (uidTailMatch(u, uid)) return members[0];
      const part = members.find((r) => (r.releases || []).some((x) => uidTailMatch(x.uid, uid)));
      if (part) return part;
    }
    return null;
  };
  const cidFor = (uid) => {
    const d = takeDownFor(uid);
    if (!d) return '';
    if (d.cid) return d.cid;
    const i = (intakes || []).find((x) => uidTailMatch(x.sourceUid, d.incomingUid));
    return (i && i.cid) || '';
  };
  const r2 = (x) => Math.round(x * 100) / 100;
  const open = (openBucks || []).filter((d) => d.fields && d.fields.sourceUid).map((d) => ({
    ...d.fields, strain: d.fields.strain || d.strain || '', date: d.fields.date || d.work_date || '',
    buckedFlowerLb: r2(buckedLb(d.fields)),
    inProgress: true, buckDraftId: d.id }))
    // Nothing bucked yet means nothing to trim yet.
    .filter((l) => l.buckedFlowerLb > 0);
  const newest = (a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.submittedAt || '').localeCompare(String(a.submittedAt || ''));
  const seen = new Set();
  // A submitted Bucking record wins over a page still open on the same UID.
  return [...[...(bucks || [])].sort(newest), ...open.sort(newest)]
    .filter((r) => { const u = normUid(r.sourceUid); if (!u || seen.has(u)) return false; seen.add(u); return true; })
    .sort(newest)
    .map((r) => ({ ...r, sourceUid: normUid(r.sourceUid), cid: r.cid || cidFor(r.sourceUid) }));
}

// The trimming queue in order: lots in the manager's saved order first,
// then any not in it yet, oldest bucked first.
function orderTrimQueue(lots, queue) {
  const order = (queue && queue.order) || [];
  const pos = (p) => { const i = order.findIndex((u) => uidTailMatch(u, p.sourceUid)); return i < 0 ? Infinity : i; };
  return [...(lots || [])].sort((a, b) => (pos(a) - pos(b)) || String(a.date || '').localeCompare(String(b.date || ''))
    || String(a.strain || '').localeCompare(String(b.strain || '')));
}

// The bucking queue in order: packages in the manager's saved order first,
// then any not in it yet, oldest Take Down first.
function orderBuckQueue(pkgs, queue) {
  const order = (queue && queue.order) || [];
  const pos = (p) => { const i = order.findIndex((u) => uidTailMatch(u, p.sourceUid)); return i < 0 ? Infinity : i; };
  return [...(pkgs || [])].sort((a, b) => (pos(a) - pos(b)) || String(a.date || '').localeCompare(String(b.date || ''))
    || String(a.strain || '').localeCompare(String(b.strain || '')));
}

// A strain's short code from the strain library (by name or another
// spelling), or '' if it has none.
function strainAbbr(reference, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  const hit = ((reference && reference.strains) || []).find((s) =>
    String(s.name || '').toLowerCase() === n || (s.aliases || []).some((a) => String(a).toLowerCase() === n));
  return (hit && hit.abbreviation) || '';
}

// Whether an intake's Drying Location ("1A", "Room 2B", "1A, 1B") includes
// `room` (a dryRooms id, or whatever was typed under Other).
const dryRoomKey = (s) => String(s || '').toUpperCase().replace(/ROOM|[^A-Z0-9]/g, '');
function inDryRoom(dryRoom, room) {
  const k = dryRoomKey(room);
  return !!k && String(dryRoom || '').split(/[,&/+]|\band\b|\by\b/i).some((p) => dryRoomKey(p) === k);
}

// Find the most recent record on `stageKey` whose sourceUid / newBuckedUid /
// newBigLeafUid matches, so downstream stages can prefill their input weight.
// loadSubmitted (ops_data.js) reads finalized Supabase rows when a project
// is configured and falls back to the static JSON otherwise — defined in a
// script tag that loads after this one, but not called until well after
// every page's scripts have finished loading.
async function findUpstream(stageKey, uid) {
  const rows = typeof loadSubmitted === 'function' ? await loadSubmitted(stageKey) : await loadStage(stageKey);

  // A station whose flow declares `perLine` (Fresh Plant Intake, say) can
  // hold several batches under one record — a truck's worth of lines, each
  // with its own UID. Match inside those lines and return the line merged
  // over its header record, so a downstream form sees one flat object
  // whichever kind of upstream record it came from.
  const station = typeof STATION_BY_KEY !== 'undefined' ? STATION_BY_KEY[stageKey] : null;
  const perLine = station && station.flow && station.flow.perLine;
  if (perLine) {
    const candidates = [];
    rows.forEach((r) => {
      (r[perLine.arrayField] || []).forEach((line) => {
        if (uidMatches(line[perLine.uidCol], uid)) candidates.push({ ...r, ...line });
      });
    });
    if (!candidates.length) return null;
    return candidates.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))[0];
  }

  // A part released off a held Take Down (buck_hold.html) goes on under
  // its own new tag: it's found by that tag, carries only its own pounds,
  // and is released. `unbuckedLb` is what's still there to buck: the
  // part's pounds, or the Take Down's dry weight less any parts released.
  const released = (r) => (r.releases || []).reduce((a, x) => a + (Number(x.lb) || 0), 0);
  const parts = [];
  rows.forEach((r) => (r.releases || []).forEach((x) => {
    if (uidMatches(x.uid, uid)) parts.push({ ...r, sourceUid: x.uid, dryWeightLb: Number(x.lb) || null, unbuckedLb: Number(x.lb) || null,
      result: 'pass', releasedFrom: r.sourceUid, submittedAt: x.at || r.submittedAt });
  }));
  let hits = rows.filter((r) =>
    uidMatches(r.sourceUid, uid) || uidMatches(r.newBuckedUid, uid) ||
    uidMatches(r.newBigLeafUid, uid) || uidMatches(r.harvestBatchName, uid))
    .map((r) => (r.releases || []).length && r.dryWeightLb != null
      ? { ...r, unbuckedLb: Math.max(0, Math.round((Number(r.dryWeightLb) - released(r)) * 100) / 100) }
      : { ...r, unbuckedLb: r.dryWeightLb });
  // Take Downs merged into one dry UID come back as one package, weights
  // added up (combineTakeDowns).
  if (stageKey === 'dry_check') {
    hits = [...takeDownGroups(hits).entries()].map(([u, members]) =>
      (members.length > 1 ? { ...combineTakeDowns(u, members), submittedAt: members[0].submittedAt } : members[0]));
  }
  const all = [...hits, ...parts];
  if (!all.length) return null;
  return all.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))[0];
}

// ── Offline queue ───────────────────────────────────────────────────────────
function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function writeQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}
function queueCount() {
  return readQueue().length;
}

async function postRecord(payload) {
  const res = await fetch(OPS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const err = new Error(data.error || `Submit failed (${res.status})`);
    // 4xx means the payload itself is bad — queueing it would just retry a
    // rejection forever, so surface it to the operator instead.
    err.permanent = res.status >= 400 && res.status < 500;
    throw err;
  }
  return data;
}

// Submits a station record. If the network is down (or the request fails for a
// reason that could clear up), the record is parked on the tablet and retried.
async function submitOperations(stationKey, fields) {
  const payload = {
    stationKey,
    clientId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    clientSubmittedAt: new Date().toISOString(),
    fields: { ...fields, sessionUser: sessionStorage.getItem('2cw_user_name') || null }
  };
  try {
    const data = await postRecord(payload);
    return { ok: true, id: data.id };
  } catch (err) {
    if (err.permanent) return { ok: false, error: err.message };
    const q = readQueue();
    q.push(payload);
    writeQueue(q);
    return { ok: true, queued: true };
  }
}

// Drains the offline queue oldest-first. Stops at the first failure so records
// keep their original order; the server dedupes on clientId if one slips twice.
async function flushQueue() {
  const q = readQueue();
  if (!q.length) return { sent: 0, remaining: 0 };
  let sent = 0;
  while (q.length) {
    try {
      await postRecord(q[0]);
      q.shift();
      sent++;
      writeQueue(q);
    } catch (err) {
      if (err.permanent) { q.shift(); writeQueue(q); continue; }
      break;
    }
  }
  return { sent, remaining: q.length };
}

// Renders the "N forms waiting to send" strip and keeps it current. Every page
// that can submit calls this once on load.
function mountQueueBanner(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const render = () => {
    const n = queueCount();
    if (!n) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.innerHTML = `<span>${n} ${t(n === 1 ? UI.pendingOne : UI.pendingMany)}</span>` +
                   `<button type="button" id="queue-send">${t(UI.sendNow)}</button>`;
    el.querySelector('#queue-send').onclick = async () => {
      el.querySelector('#queue-send').disabled = true;
      await flushQueue();
      render();
    };
  };
  render();
  window.addEventListener('online', async () => { await flushQueue(); render(); });
  if (navigator.onLine && queueCount()) flushQueue().then(render);
  setInterval(render, 5000);
}

// ── Daily summary (station.dailySummary) ────────────────────────────────────
// The hand-kept notebook page for one day: every employee # down the side
// (most pounds first),
// every flavor page across the top, the weight in each cell. `pages` are
// {id, status, strain, f: fields}; rows stamped with their own day
// (`cfg.dateCol`) count on that day, otherwise every row on the page does
// (the caller passes only that day's pages). A page shows when it has a
// weight on the day, or when `keep(page)` says so (the form's own page).
// `cfg.extra` (Bucking's recovered from leaf) is weight that's nobody's:
// one row of its own under the people (`extra.of(page)`, `extra.total`),
// counted in the flavor and grand totals.
// Grams (Smalls) or pounds (Bucking; Hand Trim weighs in grams and shows
// pounds — `fromGrams`). Used by the form's Daily Summary and the Today
// board's.
function dailySummaryGrid(cfg, pages, date, keep) {
  const onDay = (r) => !cfg.dateCol || String(r[cfg.dateCol] || '') === date;
  const inLb = cfg.unit === 'lb';
  const scale = cfg.fromGrams ? 1 / G_PER_LB : 1;
  const X = cfg.extra || null;
  const extraOf = (p) => (X ? (p.f[X.lines] || []).filter(onDay).reduce((a, r) => a + num(r[X.valueCol]), 0) * scale : 0);
  const used = pages.filter((p) => (p.f[cfg.lines] || []).some((r) => onDay(r) && num(r[cfg.valueCol]) > 0) || extraOf(p) > 0 || (keep && keep(p)));
  used.sort((a, b) => String(a.strain || '').localeCompare(String(b.strain || '')));
  const grid = {};   // emp -> page id -> grams (or lbs)
  used.forEach((p) => (p.f[cfg.lines] || []).filter(onDay).forEach((r) => {
    const emp = String(r[cfg.empCol] || '').trim();
    const g = num(r[cfg.valueCol]) * scale;
    if (!emp || !g) return;
    grid[emp] = grid[emp] || {};
    grid[emp][p.id] = (grid[emp][p.id] || 0) + g;
  }));
  const extraTotal = used.reduce((a, p) => a + extraOf(p), 0);
  const extra = extraTotal > 0 ? { l: X.l, of: extraOf, total: extraTotal } : null;
  const colTot = (p) => emps.reduce((a, e) => a + (grid[e][p.id] || 0), 0) + extraOf(p);
  const empTot = (e) => Object.values(grid[e]).reduce((a, g) => a + g, 0);
  // Most pounds first; equal totals by employee #.
  const emps = Object.keys(grid).sort((a, b) => (empTot(b) - empTot(a)) || (Number(a) - Number(b)) || a.localeCompare(b));
  return { used, emps, grid, extra, colTot, empTot, all: emps.reduce((a, e) => a + empTot(e), 0) + extraTotal, inLb, dp: inLb ? 2 : 0 };
}

// ── Formatting ──────────────────────────────────────────────────────────────
const fmtNum = (x, dp = 2) =>
  (x === null || x === undefined || !Number.isFinite(Number(x)))
    ? '—'
    : Number(x).toLocaleString(getLang() === 'es' ? 'es-MX' : 'en-US',
        { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtPct = (x, dp = 1) =>
  (x === null || x === undefined || !Number.isFinite(Number(x))) ? '—' : `${(Number(x) * 100).toFixed(dp)}%`;
const fmtLb = (x) => `${fmtNum(x, 2)} lb`;

// Mounts the EN/ES toggle. Switching reloads so every label re-renders from the
// station definitions — simpler and less bug-prone than live-swapping the DOM.
function mountLangToggle(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const lang = getLang();
  el.innerHTML = ['en', 'es'].map((l) =>
    `<button type="button" data-lang="${l}" class="${l === lang ? 'on' : ''}">${l.toUpperCase()}</button>`).join('');
  el.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { setLang(b.dataset.lang); location.reload(); };
  });
  document.documentElement.lang = lang;
}
