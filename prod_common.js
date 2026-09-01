// ─────────────────────────────────────────────────────────────────────────────
// 2CW Production — shared runtime for the station forms and the dashboard.
//
// Three jobs:
//   1. Language (EN/ES) — every station label carries both, this picks one.
//   2. Data access — reference lists + the per-stage record files.
//   3. Submitting — including an offline queue, because wifi in the dry rooms
//      and out at the farms is not something a team lead should have to think
//      about mid-count.
// ─────────────────────────────────────────────────────────────────────────────

const PROD_ENDPOINT = '/.netlify/functions/submit-production';
const QUEUE_KEY = '2cw_prod_queue';
const LANG_KEY = '2cw_lang';

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
  back:          { en: '← Stations', es: '← Estaciones' }
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
const loadReference = () => loadJson('/data/production/reference.json', { strains: [], sites: [] });
const loadStage = (key) => loadJson(`/data/production/${key}.json`, []);

// Reference lists are objects ({id,label}) or bare strains ({name}); normalise
// both into the {v, label} shape the selects want.
function refOptions(reference, name) {
  const list = (reference && reference[name]) || [];
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

// Find the most recent record on `stageKey` whose sourceUid / newBuckedUid /
// newBigLeafUid matches, so downstream stages can prefill their input weight.
// loadSubmitted (prod_data.js) reads finalized Supabase rows when a project
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

  const hits = rows.filter((r) =>
    uidMatches(r.sourceUid, uid) || uidMatches(r.newBuckedUid, uid) ||
    uidMatches(r.newBigLeafUid, uid) || uidMatches(r.harvestBatchName, uid));
  if (!hits.length) return null;
  return hits.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))[0];
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
  const res = await fetch(PROD_ENDPOINT, {
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
async function submitProduction(stationKey, fields) {
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
