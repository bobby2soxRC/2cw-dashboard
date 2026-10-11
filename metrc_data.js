// ─────────────────────────────────────────────────────────────────────────────
// 2CW Metrc — browser data layer for metrc_recon.html and metrc_actions.html.
//
// Loads the three inputs metrc_recon.js needs (submitted station forms, the
// synced Metrc packages, and the statuses people have set), runs the
// reconciliation, and saves status changes. Needs ops_data.js (getClient,
// loadSubmitted) and metrc_recon.js loaded first.
// ─────────────────────────────────────────────────────────────────────────────

const METRC_TOL_KEY = '2cw_metrc_tolerance';
const METRC_LIC_KEY = '2cw_metrc_license';

// Supabase returns at most 1000 rows per request — page through the rest.
async function metrcSelectAll(client, table, build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(client.from(table).select('*')).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

function metrcTolerance() {
  try {
    const v = parseFloat(localStorage.getItem(METRC_TOL_KEY));
    if (Number.isFinite(v) && v >= 0) return v;
  } catch (e) { /* storage blocked */ }
  return MetrcRecon.DEFAULT_TOLERANCE_LB;
}
function setMetrcTolerance(v) { try { localStorage.setItem(METRC_TOL_KEY, String(v)); } catch (e) { /* ignore */ } }
function metrcLicense() { try { return localStorage.getItem(METRC_LIC_KEY) || ''; } catch (e) { return ''; } }
function setMetrcLicense(v) { try { localStorage.setItem(METRC_LIC_KEY, v || ''); } catch (e) { /* ignore */ } }

// → { issues (each with .status / .changed / .note / .updatedBy), packages,
//     appPackages, lastRun, licenses }
async function loadMetrcRecon(opts) {
  const client = getClient();
  if (!client) throw new Error('Supabase is not configured.');
  const stagesArr = await Promise.all(MetrcRecon.APP_STATIONS.map((k) => loadSubmitted(k)));
  const stages = Object.fromEntries(MetrcRecon.APP_STATIONS.map((k, i) => [k, stagesArr[i]]));
  const [packages, statuses, runs] = await Promise.all([
    metrcSelectAll(client, 'metrc_packages', (q) => q.eq('is_active', true).order('tag')),
    metrcSelectAll(client, 'metrc_recon_status', (q) => q.order('issue_key')),
    client.from('metrc_sync_runs').select('*').order('started_at', { ascending: false }).limit(5)
  ]);
  if (runs.error) throw new Error(`metrc_sync_runs: ${runs.error.message}`);

  const license = (opts && opts.license) || '';
  const appPackages = MetrcRecon.buildAppPackages(stages);
  const statusByKey = Object.fromEntries(statuses.map((s) => [s.issue_key, s]));
  // Reconcile against every license (an App package that moved to another
  // license isn't missing from Metrc), then narrow to the picked license.
  // In App, not in Metrc has no license to filter on, so it always shows.
  const issues = MetrcRecon.reconcile(appPackages, packages, { toleranceLb: opts && opts.toleranceLb })
    .filter((iss) => !license || iss.kind === 'app_only' || iss.license === license)
    .map((iss) => {
      const row = statusByKey[iss.key];
      const st = MetrcRecon.statusOf(iss, row);
      return { ...iss, status: st.status, changed: st.changed, note: row ? row.note : '',
               updatedBy: row ? row.updated_by : '', updatedAt: row ? row.updated_at : '' };
    });
  const licenses = [...new Set(packages.map((p) => p.license_number).filter(Boolean))].sort();
  const done = (runs.data || []).find((r) => r.finished_at);
  return { issues, packages, appPackages, lastRun: done || null, latestRun: (runs.data || [])[0] || null, licenses };
}

// status: 'known' | 'needs_attention'
async function saveMetrcStatus(iss, status, note, who) {
  const client = getClient();
  const row = {
    issue_key: iss.key, kind: iss.kind, tag: iss.tag, status,
    signature: status === 'known' ? iss.signature : null,
    note: note || null, updated_by: who || null
  };
  const { data, error } = await client.from('metrc_recon_status').upsert(row).select().single();
  if (error) throw new Error(error.message);
  return data;
}

// Display helpers shared by both pages.
const METRC_KIND = {
  metrc_only: { en: 'In Metrc, not in App', es: 'En Metrc, no en la App' },
  app_only: { en: 'In App, not in Metrc', es: 'En la App, no en Metrc' },
  weight: { en: 'Weight mismatch', es: 'Peso no coincide' }
};
const METRC_STATUS = {
  needs_attention: { en: 'Needs Attention', es: 'Requiere atención' },
  known: { en: 'Known', es: 'Conocido' }
};
function metrcStationTitle(key) {
  const s = typeof STATION_BY_KEY !== 'undefined' && STATION_BY_KEY[key];
  return s ? t(s.title) : key;
}
function metrcFmtAmount(v, unit) {
  if (v == null) return '—';
  return unit === 'each' ? `${Math.round(v).toLocaleString()} ea` : `${Number(v).toFixed(2)} lb`;
}
function metrcShortTag(tag) {
  const s = String(tag || '');
  return s.length > 6 ? `…${s.slice(-6)}` : s;
}
