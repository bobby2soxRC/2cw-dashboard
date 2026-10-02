// 2CW Operations Hub — shared config.
//
// Pulled out of index.html so admin.html (user management) can reuse the
// exact same card list / sheet-column mapping / commission mapping without
// drifting out of sync. Loaded as a plain <script> (no build step, no
// modules) — everything here is a global, same as operations_stations.js.

// ── MEMBER DIRECTORY CSV URL ──────────────────────────────
// Still used as the fallback source when Supabase (app_users) isn't
// configured, and by admin.html's "Import from Sheet" one-time migration.
const DIRECTORY_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTvUb2y2US1Qcyf12mngWEcvdCU3Yh9vgIzN_5-6x1psQRCIkG9Y4velrdcBB9zEw/pub?gid=165442896&single=true&output=csv';

// ── CARD DEFINITIONS ─────────────────────────────────────
// key must match column headers in the sheet (lowercase, spaces→ as-is)
// ── DEPARTMENT TREE ───────────────────────────────────────
// `dept` places a card in the new folder-structured hub (see index.html's
// buildTree()/resolvePath()): a card with `pinned: true` (e.g. 'executive',
// 'tasks_dashboard') sits at the root and is never nested — any number of
// cards can be pinned, they all show up together; everything else lives
// under its dept, optionally one level deeper
// under `subdept` (Operations is the only department with subdepts today —
// Cultivation/Processing/Manufacturing, matching operations_stations.js's
// own `dept` field on each station, which buildTree() merges in alongside
// these cards). A department with zero visible cards for a user simply
// doesn't appear — Marketing and Finance aren't referenced anywhere yet
// because there's nothing to put in them.
const CARD_DEFS = [
  {
    key: 'kss_dashboard',
    color: 'green',
    label: 'Sales',
    dept: 'sales',
    title: 'KSS Leaderboard',
    desc: 'KSS account performance, territory coverage, and sales activity across the distribution network.',
    href: '/kss_dashboard.html'
  },
  {
    key: 'twocw_dashboard',
    color: 'green',
    label: 'Sales',
    dept: 'sales',
    title: 'Sales Leaderboard',
    desc: 'Rep performance, account status, upsell opportunities, and coverage across all 2CW accounts.',
    href: '/twocw_dashboard.html'
  },
  {
    key: 'pipeline',
    color: 'blue',
    label: 'Sales',
    dept: 'sales',
    title: 'Pipeline',
    desc: 'Live view of what\'s currently in production — by stage, brand, and strain. Updated from the production sheet.',
    href: '/pipeline.html'
  },
  {
    key: 'inventory',
    color: 'gold',
    label: 'Manufacturing',
    dept: 'operations',
    subdept: 'manufacturing',
    title: 'Inventory & Production',
    desc: 'Current inventory levels, days of supply, and production planning recommendations by product group.',
    href: '/inventory.html'
  },
  {
    key: 'canix_inventory',
    color: 'green',
    label: 'Operations',
    dept: 'operations',
    title: 'Canix Inventory',
    desc: 'Live on-hand cultivation/manufacturing/distribution inventory across all 16 Canix licenses, by farm and stage.',
    href: '/canix_inventory.html'
  },
  {
    key: 'sales',
    color: 'green',
    label: 'Sales',
    dept: 'sales',
    title: 'Sales Dashboard',
    desc: 'Monthly revenue by brand, MTD pacing and trajectory, product mix, and 12-month trend analysis.',
    href: '/sales.html'
  }
,
  {
    key: 'mendo',
    color: 'mendo',
    label: 'Partners',
    dept: 'partners',
    title: 'Mendo Dashboard',
    desc: 'Mendo brand sales performance, inventory levels, and production pipeline — dedicated partner view.',
    href: '/mendo.html'
  },
  {
    key: 'executive',
    color: 'purple',
    label: 'Executive',
    dept: 'executive',
    pinned: true,
    title: 'Executive Dashboard',
    desc: 'High-level sales pacing, inventory health, and rep leaderboards — the one-page view for leadership.',
    href: '/executive.html'
  },
  {
    key: 'field_forms',
    color: 'gold',
    label: 'Sales',
    dept: 'sales',
    title: 'Field Forms',
    desc: 'Log budtender trainings, buyer meetings, staff samples, and store visits from the field.',
    href: '/field_forms.html'
  },
  {
    key: 'menu_health',
    color: 'gold',
    label: 'Manufacturing',
    dept: 'operations',
    subdept: 'manufacturing',
    title: 'Menu Health',
    desc: 'Mix, freshness, and volume scores rolled up from T-SKU to B-SKU to Brand — with a trend over time.',
    href: '/menu_health.html'
  },
  {
    key: 'production_requests',
    color: 'gold',
    label: 'Manufacturing',
    dept: 'operations',
    subdept: 'manufacturing',
    title: 'Production Requests',
    desc: 'Weekly production requests and material sourcing slots for Howie Roll, Soma Rosa Farms, and Mendo — read-only, synced hourly from the Production Requests Sheet.',
    href: '/production.html'
  },
  {
    key: 'preroll_dashboard',
    color: 'purple',
    label: 'Manufacturing',
    dept: 'operations',
    subdept: 'manufacturing',
    title: 'Pre-Roll Dashboard',
    desc: 'Pre-roll production requests from the Sheet — assign the strain, schedule start and finish dates, and see each batch’s progress.',
    href: '/preroll_dashboard.html'
  },
  {
    key: 'menu',
    color: 'green',
    label: 'Sales',
    dept: 'sales',
    title: 'Menu',
    desc: 'This week\'s Howie Roll, Soma Rosa, and Mendo menu — toggle NorCal (Alameda) and SoCal (Van Nuys) to see what each warehouse has on hand.',
    href: '/menu.html'
  },
  {
    key: 'production_dashboard',
    color: 'blue',
    label: 'Processing',
    dept: 'operations',
    subdept: 'processing',
    ambient: true, // auto-granted alongside any station edit/view access (see index.html buildHub) —
                   // doesn't count toward the "only one real option" auto-collapse check, so a person
                   // with exactly one station still lands straight on it instead of a 2-tile chooser.
    title: 'Processing Dashboard',
    desc: 'Where every lot is, yield and loss by stage and strain, biomass on hand, and trimmer output.',
    href: '/operations_dashboard.html'
  },
  {
    key: 'drying_schedule',
    color: 'blue',
    label: 'Processing',
    dept: 'operations',
    subdept: 'processing',
    title: 'Drying Schedule',
    desc: 'Outside farms we dry for — farm, license, size, estimated intake dates and wet weight, on a timeline with the weekly load.',
    href: '/drying_schedule.html'
  },
  {
    key: 'harvest_intakes',
    color: 'blue',
    label: 'Processing',
    dept: 'operations',
    subdept: 'processing',
    // Gated by the admin panel's "Harvest Intakes" view/edit checkboxes
    // ('harvest_intakes' / 'harvest intakes edit' — edit implies view; see
    // buildHub in index.html). Edit lets someone change a submitted intake.
    title: 'Harvest Intakes',
    desc: 'Every wet harvest intake — open one to see the full record, or fix it and record the Metrc adjustment if you have edit access.',
    href: '/harvest_intakes.html'
  },
  {
    key: 'information_hub',
    color: 'green',
    label: 'Operations',
    dept: 'operations',
    // Shown to anyone with View on at least one INFO_HUB_SECTIONS entry
    // (admin panel → Information Hub; see buildHub in index.html). Each
    // section inside has its own View/Edit.
    title: 'Information Hub',
    desc: 'Reference lists the rest of the app runs on — strains, Canix facilities, yield forecasts, farm licenses and customer IDs.',
    href: '/information_hub.html'
  },
  {
    key: 'production_today',
    color: 'gold',
    label: 'Operations',
    dept: 'operations',
    ambient: true, // same reasoning as production_dashboard above
    title: 'Today — Live',
    desc: 'Every form in progress or finished today, updating live as it happens — for anyone with view access, whether or not they can edit it.',
    href: '/operations_today.html'
  },
  {
    key: 'brand_assets',
    color: 'blue',
    label: 'Sales',
    dept: 'sales',
    title: 'Brand Assets',
    desc: 'Logos, photography, and brand guidelines for 2CW and partner brands — shared Drive folder.',
    href: 'https://drive.google.com/drive/folders/1pb3zbrnUVXp1tBou8yIFSBFGON32df4T',
    external: true
  },
  {
    key: 'staff_hours',
    color: 'blue',
    label: 'Operations',
    dept: 'operations',
    title: 'Staff Hours',
    desc: 'Live clock-in status, daily/weekly hours, and schedule adherence — synced hourly from Connecteam.',
    href: '/staff_hours.html'
  },
  {
    key: 'tasks_dashboard',
    color: 'purple',
    label: 'Executive',
    dept: 'executive',
    pinned: true,
    title: 'Ops Gameplan Tracker',
    desc: 'The VP-of-Ops 30/60/90 plan as editable tasks and subtasks — status, owners, due dates, and CSV import.',
    href: '/tasks_dashboard.html'
  },
  {
    key: 'task_oversight',
    color: 'purple',
    label: 'Executive',
    dept: 'executive',
    pinned: true,
    title: 'Task Activity (All Staff)',
    desc: 'Every My Tasks assignment across the whole team — who has what, status, overdue, and how long tasks take to close. Grant per person in the admin panel.',
    href: '/task_oversight.html'
  },
  {
    key: 'my_responsibilities',
    color: 'blue',
    label: 'Operations',
    dept: 'operations',
    pinned: true,
    title: 'My Responsibilities',
    desc: 'What you personally own or back up, pulled live from the Responsibilities Matrix — updates the moment something gets assigned to you.',
    href: '/my_responsibilities.html'
  },
  {
    key: 'my_tasks',
    color: 'blue',
    label: 'Operations',
    dept: 'operations',
    pinned: true,
    title: 'My Tasks',
    desc: 'Tasks assigned to you and tasks you\'ve handed out — statuses, notes, due dates, and follow-up dates. Plus your job description & responsibilities.',
    href: '/my_tasks.html'
  }
  // Commission card is handled separately (see commCardDef in index.html) —
  // it's dept: 'sales' too.
  //
  // The old 'production' card (Processing Stations, → operations.html) is
  // gone on purpose: its job — picking a Cultivation/Processing/Manufacturing
  // station — is now what the Operations department branch of the tree does
  // natively, so a separate flat "station picker" card would just duplicate it.
];

