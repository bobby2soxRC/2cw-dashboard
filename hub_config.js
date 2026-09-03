// 2CW Operations Hub — shared config.
//
// Pulled out of index.html so admin.html (user management) can reuse the
// exact same card list / sheet-column mapping / commission mapping without
// drifting out of sync. Loaded as a plain <script> (no build step, no
// modules) — everything here is a global, same as production_stations.js.

// ── MEMBER DIRECTORY CSV URL ──────────────────────────────
// Still used as the fallback source when Supabase (app_users) isn't
// configured, and by admin.html's "Import from Sheet" one-time migration.
const DIRECTORY_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTvUb2y2US1Qcyf12mngWEcvdCU3Yh9vgIzN_5-6x1psQRCIkG9Y4velrdcBB9zEw/pub?gid=165442896&single=true&output=csv';

// ── CARD DEFINITIONS ─────────────────────────────────────
// key must match column headers in the sheet (lowercase, spaces→ as-is)
const CARD_DEFS = [
  {
    key: 'kss_dashboard',
    color: 'green',
    label: 'Sales',
    title: 'KSS Leaderboard',
    desc: 'KSS account performance, territory coverage, and sales activity across the distribution network.',
    href: '/kss_dashboard.html'
  },
  {
    key: 'twocw_dashboard',
    color: 'green',
    label: 'Sales',
    title: 'Sales Leaderboard',
    desc: 'Rep performance, account status, upsell opportunities, and coverage across all 2CW accounts.',
    href: '/twocw_dashboard.html'
  },
  {
    key: 'pipeline',
    color: 'blue',
    label: 'Production',
    title: 'Pipeline',
    desc: 'Live view of what\'s currently in production — by stage, brand, and strain. Updated from the production sheet.',
    href: '/pipeline.html'
  },
  {
    key: 'inventory',
    color: 'gold',
    label: 'Inventory',
    title: 'Inventory & Production',
    desc: 'Current inventory levels, days of supply, and production planning recommendations by product group.',
    href: '/inventory.html'
  },
  {
    key: 'sales',
    color: 'green',
    label: 'Sales',
    title: 'Sales Dashboard',
    desc: 'Monthly revenue by brand, MTD pacing and trajectory, product mix, and 12-month trend analysis.',
    href: '/sales.html'
  }
,
  {
    key: 'mendo',
    color: 'mendo',
    label: 'Partner',
    title: 'Mendo Dashboard',
    desc: 'Mendo brand sales performance, inventory levels, and production pipeline — dedicated partner view.',
    href: '/mendo.html'
  },
  {
    key: 'executive',
    color: 'purple',
    label: 'Executive',
    title: 'Executive Dashboard',
    desc: 'High-level sales pacing, inventory health, and rep leaderboards — the one-page view for leadership.',
    href: '/executive.html'
  },
  {
    key: 'field_forms',
    color: 'gold',
    label: 'Field Team',
    title: 'Field Forms',
    desc: 'Log budtender trainings, buyer meetings, staff samples, and store visits from the field.',
    href: '/field_forms.html'
  },
  {
    key: 'menu_health',
    color: 'gold',
    label: 'Inventory',
    title: 'Menu Health',
    desc: 'Mix, freshness, and volume scores rolled up from T-SKU to B-SKU to Brand — with a trend over time.',
    href: '/menu_health.html'
  },
  {
    key: 'menu',
    color: 'green',
    label: 'Sales',
    title: 'Menu',
    desc: 'This week\'s Howie Roll, Soma Rosa, and Mendo menu — toggle NorCal (Alameda) and SoCal (Van Nuys) to see what each warehouse has on hand.',
    href: '/menu.html'
  },
  {
    key: 'production',
    color: 'gold',
    label: 'Operations',
    title: 'Production Stations',
    desc: 'Harvest, drying, bucking, trimming, and manufacturing forms for the floor — bilingual, tablet-ready, and they work offline.',
    href: '/production.html'
  },
  {
    key: 'production_dashboard',
    color: 'blue',
    label: 'Operations',
    title: 'Production Dashboard',
    desc: 'Where every lot is, yield and loss by stage and strain, biomass on hand, and trimmer output.',
    href: '/production_dashboard.html'
  },
  {
    key: 'production_today',
    color: 'gold',
    label: 'Operations',
    title: 'Today — Live',
    desc: 'Every form in progress or finished today, updating live as it happens — for anyone with view access, whether or not they can edit it.',
    href: '/production_today.html'
  },
  {
    key: 'brand_assets',
    color: 'blue',
    label: 'Marketing',
    title: 'Brand Assets',
    desc: 'Logos, photography, and brand guidelines for 2CW and partner brands — shared Drive folder.',
    href: 'https://drive.google.com/drive/folders/1pb3zbrnUVXp1tBou8yIFSBFGON32df4T',
    external: true
  }
  // Commission card is handled separately (see commCardDef in index.html)
];

// Per-user override: force a specific card order on the hub screen for
// that person (matched against the "user" column, case-insensitive).
// Cards the user doesn't have access to are skipped automatically;
// any of their cards not listed here fall in after these, in default order.
const CARD_ORDER_OVERRIDES = {
  'ned': ['executive', 'sales', 'inventory', 'twocw_dashboard', 'kss_dashboard', 'pipeline', 'mendo']
};

// Card keys whose sheet column name doesn't match the key verbatim (e.g. has
// spaces). Card keys not listed here are looked up as-is.
const CARD_SHEET_COLS = {
  menu_health: 'menu health',
  brand_assets: 'brand assets'
};
// production, production_dashboard, and production_today are not sheet
// columns — they're derived from 'production edit stations' / 'production
// view stations', the same way field_forms is derived per-form.

// Commission columns in the sheet
const COMMISSION_COLS = ['commission niki','commission billy','commission john','commission jonathan','commission mac','commission emily'];
const COMMISSION_REP_MAP = {
  'commission niki': 'niki',
  'commission billy': 'billy',
  'commission john': 'john',
  'commission jonathan': 'jonathan',
  'commission mac': 'mac',
  'commission emily': 'emily'
};

// Sheet column (lowercased) -> form key, matches data/form_submissions/<key>.json
const FORM_ACCESS_COLS = {
  budtender_training: 'budtender training form',
  buyer_meeting: 'buyer meeting form',
  staff_sample: 'staff sample form',
  store_visit: 'merchandising form'
};

// ── PARSE CSV ────────────────────────────────────────────
function parseCSV(text){
  const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if(lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const users = [];
  for(let i = 1; i < lines.length; i++){
    const vals = lines[i].split(',').map(v => v.trim());
    if(!vals[0]) continue; // skip blank rows
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });
    users.push(row);
  }
  return users;
}