// ── SPANISH HUB TEXT ──────────────────────────────────────
// The hub's EN/ES toggle (index.html) swaps card titles/descriptions, the
// small dept labels, and folder names from these maps. CARD_DEFS above stays
// the English source of truth (admin.html reads it); a card missing here just
// shows in English. Station cards already carry {en, es} in
// operations_stations.js and don't need entries.
const CARD_ES = {
  kss_dashboard:       { title: 'Clasificación KSS', desc: 'Rendimiento de cuentas KSS, cobertura de territorio y actividad de ventas en toda la red de distribución.' },
  twocw_dashboard:     { title: 'Clasificación de Ventas', desc: 'Rendimiento por vendedor, estado de cuentas, oportunidades de venta adicional y cobertura en todas las cuentas de 2CW.' },
  pipeline:            { title: 'Producción en Curso', desc: 'Vista en vivo de lo que está en producción — por etapa, marca y cepa. Actualizado desde la hoja de producción.' },
  inventory:           { title: 'Inventario y Producción', desc: 'Niveles de inventario actuales, días de suministro y recomendaciones de producción por grupo de producto.' },
  canix_inventory:     { title: 'Inventario Canix', desc: 'Inventario en vivo de cultivo/manufactura/distribución en las 16 licencias de Canix, por granja y etapa.' },
  sales:               { title: 'Panel de Ventas', desc: 'Ingresos mensuales por marca, ritmo y tendencia del mes, mezcla de productos y análisis de 12 meses.' },
  mendo:               { title: 'Panel de Mendo', desc: 'Ventas, inventario y producción de la marca Mendo — vista dedicada para el socio.' },
  executive:           { title: 'Panel Ejecutivo', desc: 'Ritmo de ventas, salud del inventario y clasificación de vendedores — la vista de una página para la dirección.' },
  field_forms:         { title: 'Formularios de Campo', desc: 'Registra capacitaciones de budtenders, reuniones con compradores, muestras al personal y visitas a tiendas.' },
  menu_health:         { title: 'Salud del Menú', desc: 'Puntajes de mezcla, frescura y volumen de T-SKU a B-SKU a Marca — con la tendencia en el tiempo.' },
  production_requests: { title: 'Solicitudes de Producción', desc: 'Solicitudes semanales de producción y espacios de abastecimiento para Howie Roll, Soma Rosa Farms y Mendo — solo lectura, sincronizado cada hora.' },
  preroll_dashboard:   { title: 'Panel de Pre-Rolls', desc: 'Solicitudes de producción de pre-rolls — asigna la cepa, programa fechas de inicio y fin, y ve el avance de cada lote.' },
  menu:                { title: 'Menú', desc: 'El menú de esta semana de Howie Roll, Soma Rosa y Mendo — cambia entre NorCal (Alameda) y SoCal (Van Nuys) para ver qué hay en cada almacén.' },
  production_dashboard:{ title: 'Panel de Procesamiento', desc: 'Dónde está cada lote, rendimiento y merma por etapa y cepa, biomasa disponible y producción de los trimmers.' },
  drying_schedule:     { title: 'Calendario de Secado', desc: 'Granjas externas para las que secamos — granja, licencia, tamaño, fechas estimadas de entrada y peso húmedo, con la carga semanal.' },
  harvest_intakes:     { title: 'Recepciones de Cosecha', desc: 'Todas las recepciones de cosecha húmeda — abre una para ver el registro completo, o corrígela y registra el ajuste en Metrc si tienes acceso de edición.' },
  information_hub:     { title: 'Centro de Información', desc: 'Las listas de referencia que usa el resto de la app — variedades, instalaciones de Canix, pronósticos de rendimiento, licencias de ranchos e IDs de clientes.' },
  production_today:    { title: 'Hoy — En Vivo', desc: 'Cada formulario en progreso o terminado hoy, actualizado en vivo — para quien tenga acceso de vista, pueda editarlo o no.' },
  brand_assets:        { title: 'Recursos de Marca', desc: 'Logotipos, fotografía y guías de marca de 2CW y marcas socias — carpeta compartida de Drive.' },
  staff_hours:         { title: 'Horas del Personal', desc: 'Quién está marcado en este momento, horas diarias/semanales y cumplimiento del horario — sincronizado cada hora desde Connecteam.' },
  tasks_dashboard:     { title: 'Plan de Operaciones', desc: 'El plan 30/60/90 del VP de Operaciones como tareas y subtareas editables — estado, responsables, fechas y carga de CSV.' },
  task_oversight:      { title: 'Actividad de Tareas (Todo el Personal)', desc: 'Todas las tareas asignadas en el equipo — quién tiene qué, estado, vencidas y cuánto tardan en cerrarse.' },
  my_responsibilities: { title: 'Mis Responsabilidades', desc: 'Lo que te toca a ti o lo que respaldas, en vivo desde la Matriz de Responsabilidades.' },
  my_tasks:            { title: 'Mis Tareas', desc: 'Tareas asignadas a ti y las que tú asignaste — estados, notas y fechas. Además tu descripción de puesto y responsabilidades.' },
  commission_mine:     { title: 'Mis Comisiones', desc: 'Tu reporte de comisiones — selecciona las cuentas que trabajaste para generar el resumen de tu periodo de pago.' },
  commission_all:      { title: 'Comisiones', desc: 'Reportes de comisiones de todos los vendedores. Selecciona vendedor y periodo para generar el resumen.' }
};

// Small dept labels on cards, and folder names, English → Spanish.
const HUB_WORDS_ES = {
  'Sales': 'Ventas',
  'Partners': 'Socios',
  'Operations': 'Operaciones',
  'Executive': 'Ejecutivo',
  'Cultivation': 'Cultivo',
  'Processing': 'Procesamiento',
  'Manufacturing': 'Manufactura',
  'Folder': 'Carpeta'
};

// Per-user override: force a specific card order on the hub screen for
// that person (matched against the "user" column, case-insensitive).
// Cards the user doesn't have access to are skipped automatically;
// any of their cards not listed here fall in after these, in default order.
const CARD_ORDER_OVERRIDES = {
  'ned': ['executive', 'sales', 'inventory', 'twocw_dashboard', 'kss_dashboard', 'pipeline', 'mendo']
};

// The sections of information_hub.html, each with its own View / Edit
// columns in app_users.columns (edit implies view). index.html turns them
// into sessionStorage '2cw_info_access' ({ strains: 'edit', canix: 'view' …})
// at login; admin.html draws the checkboxes from this list; and the
// canix-facilities / canix-forecast functions re-check the edit column
// server-side before saving for a non-admin. Strain Library keeps the column
// names it had as its own card, so existing grants carry over.
const INFO_HUB_SECTIONS = [
  { key: 'strains',  view: 'strain_library',  edit: 'strain library edit',
    title: { en: 'Strain Library', es: 'Biblioteca de Variedades' }, editNote: 'add, rename and retire strains' },
  { key: 'canix',    view: 'canix facilities', edit: 'canix facilities edit',
    title: { en: 'Canix Facilities', es: 'Instalaciones de Canix' }, editNote: 'nicknames, stage, farm group' },
  { key: 'forecast', view: 'yield forecasts',  edit: 'yield forecasts edit',
    title: { en: 'Yield Forecasts', es: 'Pronósticos de Rendimiento' }, editNote: 'lbs/plant estimates and harvest plans' },
  { key: 'licenses', view: 'farm licenses',    edit: 'farm licenses edit',
    title: { en: 'Farm Licenses', es: 'Licencias de Ranchos' }, editNote: 'the forms’ Farm License list' },
  { key: 'cids',     view: 'customer ids',     edit: 'customer ids edit',
    title: { en: 'Customer IDs (CIDs)', es: 'IDs de Clientes (CIDs)' }, editNote: 'the forms’ CID list' }
];

// Card keys whose sheet column name doesn't match the key verbatim (e.g. has
// spaces). Card keys not listed here are looked up as-is.
const CARD_SHEET_COLS = {
  menu_health: 'menu health',
  brand_assets: 'brand assets',
  staff_hours: 'staff hours'
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

// ── SHARED USER DIRECTORY (for owner/assignee dropdowns) ──────────────────
// Same source/fallback story as index.html's login directory (Supabase
// app_users first, legacy sheet second), but returns the full row list
// rather than gating a login — used anywhere a page needs to let someone
// pick a person by name (Responsibilities tab's owner/backup dropdowns,
// my_responsibilities.html's "who am I" lookup). Kept separate from
// index.html's own loadDirectorySupabase()/loadDirectory() so the login
// path is never at risk of a change made for a dropdown.
async function loadUserDirectory(){
  try {
    if (typeof SUPABASE_URL === 'string' && SUPABASE_URL &&
        typeof SUPABASE_ANON_KEY === 'string' && SUPABASE_ANON_KEY &&
        typeof supabase !== 'undefined') {
      const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data, error } = await client.from('app_users').select('*').eq('active', true);
      if (!error && data) {
        return data.map(row => ({ ...(row.columns || {}), user: row.name, pin: row.pin }));
      }
    }
  } catch(e) {
    console.warn('Supabase directory fetch failed, falling back to sheet', e);
  }
  try {
    const res = await fetch(DIRECTORY_URL + '&t=' + Date.now());
    const text = await res.text();
    return parseCSV(text);
  } catch(e) {
    console.warn('Directory fetch failed', e);
    return [];
  }
}

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
