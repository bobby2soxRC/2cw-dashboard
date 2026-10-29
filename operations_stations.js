// ─────────────────────────────────────────────────────────────────────────────
// 2CW Operations — station definitions.
//
// This is the single source of truth for the operations app: ops_form.html
// renders its forms straight off these definitions, and operations_dashboard.html
// reads the same `flow` descriptors to build the yield/inventory numbers. Adding
// a field to a station is a one-line edit here — no HTML to touch.
//
// Every user-visible string carries its Spanish translation inline, so a label
// and its translation can never drift apart.
//
// Field spec:
//   k      key stored in the record
//   t      text | number | date | time | select | textarea | uid | photo | calc | lineitems | check
//          | heading (a section title + hint inside the form; no value)
//   l      label {en, es}
//   req    required
//   ref    name of a list in data/operations/reference.json to populate a select
//          (or an array of names, merged in order)
//   opts   inline select options [{v, l:{en,es}}]
//   calc   (v) => number | null   — computed from the other values, read-only
//   dp     decimal places for number/calc display (default 2)
//   hint   {en, es} helper text under the field
//   showIf (v) => bool
//   oToZero (text) a letter O typed is turned into 0 as it's typed (Manifest #)
//   prefill 'lookup' — pull from the upstream stage record matching sourceUid
//   prPicker (text) a dropdown of the open pre-roll queue (preroll_queue.js)
//          plus "Other — type it"; picking one stores its ref (PR# / PQ-#)
//          and fills { fieldKey: item property } from `fills` (see
//          wirePrPickers in ops_form.html); `line` ('preroll' default, or
//          'pouch') picks which of the queue's work orders it lists
//   projectPicker (select) a dropdown of the open Master Schedule projects
//          (F.project — see wireProjectPicker in ops_form.html)
//   crewcheck  who's working, confirmed against the Master Schedule (Pre-Roll's
//          `attendance` — buildCrewCheck in ops_form.html); with `entry: true`
//          it merges across tablets like a running log
//   fill   a button, not a value: { keys: [three field keys], fill: (v, key) =>
//          number } — with all but one of `keys` filled in, works out the
//          missing one (Bucking's Calculate for stems / mold / floor waste).
//          A key can be an entry log: it's blank with no rows, and the
//          worked-out number goes in as one row.
//   entry  (lineitems) a running log instead of a grid: an entry bar plus Add,
//          rows stamped with an id/day/time and merged across tablets (see
//          buildEntryLog in ops_form.html). A `rownum` column numbers the
//          rows 1, 2, 3… by itself (Take Down's and Bucking's Box #).
//   legacyTotal (entry log) a record saved with no rows but this key set
//          (the field was one number before) opens with that number as
//          its first row (Bucking's stems).
//   group  (lineitems, with `lots`) { k, t, ref, allowOther, req, l, add } —
//          the rows come in tables, one per value of `k` picked at the
//          table's top (Harvest's source license); every row carries it, and
//          `add` labels the button for another table. On a `splitBy` field
//          it's lifted onto each record like a `lift` column.
//   lots   (lineitems, with `group`) { cols, bins, plantsReq, add, scan,
//          addBin } — each table holds strain boxes ("lots"): `lots.cols`
//          filled once per box (Source UID, strain, …), then a row per bin
//          with the field's own `cols`. Every bin row carries its box's
//          values (and `_lot`, `bin`), and they're lifted onto each record.
//          A scan box adds a box per new UID; `plantsReq` wants a plant
//          count on at least one bin of each box (buildLotSheet).
//   platePicker (select) Harvest's License Plate: the plates already used on
//          Harvest forms, plus Other to type a new one (ops_form.html)
//   driverPicker (select) Harvest's Driver: the drivers table, "Name — ID #",
//          with a panel to add a new driver (name, ID #, photo of the ID)
//          through netlify/functions/drivers.js. Sets driver (the name),
//          driverIdNumber and driverId.
//   picker { list: 'incoming' } (uid) Wet Intake's package: the packages on
//          their way to us in Canix (incomingPackages in metrc_transfers.js),
//          plus "Not listed — type the UID". Picking one fills and locks
//          the `strain` field (see wireIncoming in ops_form.html).
//   truckPicker (select) Wet Intake's Truck #: numbered per day, one per
//          manifest — today's trucks plus the next new one (ops_form.html)
//   tare   (lineitems column) a dropdown of bin tares (TARE_PRESETS plus the
//          ones added with Other — the shared intake_tares row); stores the
//          weight in the column's key and the name in `tareName`
//   editOnly hidden on a new form, shown when a submitted record is opened
//          with Edit (like `fromCanix`). A PERSON_FIELDS key (completedBy)
//          with it is filled with the logged-in user on submit.
//
// Station options:
//   share    after submit, a window to send a picture of the load and a CSV
//            of its rows (WhatsApp, through the phone's share sheet) —
//            openShare in ops_form.html. Harvest.
//   splitBy  key of a lineitems field whose rows carry sourceUid/strain — on
//            submit the form is saved as one record per distinct UID+strain
//            (see splitRecords in ops_form.html). Columns marked `lift: true`
//            are copied from the UID's first row onto its record, like
//            sourceUid and strain are.
// ─────────────────────────────────────────────────────────────────────────────

// Grams per pound: 454, the industry's (and the floor's) round figure, not
// the exact 453.592.
const G_PER_LB = 454;

// Biomass categories — the vocabulary the inventory ledger is built from.
const BIOMASS = {
  wet_whole_plant: { en: 'Wet Whole Plant',   es: 'Planta entera húmeda' },
  dry_whole_plant: { en: 'Dry Whole Plant',   es: 'Planta entera seca' },
  bucked_flower:   { en: 'Bucked Flower',     es: 'Flor desvarada' },
  flower_a:        { en: 'Flower (A-Bud)',    es: 'Flor (Bud A)' },
  smalls_b:        { en: 'Smalls (B-Bud)',    es: 'Flor pequeña (Bud B)' },
  sugar_trim:      { en: 'Sugar Trim',        es: 'Hoja azucarada' },
  trim:            { en: 'Trim',              es: 'Recorte' },
  trim_a_plus:     { en: 'Trim (A+)',         es: 'Recorte (A+)' },
  trim_a:          { en: 'Trim (A)',          es: 'Recorte (A)' },
  trim_b:          { en: 'Trim (B)',          es: 'Recorte (B)' },
  shake:           { en: 'Shake',             es: 'Shake' },
  big_leaf:        { en: 'Big Leaf',          es: 'Hoja grande' },
  stems:           { en: 'Stems',             es: 'Tallos' },
  waste:           { en: 'Waste',             es: 'Desecho' },
  fresh_frozen:    { en: 'Fresh Frozen',      es: 'Fresco congelado' }
};

// Wet Intake's bin tares (a `tare` column). Ones added with Other are kept
// in the shared operations_forms row 'intake_tares' (getTares in ops_data.js).
const TARE_PRESETS = [
  { name: 'Macro-Bin', lb: 55.5 },
  { name: 'Cardboard Box', lb: 16.5 }
];

// Categories that are sellable / usable biomass (the rest is waste or an
// intermediate that gets consumed by the next stage).
// What a Ground Flower Pouches run (and a pre-roll / pouch work order) can
// grind: flower, smalls and trim, A or A+.
const POUCH_INPUTS = ['flower_a', 'smalls_b', 'trim_a', 'trim_a_plus', 'trim'];
// Plain "Trim" is Hand Trim's Normal trim — say so next to A and A+.
const pouchInputLabel = (v) => (v === 'trim' ? { en: 'Trim (Normal)', es: 'Recorte (normal)' } : BIOMASS[v]);
const SELLABLE = ['flower_a', 'smalls_b', 'sugar_trim', 'trim', 'trim_a_plus', 'trim_a', 'trim_b', 'shake', 'fresh_frozen'];

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };
const sum = (v, keys) => keys.reduce((a, k) => a + num(v[k]), 0);
const pct = (part, whole) => (num(whole) > 0 ? num(part) / num(whole) : null);
// "HH:MM" → "HH:MM" in hours; an end earlier than the start is a shift that
// ran past midnight.
const hoursBetween = (start, end) => {
  const m = (s) => { const [h, mi] = String(s || '').split(':').map(Number); return Number.isFinite(h) && Number.isFinite(mi) ? h * 60 + mi : null; };
  const a = m(start), b = m(end);
  if (a === null || b === null) return null;
  return Math.round((((b - a) + 1440) % 1440) / 60 * 100) / 100;
};

// Shared field builders ------------------------------------------------------
const F = {
  date: () => ({ k: 'date', t: 'date', l: { en: 'Date', es: 'Fecha' }, req: true, today: true }),
  strain: () => ({ k: 'strain', t: 'select', ref: 'strains', allowOther: true, req: true,
                   l: { en: 'Strain', es: 'Variedad (cepa)' } }),
  site: () => ({ k: 'site', t: 'select', ref: 'sites', allowOther: true, req: true,
                 l: { en: 'Farm / Site', es: 'Rancho / sitio' } }),
  sourceUid: (lbl) => ({ k: 'sourceUid', t: 'uid', req: true, prefill: 'lookup',
                         l: lbl || { en: 'Source UID Tag', es: 'Etiqueta UID de origen' },
                         hint: { en: 'Metrc tag on the incoming package. Scan or type the last 4 to search.',
                                 es: 'Etiqueta Metrc del paquete entrante. Escanee o escriba los últimos 4 para buscar.' } }),
  teamLead: () => ({ k: 'teamLead', t: 'text', req: true,
                     l: { en: 'Team Lead', es: 'Líder de equipo' } }),
  crewSize: () => ({ k: 'crewSize', t: 'number', min: 0, step: 1, dp: 0,
                     l: { en: 'Crew Size', es: 'Tamaño del equipo' } }),
  laborHours: () => ({ k: 'laborHours', t: 'number', min: 0, step: 0.25,
                       l: { en: 'Labor Hours', es: 'Horas de trabajo' } }),
  notes: () => ({ k: 'notes', t: 'textarea', l: { en: 'Notes', es: 'Notas' } }),
  // The Master Schedule project this work is for (`projectPicker`: a
  // dropdown of the open projects — wireProjectPicker in ops_form.html).
  // The form's package(s) are added to the project's UIDs, so Labor Log
  // hours logged to the project are split over them (linkFormToProject in
  // ops_data.js). Stores the project id; `projectName` goes with it.
  project: () => ({ k: 'project', t: 'select', projectPicker: true,
                    l: { en: 'Project (Master Schedule)', es: 'Proyecto (Plan Maestro)' },
                    hint: { en: 'Pick the project this work is for. Its packages are linked to the project, so the Labor Log hours logged to the project count toward their labor cost.',
                            es: 'Elija el proyecto de este trabajo. Sus paquetes se vinculan al proyecto, así que las horas del Registro de mano de obra del proyecto cuentan en su costo laboral.' } }),
  // Per-employee hours on this batch/UID — the crewSize/laborHours fields above
  // give a station-level total; this is what actually links a numeric employee
  // ID to a specific batch, which is what a future payroll join needs (match
  // employee # + date here against employee # + date in a timeclock export to
  // get real labor cost per batch). Optional: a precision layer, not a gate.
  crew: () => ({ k: 'crew', t: 'lineitems',
    l: { en: 'Crew — Hours by Employee (optional)', es: 'Equipo — horas por empleado (opcional)' },
    hint: { en: 'One row per person, if you want labor cost tracked down to this batch. Skip it and the crew size/hours above still cover the total.',
            es: 'Una fila por persona, si desea rastrear el costo laboral hasta este lote. Si se omite, el tamaño del equipo y las horas de arriba siguen cubriendo el total.' },
    cols: [
      { k: 'employeeNo', t: 'text', l: { en: 'Employee #', es: 'N.º de empleado' }, inputmode: 'numeric' },
      { k: 'hours', t: 'number', l: { en: 'Hours', es: 'Horas' }, min: 0, step: 0.25 }
    ],
    totalCol: 'hours' }),
  photo: () => ({ k: 'photo', t: 'photo', l: { en: 'Photo (optional)', es: 'Foto (opcional)' },
                  hint: { en: 'Photo of the scale reading, tag, or paperwork.',
                          es: 'Foto de la báscula, la etiqueta o el papeleo.' } }),
  waste: () => ({ k: 'wasteLb', t: 'number', min: 0, step: 0.01,
                  l: { en: 'Waste (lbs)', es: 'Desecho (lbs)' },
                  hint: { en: 'Stems and water leaf destined for destruction.',
                          es: 'Tallos y hoja de agua destinados a destrucción.' } })
};

// Totals / variance block shared by every stage that converts an input weight
// into a set of output weights.
function totalsBlock(inputKey, outputKeys) {
  return [
    { k: 'totalOutputLb', t: 'calc', calc: (v) => sum(v, outputKeys),
      l: { en: 'Total Output (lbs)', es: 'Producción total (lbs)' } },
    { k: 'varianceLb', t: 'calc', calc: (v) => sum(v, outputKeys) - num(v[inputKey]), signed: true,
      l: { en: 'Variance (lbs)', es: 'Variación (lbs)' },
      hint: { en: 'Output minus input. Should be close to zero — a big negative means weight is missing.',
              es: 'Producción menos entrada. Debe ser cercano a cero — un negativo grande indica peso faltante.' } },
    { k: 'lossPct', t: 'calc', fmt: 'pct',
      calc: (v) => pct(num(v[inputKey]) - sum(v, outputKeys), v[inputKey]),
      l: { en: 'Stage Loss %', es: '% de pérdida de la etapa' } }
  ];
}

// What Bucking's loss is worked out against: everything that comes out of
// the boxes.
const BUCK_OUTPUTS = ['buckedFlowerLb', 'trimLb', 'stemLb', 'moldLb', 'floorWasteLb'];
// A Bucking page's bucked flower: everyone's (`bucked`) plus what was
// recovered from the leaf (`recovered`).
const buckedLb = (v) => [...(v.bucked || []), ...(v.recovered || [])].reduce((a, r) => a + num(r.weightLb), 0);

// Weight sign-off on a submitted form whose station has `weightCheck` (the
// output weight fields a manager confirms in the Metrc Queue before its
// Metrc work — tags, Done — can go ahead). The sign-off is
// fields.weightsConfirmed = {by, at, lbs: {field: value}}; it only counts
// while the weights still match what was confirmed, so a Fix form that
// changes one puts the form back to waiting. `checkKind: 'count'` (Pre-Roll,
// Ground Flower Pouches) is the same check on the run's counts — the
// Metrc Queue words it as count verification.
//   null       — the station has no weight check
//   'waiting'  — not confirmed yet
//   'changed'  — confirmed, but a weight has changed since
//   'confirmed'
const weightSnapshot = (station, fields) =>
  Object.fromEntries((station.weightCheck || []).map((k) => [k, Math.round(num((fields || {})[k]) * 100) / 100]));
function weightCheckState(station, fields) {
  if (!station || !station.weightCheck) return null;
  const c = (fields || {}).weightsConfirmed;
  // Runs from before the queue check were signed on the form itself.
  if (!c || !c.lbs) return station.checkKind === 'count' && (fields || {}).verifiedBy ? 'confirmed' : 'waiting';
  const now = weightSnapshot(station, fields);
  return Object.keys(now).every((k) => num(c.lbs[k]) === now[k]) ? 'confirmed' : 'changed';
}

// Product Transfer — Outgoing's product type codes (the paper form's list):
// `tab` is the Raw Inventory tab the package comes off, `cat` the biomass
// category when it has to match one; `pieces` rows are counted, not weighed.
const TRANSFER_TYPES = {
  1: { l: { en: 'Unbucked Flower', es: 'Flor sin desvarar' }, tab: 'onstem' },
  2: { l: { en: 'Bucked Flower', es: 'Flor desvarada' }, tab: 'bucked' },
  3: { l: { en: 'Trimmed Flower', es: 'Flor cortada' }, tab: 'flower', cat: 'flower_a' },
  4: { l: { en: 'Smalls', es: 'Smalls' }, tab: 'smalls', cat: 'smalls_b' },
  5: { l: { en: 'Trim / Biomass', es: 'Recorte / biomasa' }, tab: 'trim' },
  6: { l: { en: 'Fresh Frozen', es: 'Fresco congelado' }, tab: 'frozen', cat: 'fresh_frozen' },
  7: { l: { en: 'Seeds', es: 'Semillas' } },
  // Not in Raw Inventory: the outgoing form's Batch list for pre-rolls is
  // Canix's pre-roll packages and new runs (`stockTab`, ops_form.html).
  8: { l: { en: 'Pre-Rolls', es: 'Prerolls' }, pieces: true, stockTab: 'preroll' }
};
// The ones Product Transfer — Incoming takes: dry finished material Raw
// Inventory can hold on its own (on-stem and bucked stock come from the
// Bucking and trim queues, which an incoming package isn't in).
const TRANSFER_INTAKE_TYPES = [3, 4, 5, 6];

const OPERATIONS_STATIONS = [
  // ── CULTIVATION (PLACEHOLDER) ────────────────────────────────────────────
  // Everything below, up to Harvest, is a stub. Cultivation runs several real
  // processes today (clone/veg intake, feed schedules, IPM, defoliation,
  // field/stage transitions, pre-harvest sign-off...) and none of them are captured
  // yet — these three stations exist so the department shows up in the app
  // and the shape (date, batch tag, crew) is ready, not because the fields
  // below are the real SOP. Replace/expand them once cultivation's actual
  // process list is nailed down; nothing downstream depends on these three
  // keys or their fields, so they're free to change shape without breaking
  // the harvest-onward pipeline.
  {
    key: 'cult_batch_log',
    dept: { en: 'Cultivation', es: 'Cultivo' },
    title: { en: 'Plant Batch Log (placeholder)', es: 'Registro de lote de plantas (borrador)' },
    desc: { en: 'PLACEHOLDER — a new batch starting cultivation: clone/seed intake, or a stage move (veg → flower). Fields below are a stub pending the real process list.',
            es: 'BORRADOR — un nuevo lote que inicia cultivo: recepción de clones/semillas, o cambio de etapa (veg → flor). Los campos son un borrador pendiente del proceso real.' },
    color: 'green',
    headline: 'plantCount',
    fields: [
      F.date(), F.site(),
      { k: 'block', t: 'text', l: { en: 'Field / Block', es: 'Campo / bloque' } },
      { k: 'batchTag', t: 'uid', l: { en: 'Batch Tag / Metrc Plant Tag', es: 'Etiqueta de lote / etiqueta de planta Metrc' } },
      F.strain(),
      { k: 'stage', t: 'select', allowOther: true,
        l: { en: 'Stage', es: 'Etapa' },
        opts: [
          { v: 'clone', l: { en: 'Clone / Propagation', es: 'Clon / propagación' } },
          { v: 'veg', l: { en: 'Vegetative', es: 'Vegetativo' } },
          { v: 'flower', l: { en: 'Flower', es: 'Floración' } }
        ] },
      { k: 'plantCount', t: 'number', min: 0, step: 1, dp: 0,
        l: { en: 'Plant Count', es: 'Número de plantas' } },
      F.teamLead(), F.crewSize(), F.laborHours(), F.crew(), F.notes(), F.photo()
    ]
  },
  {
    key: 'cult_ipm_feed',
    dept: { en: 'Cultivation', es: 'Cultivo' },
    title: { en: 'IPM / Feed Log (placeholder)', es: 'Registro de IPM / alimentación (borrador)' },
    desc: { en: 'PLACEHOLDER — a feeding or pest/disease management application against a field/block or batch. Fields below are a stub pending the real product list and rates.',
            es: 'BORRADOR — una aplicación de alimentación o manejo de plagas/enfermedades a un campo/bloque o lote. Los campos son un borrador pendiente de la lista real de productos y dosis.' },
    color: 'green',
    headline: 'quantity',
    fields: [
      F.date(), F.site(),
      { k: 'block', t: 'text', l: { en: 'Field / Block', es: 'Campo / bloque' } },
      { k: 'batchTag', t: 'uid', l: { en: 'Batch Tag / Metrc Plant Tag', es: 'Etiqueta de lote / etiqueta de planta Metrc' } },
      { k: 'applicationType', t: 'select', allowOther: true,
        l: { en: 'Type', es: 'Tipo' },
        opts: [
          { v: 'feed', l: { en: 'Feed / Nutrients', es: 'Alimentación / nutrientes' } },
          { v: 'ipm', l: { en: 'IPM — Pest / Disease', es: 'IPM — plaga / enfermedad' } },
          { v: 'defoliation', l: { en: 'Defoliation', es: 'Defoliación' } }
        ] },
      { k: 'product', t: 'text', l: { en: 'Product / Mix', es: 'Producto / mezcla' } },
      { k: 'quantity', t: 'number', min: 0, step: 0.01, l: { en: 'Quantity Used', es: 'Cantidad usada' } },
      { k: 'unit', t: 'text', l: { en: 'Unit', es: 'Unidad' }, hint: { en: 'gal, oz, lb — whatever the product is measured in.', es: 'gal, oz, lb — como se mida el producto.' } },
      F.teamLead(), F.crewSize(), F.laborHours(), F.crew(), F.notes(), F.photo()
    ]
  },
  {
    key: 'cult_preharvest',
    dept: { en: 'Cultivation', es: 'Cultivo' },
    title: { en: 'Pre-Harvest Inspection (placeholder)', es: 'Inspección previa a cosecha (borrador)' },
    desc: { en: 'PLACEHOLDER — final sign-off before the harvest crew is called in. Fields below are a stub pending the real checklist.',
            es: 'BORRADOR — visto bueno final antes de llamar al equipo de cosecha. Los campos son un borrador pendiente de la lista de verificación real.' },
    color: 'green',
    headline: 'result',
    fields: [
      F.date(), F.site(),
      { k: 'block', t: 'text', l: { en: 'Field / Block', es: 'Campo / bloque' } },
      { k: 'batchTag', t: 'uid', l: { en: 'Batch Tag / Metrc Plant Tag', es: 'Etiqueta de lote / etiqueta de planta Metrc' } },
      F.strain(),
      { k: 'result', t: 'select', req: true,
        l: { en: 'Result', es: 'Resultado' },
        opts: [
          { v: 'ready', l: { en: 'Ready for harvest', es: 'Lista para cosecha' } },
          { v: 'hold', l: { en: 'Hold — not ready', es: 'En espera — no lista' } }
        ] },
      { k: 'inspectedBy', t: 'text', req: true, l: { en: 'Inspected By', es: 'Inspeccionado por' } },
      F.notes(), F.photo()
    ]
  },

  // ── CULTIVATION: HARVEST ─────────────────────────────────────────────────
  // The step before Wet Intake: the farm side of loading a truck. Built like
  // Wet Intake — one form per truck load, with a worksheet row per
  // bin carrying its strain's Source UID, strain, location and Transfer UID —
  // and split on submit into one record per Source UID (`splitBy`). Laid
  // out like the crew's notebook: a table per source license (`group`), a
  // box per strain in it (`lots` — scan a plant tag to start one), a row
  // per bin weighed; each record gets its license as `pid`. Crew and hours aren't
  // on this form — harvest labor is logged in the Labor Log.
  //
  // License Plate (`platePicker`) lists the plates already used on Harvest
  // forms, plus any new one typed in. Driver (`driverPicker`) is picked from
  // the drivers table (netlify/functions/drivers.js), or added there on the
  // spot with name, ID # and a photo of the ID; the record keeps the name,
  // ID # and the driver's row id (`driverId`). The ID photos are only seen in
  // the admin panel's Drivers tab.
  {
    key: 'harvest',
    dept: { en: 'Cultivation', es: 'Cultivo' },
    title: { en: 'Harvest', es: 'Cosecha' },
    desc: { en: 'Log a harvest load off the farm — one form per truck, with the Metrc UID, strain, plant count and wet weight on each row.',
            es: 'Registre una carga de cosecha del rancho — un formulario por camión, con el UID de Metrc, la variedad, el número de plantas y el peso húmedo en cada fila.' },
    color: 'green',
    headline: 'wetWeightLb',
    splitBy: 'lines',
    fields: [
      F.date(),
      { k: 'freshFrozen', t: 'check',
        l: { en: 'Fresh Frozen', es: 'Fresco congelado' } },
      { k: 'truckNo', t: 'text', l: { en: 'Truck #', es: 'N.º de camión' } },
      { k: 'licensePlate', t: 'select', platePicker: true, allowOther: true, req: true,
        l: { en: 'License Plate', es: 'Placa del vehículo' } },
      { k: 'driver', t: 'select', driverPicker: true, req: true,
        l: { en: 'Driver', es: 'Conductor' } },
      { k: 'lines', t: 'lineitems', req: true,
        l: { en: 'Load', es: 'Carga' },
        hint: { en: 'Pick the source license, then scan a plant tag (or tap + Add strain) for each strain on the truck — the strain fills in from Canix. Add its location and scan the Transfer UID, then weigh each bin. Plant count can go on each bin or once on any bin. Each strain is saved as its own harvest record.',
                es: 'Elija la licencia de origen y luego escanee una etiqueta de planta (o toque + Agregar variedad) por cada variedad del camión — la variedad se llena desde Canix. Agregue su ubicación y escanee el UID de transferencia, luego pese cada bin. El número de plantas puede ir en cada bin o una sola vez en cualquier bin. Cada variedad se guarda como su propio registro de cosecha.' },
        group: { k: 'pid', t: 'select', ref: 'properties', allowOther: true, req: true,
                 l: { en: 'Source License', es: 'Licencia de origen' },
                 add: { en: '+ Add another license', es: '+ Agregar otra licencia' } },
        // Each strain (lot) is a box under its license: these fields once,
        // then a row per bin. Every bin row carries the lot's fields.
        lots: {
          bins: 3,
          plantsReq: true,
          add: { en: '+ Add strain', es: '+ Agregar variedad' },
          scan: { en: 'Scan a plant tag to add a strain', es: 'Escanee una etiqueta de planta para agregar una variedad' },
          addBin: { en: '+ Add bin', es: '+ Agregar bin' },
          cols: [
            { k: 'sourceUid', t: 'uid', req: true, canixStrain: 'strain', canixPlants: true, l: { en: 'Source UID', es: 'UID de origen' } },
            { k: 'strain', t: 'select', ref: 'strains', allowOther: true, req: true, l: { en: 'Strain', es: 'Variedad' } },
            { k: 'location', t: 'text', l: { en: 'Location', es: 'Ubicación' } },
            { k: 'transferUid', t: 'uid', req: true, l: { en: 'Transfer UID', es: 'UID de transferencia' } }
          ]
        },
        cols: [
          { k: 'weight', t: 'number', req: true, l: { en: 'Wet Wt (lbs)', es: 'Peso húmedo (lbs)' }, min: 0, step: 0.01 },
          { k: 'plantCount', t: 'number', l: { en: 'Plant Count', es: 'N.º de plantas' }, min: 0, step: 1, inputmode: 'numeric' }
        ],
        totalCol: 'weight' },
      { k: 'plantCount', t: 'calc', dp: 0, calc: (v) => (v.lines || []).reduce((a, r) => a + num(r.plantCount), 0),
        l: { en: 'Total Plant Count', es: 'Número total de plantas' } },
      { k: 'binCount', t: 'calc', dp: 0, calc: (v) => (v.lines || []).filter((r) => num(r.weight) > 0).length,
        l: { en: 'Total Bins', es: 'Total de bins' } },
      { k: 'wetWeightLb', t: 'calc', calc: (v) => (v.lines || []).reduce((a, r) => a + num(r.weight), 0),
        l: { en: 'Total Wet Weight (lbs)', es: 'Peso húmedo total (lbs)' } },
      { k: 'lbPerPlant', t: 'calc',
        calc: (v) => {
          const plants = (v.lines || []).reduce((a, r) => a + num(r.plantCount), 0);
          return plants > 0 ? (v.lines || []).reduce((a, r) => a + num(r.weight), 0) / plants : null;
        },
        l: { en: 'Wet lbs / Plant', es: 'Lbs húmedos por planta' } },
      F.teamLead(), F.notes(), F.photo()
    ],
    // After submit: a picture of the load and a CSV of every bin, to send
    // on WhatsApp from the phone (openShare in ops_form.html).
    share: true,
    flow: { lossKind: 'origin', outputs: [{ field: 'wetWeightLb', category: 'wet_whole_plant' }] }
  },

  // ── PROCESSING: HARVEST INTAKE — WET ──────────────────────────────────────
  // The intake half of the paper "Harvest Intake & Take Down Log", filled out
  // the day the truck is unloaded. The take-down half happens 5–10 days
  // later, once the material is dry, and is its own form (dry_check, below).
  //
  // One form per package (since 2026-10-28, Kevin's Material Flow change
  // request; before that one form per truck, split per UID on submit — the
  // records it made look the same). The package is picked from what Canix
  // shows on its way to us, or scanned when it isn't listed; its strain comes
  // from Canix and is locked. Truck # groups the day's forms: numbered 1, 2…
  // per day by manifest across all farms (truckPicker).
  //
  // Each weigh-in row is a group of bins on the scale: the row's Weight is the
  // gross scale reading, and # of Bins × the tare comes off it, so the Total
  // Wet Weight Received is net of the bins.
  //
  // Fresh Frozen isn't a checkbox any more: a freezer location is Fresh
  // Frozen (isFreshFrozen in ops_common.js). No project question either —
  // intake labor isn't charged to a package; it stays facility cost. Person
  // Completing Form is whoever submits it, and the Metrc adjustment is made
  // afterwards from Harvest Intakes (`editOnly`).
  //
  // `fromCanix` fields (farm license, CID, manifest #, driver) are what the
  // Metrc manifest already says, so they're left off the form while the
  // truck is being weighed. The Canix sync
  // (scripts/canix_sync.py, fill_intakes_from_canix) finds each submitted
  // intake's package on its Metrc transfer and fills them in; until then the
  // intake shows "Waiting for Metrc sync" (awaitingCanix in ops_common.js).
  // They still show when a submitted intake is reopened with Edit, to type
  // them in by hand for a farm Canix doesn't see. Canix has no driver name —
  // that one stays on the manifest unless it's typed in on Edit. The
  // manifest # a picked package came on is kept as `incomingManifest` (for
  // the Truck #) — manifestNo stays for the sync to fill.
  {
    key: 'intake_wet',
    dept: { en: 'Processing', es: 'Procesamiento' },
    title: { en: 'Harvest Intake — Wet', es: 'Recepción de cosecha — húmeda' },
    desc: { en: 'Receive fresh/wet material off a farm truck — one form per package: pick or scan the package, then weigh its bins as they’re unloaded.',
            es: 'Reciba material fresco/húmedo de un camión del rancho — un formulario por paquete: elija o escanee el paquete y pese sus bins al descargar.' },
    color: 'blue',
    headline: 'totalWetLb',
    fields: [
      F.date(),
      { k: 'sourceUid', t: 'uid', req: true, picker: { list: 'incoming' },
        l: { en: 'Package', es: 'Paquete' },
        pickedLabel: { en: 'Package UID', es: 'UID del paquete' },
        hint: { en: 'Packages on their way to us in Metrc (from Canix, every 3 h). Not on the list? Pick “Not listed” and scan it or type the last 5.',
                es: 'Paquetes en camino a nosotros en Metrc (desde Canix, cada 3 h). ¿No aparece? Elija “No aparece” y escanéelo o escriba los últimos 5.' } },
      { k: 'strain', t: 'select', ref: 'strains', allowOther: true, req: true,
        l: { en: 'Strain', es: 'Variedad (cepa)' } },
      { k: 'truckNo', t: 'select', truckPicker: true, req: true,
        l: { en: 'Truck #', es: 'N.º de camión' },
        hint: { en: 'Numbered for the day: the first manifest is Truck 1, the next one Truck 2, across all farms. A package on a manifest already in is put on its truck.',
                es: 'Numerado por día: el primer manifiesto es el Camión 1, el siguiente el Camión 2, de todos los ranchos. Un paquete de un manifiesto ya recibido va en su camión.' } },
      { k: 'pid', t: 'select', ref: 'properties', allowOther: true, fromCanix: true,
        l: { en: 'Farm License', es: 'Licencia del rancho' } },
      { k: 'cid', t: 'select', ref: 'customers', allowOther: true, fromCanix: true, l: { en: 'Customer ID (CID)', es: 'ID de cliente (CID)' } },
      // All digits in Metrc; oToZero turns a typed letter O into 0 as it's typed.
      { k: 'manifestNo', t: 'text', inputmode: 'numeric', oToZero: true, fromCanix: true, l: { en: 'Manifest #', es: 'N.º de manifiesto' } },
      { k: 'driver', t: 'text', fromCanix: true, l: { en: 'Driver', es: 'Conductor' } },
      { k: 'completedBy', t: 'text', req: true, editOnly: true,
        l: { en: 'Person Completing Form', es: 'Persona que llena el formulario' } },
      // The facility's certified weighmasters (reference.json `weighmasters`).
      { k: 'weighmaster', t: 'select', ref: 'weighmasters', req: true,
        l: { en: '2CW Deputy Weighmaster', es: 'Pesador oficial adjunto de 2CW' } },
      // A freezer here makes it Fresh Frozen (isFreshFrozen).
      { k: 'dryRoom', t: 'select', ref: ['dryRooms', 'freezers'], allowOther: true, req: true,
        l: { en: 'Drying / Freezer Location(s)', es: 'Ubicación(es) de secado / congelador' },
        hint: { en: 'A freezer means Fresh Frozen.', es: 'Un congelador significa Fresco congelado.' } },
      { k: 'lines', t: 'lineitems', req: true,
        l: { en: 'Weigh-In — Bins', es: 'Pesaje — bins' },
        hint: { en: 'One row per group of bins on the scale. Weight is the scale reading; the bins’ tare is subtracted for you.',
                es: 'Una fila por cada grupo de bins en la báscula. El peso es la lectura de la báscula; la tara de los bins se resta automáticamente.' },
        // `carry` columns copy down into a new row from the one above and
        // don't by themselves make a row count as filled in; `req` columns
        // must be filled on any row that does count.
        cols: [
          { k: 'binCount', t: 'number', req: true, l: { en: '# of Bins', es: 'N.º de bins' }, min: 0, step: 1, inputmode: 'numeric' },
          { k: 'tareEachLb', t: 'tare', req: true, carry: true, l: { en: 'Tare (each bin)', es: 'Tara (c/u)' } },
          { k: 'weight', t: 'number', req: true, l: { en: 'Weight (lbs)', es: 'Peso (lbs)' }, min: 0, step: 0.01 }
        ],
        totalCol: 'weight' },
      { k: 'binCount', t: 'calc', dp: 0, calc: (v) => (v.lines || []).reduce((a, r) => a + num(r.binCount), 0),
        l: { en: 'Total Bins', es: 'Bins totales' } },
      { k: 'totalTareLb', t: 'calc', calc: (v) => (v.lines || []).reduce((a, r) => a + num(r.binCount) * num(r.tareEachLb), 0),
        l: { en: 'Total Tare (lbs)', es: 'Tara total (lbs)' } },
      { k: 'totalWetLb', t: 'calc',
        calc: (v) => (v.lines || []).reduce((a, r) => a + num(r.weight) - num(r.binCount) * num(r.tareEachLb), 0),
        l: { en: 'Total Wet Weight Received (lbs)', es: 'Peso húmedo total recibido (lbs)' },
        hint: { en: 'Scale weight minus bin tare.', es: 'Peso de báscula menos la tara de los bins.' } },
      // The weight can only be adjusted in Metrc after this form is in, so
      // it's recorded afterwards (Harvest Intakes → Edit), not at the door.
      { k: 'metrcAdjusted', t: 'select', editOnly: true,
        l: { en: 'Weight Adjusted in METRC', es: 'Peso ajustado en METRC' },
        opts: [
          { v: 'yes', l: { en: 'Yes — done', es: 'Sí — hecho' } },
          { v: 'no', l: { en: 'Not yet', es: 'Todavía no' } }
        ] },
      { k: 'metrcAdjustedLb', t: 'number', step: 0.01, editOnly: true,
        showIf: (v) => v.metrcAdjusted === 'yes',
        l: { en: 'Total Pounds Adjusted in METRC (lbs)', es: 'Libras totales ajustadas en METRC (lbs)' },
        hint: { en: 'The adjustment amount entered in Metrc — use a minus sign if the weight went down.',
                es: 'La cantidad del ajuste ingresada en Metrc — use un signo de menos si el peso bajó.' } },
      // Manifests come digitally now (the e-manifest in Metrc is the record),
      // so the photo is only for a paper one.
      { k: 'manifestPhoto', t: 'photo',
        l: { en: 'Manifest Photo (optional)', es: 'Foto del manifiesto (opcional)' },
        hint: { en: 'Only if a paper manifest came with the truck.',
                es: 'Solo si llegó un manifiesto en papel con el camión.' } },
      F.notes()
    ],
    flow: { outputs: [{ field: 'totalWetLb', category: 'wet_whole_plant', pending: true }] }
  },

  // ── PROCESSING: TAKE DOWN — DRY ───────────────────────────────────────────
  // The take-down half of the paper log: the dried material comes down 5–10
  // days after intake, gets boxed and weighed, and goes into Metrc under a
  // new on-stem package UID. The key stays 'dry_check' (it was "Post-Dry
  // Check") because Bucking looks up dry_check records by their sourceUid —
  // which is the on-stem UID here.
  // `incomingUid` is the farm package from Wet Intake; ops_analytics aliases
  // the on-stem UID back to it, so the dashboard sees one lot.
  {
    key: 'dry_check',
    dept: { en: 'Processing', es: 'Procesamiento' },
    title: { en: 'Take Down — Dry', es: 'Bajada — seca' },
    desc: { en: 'Take dried material down off the stem racks — box it, weigh it, and tag the new dry package for bucking.',
            es: 'Baje el material seco de los racks — empáquelo en cajas, péselo y etiquete el paquete seco nuevo para desvarado.' },
    color: 'blue',
    headline: 'dryWeightLb',
    fields: [
      F.date(),
      F.project(),
      // Pick the room first, then the package from what's still drying
      // there (`picker`: Wet Intakes with no Take Down yet, as "Strain -
      // last 4"). "Not listed" falls back to typing the UID.
      { k: 'dryRoom', t: 'select', ref: 'dryRooms', allowOther: true, req: true,
        l: { en: 'Drying Room', es: 'Cuarto de secado' } },
      { k: 'incomingUid', t: 'uid', req: true, prefill: 'lookup', picker: { from: 'intake_wet', room: 'dryRoom' },
        l: { en: 'Package Drying', es: 'Paquete secando' },
        // Shown under the dropdown once a package is picked (its full UID).
        pickedLabel: { en: 'Intake UID', es: 'UID de recepción' },
        hint: { en: 'Strain and last 4 of the intake package UID from Wet Intake. Pick it to pull in the intake details.',
                es: 'Variedad y últimos 4 del UID del paquete de la recepción húmeda. Elíjalo para traer los datos de recepción.' } },
      { k: 'sourceUid', t: 'uid', req: true,
        l: { en: 'New Dry UID', es: 'UID nuevo — seco' },
        hint: { en: 'The new Metrc tag for the dried package. This is the batch Bucking will see.',
                es: 'La nueva etiqueta Metrc del paquete seco. Este es el lote que verá Desvarado.' } },
      { k: 'strain', t: 'select', ref: 'strains', allowOther: true, req: true, prefill: 'lookup',
        l: { en: 'Strain', es: 'Variedad (cepa)' } },
      { k: 'pid', t: 'select', ref: 'properties', allowOther: true, prefill: 'lookup',
        l: { en: 'Farm License', es: 'Licencia del rancho' } },
      { k: 'cid', t: 'select', ref: 'customers', allowOther: true, prefill: 'lookup', l: { en: 'Customer ID (CID)', es: 'ID de cliente (CID)' } },
      { k: 'completedBy', t: 'text', req: true,
        l: { en: 'Person Completing Form', es: 'Persona que llena el formulario' } },
      { k: 'weighmaster', t: 'text', req: true,
        l: { en: 'Deputy Weighmaster', es: 'Pesador oficial adjunto' } },
      { k: 'storageLocation', t: 'select', ref: 'dryRooms', allowOther: true, req: true,
        l: { en: 'Storage Location(s)', es: 'Ubicación(es) de almacenamiento' } },
      { k: 'boxes', t: 'lineitems', req: true,
        l: { en: 'Boxes', es: 'Cajas' },
        hint: { en: 'One row per box. Weight is the net reading — the scale already tares the box.',
                es: 'Una fila por caja. El peso es la lectura neta — la báscula ya resta la tara de la caja.' },
        // No tare column since 2026-10-26 (the scale tares each box). Rows
        // saved before then may carry a `tareLb`; dryWeightLb still takes it
        // off so those records keep their dry weight if edited.
        cols: [
          { k: 'boxNo', t: 'rownum', l: { en: 'Box #', es: 'Caja #' } },
          { k: 'weight', t: 'number', l: { en: 'Weight (lbs)', es: 'Peso (lbs)' }, min: 0, step: 0.01 }
        ],
        totalCol: 'weight' },
      { k: 'boxCount', t: 'calc', dp: 0,
        calc: (v) => (v.boxes || []).filter((r) => num(r.weight) > 0).length,
        l: { en: 'Total Boxes', es: 'Cajas totales' } },
      { k: 'dryWeightLb', t: 'calc',
        calc: (v) => (v.boxes || []).reduce((a, r) => a + num(r.weight) - num(r.tareLb), 0),
        l: { en: 'Total Dry Weight (lbs)', es: 'Peso seco total (lbs)' },
        hint: { en: 'Sum of the box weights.', es: 'Suma de los pesos de las cajas.' } },
      { k: 'wetIntakeLb', t: 'number', min: 0, step: 0.01, prefill: 'lookup',
        l: { en: 'Wet Intake Weight (lbs)', es: 'Peso húmedo de entrada (lbs)' },
        hint: { en: 'Filled in from Wet Intake when the farm UID matches.',
                es: 'Se llena desde la recepción húmeda cuando coincide el UID del rancho.' } },
      { k: 'moistureLossLb', t: 'calc', calc: (v) => (num(v.wetIntakeLb) > 0 ? num(v.wetIntakeLb) - num(v.dryWeightLb) : null),
        l: { en: 'Moisture Loss (lbs)', es: 'Pérdida de humedad (lbs)' } },
      { k: 'moistureLossPct', t: 'calc', fmt: 'pct',
        calc: (v) => pct(num(v.wetIntakeLb) - num(v.dryWeightLb), v.wetIntakeLb),
        l: { en: 'Moisture Loss %', es: '% de pérdida de humedad' },
        hint: { en: 'Typically 70–80% on whole-plant hang dries.',
                es: 'Típicamente 70–80% en secado de planta entera.' },
        flag: (x) => x < 0.6 || x > 0.85 },
      { k: 'moisturePct', t: 'number', min: 0, max: 100, step: 0.1,
        l: { en: 'Moisture Meter Reading (%)', es: 'Lectura del medidor de humedad (%)' } },
      { k: 'waterActivity', t: 'number', min: 0, max: 1, step: 0.01, dp: 2,
        l: { en: 'Water Activity (aw)', es: 'Actividad de agua (aw)' } },
      { k: 'metrcAdjusted', t: 'select',
        l: { en: 'Weight Adjusted in METRC', es: 'Peso ajustado en METRC' },
        opts: [
          { v: 'yes', l: { en: 'Yes — done', es: 'Sí — hecho' } },
          { v: 'no', l: { en: 'Not yet', es: 'Todavía no' } }
        ] },
      // Bucking warns on anything but a 'pass' record — a normal take down
      // goes straight to bucking, so it defaults there. 'rework' is the
      // quality hold (its old value, kept so older records still read);
      // 'hold' (needs more dry time) is gone — that material just isn't
      // taken down yet — but stays readable on old records.
      { k: 'result', t: 'select', req: true, def: 'pass',
        l: { en: 'Release', es: 'Liberación' },
        hint: { en: 'A held package waits on Bucking → On hold until someone releases it there.',
                es: 'Un paquete en espera queda en Desvarado → En espera hasta que alguien lo libere ahí.' },
        opts: [
          { v: 'pass', l: { en: 'Release to bucking', es: 'Liberar a desvarado' } },
          { v: 'rework', l: { en: 'Hold — quality issue', es: 'En espera — problema de calidad' } },
          { v: 'hold_order', l: { en: 'Hold — until needed for an order', es: 'En espera — hasta que se necesite para un pedido' } }
        ] },
      F.notes(), F.photo()
    ],
    flow: { lossKind: 'moisture',
            input: { field: 'wetIntakeLb', category: 'wet_whole_plant' },
            outputs: [{ field: 'dryWeightLb', category: 'dry_whole_plant' }] }
  },

  // ── PROCESSING: BUCKING ───────────────────────────────────────────────────
  // One page per on-stem UID (flavor), built like Smalls: the switcher at the
  // top lists every open bucking page from anyone, and older pages stay
  // there until they're submitted, because a batch can take several days.
  // The page holds four running logs (`entry: true`: type the row, tap
  // Add, type the next one):
  //   boxes:  each box taken off the dry unbucked weight (box #, lbs)
  //   bucked: bucked flower by person (employee #, or a name if they have
  //           no number, and lbs)
  //   trim:   trim weighed during the batch (lbs)
  //   stems:  stems (palo) weighed at close-out (lbs), as many bins as needed
  // Submitting closes the batch, once the stems are weighed. The
  // record keeps the old Bucking field names (startingDryLb, buckedFlowerLb,
  // stemLb), so Machine Trim's prefill and the dashboard read it as before.
  // Bucking never mints a UID: the record stays under the on-stem tag Take
  // Down made, and that's what an operator types in at Machine Trim.
  {
    key: 'buck',
    dept: { en: 'Processing', es: 'Procesamiento' },
    title: { en: 'Bucking', es: 'Desvarado (bucking)' },
    desc: { en: 'One page per UID / flavor. Log boxes taken off the dry weight, each person’s bucked flower and the trim, then weigh the stems and submit.',
            es: 'Una hoja por UID / sabor. Registre las cajas que salen del peso seco, la flor desvarada de cada persona y el recorte; luego pese el palo y envíe.' },
    color: 'gold',
    headline: 'buckedFlowerLb',
    sharedDay: true,
    // Take Downs held for quality or for an order wait on their own page
    // until someone releases them (buck_hold.html).
    links: [{ href: '/buck_hold.html', l: { en: 'On-Stem Flower →', es: 'Flor en tallo →' } },
            { href: '/work_orders.html?tab=buck', l: { en: 'Work Orders →', es: 'Órdenes de trabajo →' } }],
    // A Queue tab next to the form: the order to buck in (set on the
    // On-Stem Flower page), with the strain, UID and starting weight.
    queueTab: true,
    // "Delete this page" under the form, for a page started by mistake.
    canDelete: true,
    // A batch often runs several days: a tab per day under the flavor tabs,
    // like Hand Trim and Pre-Roll. Boxes, bucked flower and trim show the
    // picked day and stamp new rows with it (the chips total bucked
    // flower); stems are close-out, so they stay whole-batch.
    dayTabs: { lines: ['bucked', 'recovered', 'boxes', 'trim'] },
    // The daily tally: person × flavor for one day. Each logged row carries
    // the day it was weighed (`day`), so a batch that runs three days shows
    // only that day's pounds.
    dailySummary: { lines: 'bucked', empCol: 'who', valueCol: 'weightLb', dateCol: 'day', unit: 'lb',
                    title: { en: 'Daily Summary — Bucked by Person', es: 'Resumen del día — desvarado por persona' },
                    hint: { en: 'Every bucking page, pounds weighed that day. Open pages included.',
                            es: 'Todas las hojas de desvarado, libras pesadas ese día. Incluye hojas abiertas.' },
                    empLabel: { en: 'Employee # / Name', es: 'N.º / nombre' },
                    // Flower recovered from the leaf isn't anyone's: one row
                    // of its own under the people.
                    extra: { lines: 'recovered', valueCol: 'weightLb',
                             l: { en: 'Recovered from leaf', es: 'Recuperado de la hoja' } } },
    fields: [
      F.date(),
      F.project(),
      // Picked from what's ready to buck (`picker`: released Take Downs and
      // released parts with no Bucking record yet, as "Strain || abbreviation
      // || last 4"). "Not listed" falls back to typing the UID.
      { k: 'sourceUid', t: 'uid', req: true, prefill: 'lookup', picker: { list: 'buckable' },
        l: { en: 'Package to Buck', es: 'Paquete para desvarar' },
        pickedLabel: { en: 'Package UID — On Stem', es: 'UID del paquete — en tallo' },
        hint: { en: 'Packages released to bucking at Take Down. Picking one fills in the UID, strain and dry weight.',
                es: 'Paquetes liberados a desvarado en la bajada. Al elegir uno se llenan el UID, la variedad y el peso seco.' } },
      { k: 'strain', t: 'select', ref: 'strains', allowOther: true, req: true, prefill: 'lookup',
        l: { en: 'Strain (flavor)', es: 'Variedad (sabor)' } },
      { k: 'dryUnbuckedLb', t: 'number', min: 0, step: 0.01, prefill: 'lookup',
        l: { en: 'Dry Unbucked Weight (lbs)', es: 'Peso seco sin desvarar (lbs)' },
        hint: { en: 'Filled in from Take Down when the UID matches.',
                es: 'Se llena desde la bajada cuando coincide el UID.' } },

      { k: 'boxes', t: 'lineitems', entry: true, req: true,
        l: { en: 'Boxes Taken Off the Dry Weight', es: 'Cajas que salen del peso seco' },
        hint: { en: 'Log each box as it comes off the dry unbucked weight.',
                es: 'Registre cada caja al sacarla del peso seco sin desvarar.' },
        cols: [
          { k: 'boxNo', t: 'rownum', l: { en: 'Box #', es: 'Caja #' } },
          { k: 'weightLb', t: 'number', l: { en: 'Weight (lbs)', es: 'Peso (lbs)' }, min: 0, step: 0.01, req: true, dp: 2 }
        ],
        totalCol: 'weightLb' },
      { k: 'startingDryLb', t: 'calc',
        calc: (v) => (v.boxes || []).reduce((a, r) => a + num(r.weightLb), 0),
        l: { en: 'Total Boxes Taken (lbs)', es: 'Total de cajas (lbs)' } },
      { k: 'dryLeftLb', t: 'calc', flag: (x) => x < 0,
        calc: (v) => (num(v.dryUnbuckedLb) > 0 ? num(v.dryUnbuckedLb) - (v.boxes || []).reduce((a, r) => a + num(r.weightLb), 0) : null),
        l: { en: 'Dry Unbucked Left (lbs)', es: 'Peso seco restante (lbs)' } },

      { k: 'bucked', t: 'lineitems', entry: true, req: true,
        l: { en: 'Bucked Flower — by Person', es: 'Flor desvarada — por persona' },
        hint: { en: 'Employee # if they have one, otherwise their name. The same person can be logged many times.',
                es: 'N.º de empleado si tiene, si no su nombre. La misma persona puede registrarse muchas veces.' },
        cols: [
          { k: 'who', t: 'text', l: { en: 'Employee # or Name', es: 'N.º de empleado o nombre' }, req: true },
          { k: 'weightLb', t: 'number', l: { en: 'Weight (lbs)', es: 'Peso (lbs)' }, min: 0, step: 0.01, req: true, dp: 2 }
        ],
        totalCol: 'weightLb' },
      // Flower sifted back out of the leaf, weighed on its own — nobody's,
      // so it's not in the by-person log, but it is bucked flower.
      { k: 'recovered', t: 'lineitems', entry: true,
        l: { en: 'Recovered from Leaf', es: 'Recuperado de la hoja' },
        hint: { en: 'Bucked flower sifted back out of the leaf, each time it’s weighed. It counts in the bucked flower total.',
                es: 'Flor desvarada que se saca de la hoja al colarla, cada vez que se pesa. Cuenta en el total de flor desvarada.' },
        cols: [
          { k: 'weightLb', t: 'number', l: { en: 'Weight (lbs)', es: 'Peso (lbs)' }, min: 0, step: 0.01, req: true, dp: 2 }
        ],
        totalCol: 'weightLb' },
      { k: 'buckedFlowerLb', t: 'calc',
        calc: (v) => buckedLb(v),
        l: { en: 'Total Bucked Flower (lbs)', es: 'Flor desvarada total (lbs)' },
        hint: { en: 'By person plus recovered from leaf.', es: 'Por persona más lo recuperado de la hoja.' } },
      { k: 'buckerCount', t: 'calc', dp: 0,
        calc: (v) => new Set((v.bucked || []).map((r) => String(r.who || '').trim().toLowerCase()).filter(Boolean)).size,
        l: { en: 'People on this Batch', es: 'Personas en este lote' } },
      // Bucked flower normally goes straight to trimming on the on-stem tag.
      // Only a lot that will sit as bucked flower (waiting on an order, like
      // the Gelato) gets a package of its own in Metrc — `metrcTags` below.
      { k: 'holdBucked', t: 'check',
        l: { en: 'Holding as bucked flower — needs its own Metrc tag', es: 'Se guarda como flor desvarada — necesita su propia etiqueta Metrc' },
        hint: { en: 'Only when this lot will sit as bucked flower instead of going to trim. The Metrc Queue then asks for the new bucked-flower tag.',
                es: 'Solo cuando este lote se quedará como flor desvarada en vez de ir a corte. La Cola de Metrc pedirá la nueva etiqueta de flor desvarada.' } },

      { k: 'trim', t: 'lineitems', entry: true,
        l: { en: 'Trim', es: 'Recorte (trim)' },
        hint: { en: 'Each bag of trim as it’s weighed.', es: 'Cada bolsa de recorte al pesarla.' },
        cols: [
          { k: 'weightLb', t: 'number', l: { en: 'Weight (lbs)', es: 'Peso (lbs)' }, min: 0, step: 0.01, req: true, dp: 2 }
        ],
        totalCol: 'weightLb' },
      { k: 'trimLb', t: 'calc',
        calc: (v) => (v.trim || []).reduce((a, r) => a + num(r.weightLb), 0),
        l: { en: 'Total Trim (lbs)', es: 'Recorte total (lbs)' } },

      // Close-out: stems, mold and floor waste — weigh two and Calculate
      // fills in the third — then the summary, then Submit. Stems are a
      // running log too (several bins or bags), totalled into stemLb.
      // Pages saved when stems were one number come back with that number
      // as their first row (`legacyTotal`).
      { k: 'stems', t: 'lineitems', entry: true, req: true, legacyTotal: 'stemLb',
        l: { en: 'Stems', es: 'Palo' },
        hint: { en: 'Each bin or bag of stems as it’s weighed. Add as many as you need, then submit.',
                es: 'Cada bote o bolsa de palo al pesarla. Agregue los que necesite y luego envíe.' },
        cols: [
          { k: 'weightLb', t: 'number', l: { en: 'Weight (lbs)', es: 'Peso (lbs)' }, min: 0, step: 0.01, req: true, dp: 2 }
        ],
        totalCol: 'weightLb' },
      { k: 'stemLb', t: 'calc',
        calc: (v) => (v.stems || []).reduce((a, r) => a + num(r.weightLb), 0),
        l: { en: 'Total Stems (lbs)', es: 'Palo total (lbs)' } },
      { k: 'moldLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Mold (lbs)', es: 'Moho (lbs)' } },
      { k: 'floorWasteLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Floor Waste (lbs)', es: 'Desperdicio del piso (lbs)' } },
      { k: 'closeOutFill', t: 'fill', keys: ['stems', 'moldLb', 'floorWasteLb'],
        // The missing one is what's left of the boxes taken once everything
        // else coming out is counted, so the loss comes to zero. Worked out
        // for the stems log, it's added as one row.
        fill: (v, key) => num(v.startingDryLb) - sum(v, BUCK_OUTPUTS.filter((k) => k !== (key === 'stems' ? 'stemLb' : key))),
        l: { en: 'Calculate', es: 'Calcular' },
        hint: { en: 'Weighed two of Stems, Mold and Floor Waste? Calculate fills in the third: Total Boxes Taken minus everything else that came out.',
                es: '¿Pesó dos de Palo, Moho y Desperdicio del piso? Calcular llena el tercero: total de cajas menos todo lo demás que salió.' } },
      { k: 'totalOutputLb', t: 'calc', calc: (v) => sum(v, BUCK_OUTPUTS),
        l: { en: 'Total Out — Bucked + Trim + Stems + Mold + Floor Waste (lbs)', es: 'Total — desvarado + recorte + palo + moho + desperdicio (lbs)' } },
      { k: 'lossLb', t: 'calc', calc: (v) => (num(v.startingDryLb) > 0 ? num(v.startingDryLb) - sum(v, BUCK_OUTPUTS) : null),
        l: { en: 'Loss (lbs)', es: 'Pérdida (lbs)' },
        hint: { en: 'Boxes taken minus the total. A negative number means more came out than was logged going in.',
                es: 'Cajas menos el total. Un número negativo indica que salió más de lo registrado al entrar.' } },
      { k: 'lossPct', t: 'calc', fmt: 'pct',
        calc: (v) => pct(num(v.startingDryLb) - sum(v, BUCK_OUTPUTS), v.startingDryLb),
        l: { en: 'Loss %', es: '% de pérdida' },
        flag: (x) => x < 0 || x > 0.05 },
      { k: 'buckYieldPct', t: 'calc', fmt: 'pct', calc: (v) => pct(v.buckedFlowerLb, v.startingDryLb),
        l: { en: 'Bucked Flower Yield %', es: '% de rendimiento de flor desvarada' } },
      F.notes(), F.photo()
    ],
    // A held lot's bucked-flower package (Holding as bucked flower, above),
    // made in Metrc and entered from the Metrc Queue. `when`: the tag is
    // only asked for on those lots. Hand Trim finds the lot by either tag.
    metrcTags: [
      { k: 'newBuckedUid', from: 'buckedFlowerLb', when: (v) => v.holdBucked === true || v.holdBucked === 'true',
        l: { en: 'Bucked Flower', es: 'Flor desvarada' } }
    ],
    // bigLeafLb, wasteLb and the A+/A/B trim fields aren't on the form any
    // more, but the paper-form records imported before (data/operations/
    // buck.json) have them, so they stay in the flow and those records still
    // balance.
    flow: { lossKind: 'conserving',
            input: { field: 'startingDryLb', category: 'dry_whole_plant' },
            outputs: [
              { field: 'buckedFlowerLb', category: 'bucked_flower' },
              { field: 'trimLb', category: 'trim' },
              { field: 'stemLb', category: 'stems' },
              { field: 'moldLb', category: 'waste' },
              { field: 'floorWasteLb', category: 'waste' },
              { field: 'bigLeafLb', category: 'big_leaf' },
              { field: 'wasteLb', category: 'waste' },
              { field: 'aPlusTrimLb', category: 'trim_a_plus' },
              { field: 'aTrimLb', category: 'trim_a' },
              { field: 'bTrimLb', category: 'trim_b' }
            ] }
  },

  // ── PROCESSING: MACHINE TRIM ──────────────────────────────────────────────
  {
    key: 'machine_trim',
    dept: { en: 'Processing', es: 'Procesamiento' },
    title: { en: 'Machine Trim', es: 'Corte a máquina' },
    desc: { en: 'Run bucked flower through the Mobius and sorters; split A-buds from smalls.',
            es: 'Pase la flor desvarada por la Mobius y clasificadoras; separe buds A de smalls.' },
    color: 'red',
    headline: 'flowerALb',
    fields: [
      F.date(),
      F.sourceUid({ en: 'Bucked Flower UID', es: 'UID de flor desvarada' }),
      { k: 'strain', t: 'select', ref: 'strains', allowOther: true, prefill: 'lookup',
        l: { en: 'Strain', es: 'Variedad (cepa)' } },
      { k: 'machine', t: 'select', ref: 'trimMachines', allowOther: true, req: true,
        l: { en: 'Machine / Line', es: 'Máquina / línea' } },
      { k: 'trimStyle', t: 'select', req: true,
        l: { en: 'Trim Style', es: 'Estilo de corte' },
        opts: [
          { v: 'machine_only', l: { en: 'Machine trim only', es: 'Solo corte a máquina' } },
          { v: 'machine_hand', l: { en: 'Machine + hand finish', es: 'Máquina + acabado a mano' } }
        ] },
      { k: 'inputBuckedLb', t: 'number', req: true, min: 0, step: 0.01, prefill: 'lookup',
        l: { en: 'Input Bucked Weight (lbs)', es: 'Peso desvarado de entrada (lbs)' } },
      { k: 'flowerALb', t: 'number', req: true, min: 0, step: 0.01,
        l: { en: 'Flower — A-Buds (lbs)', es: 'Flor — Buds A (lbs)' } },
      { k: 'smallsBLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Smalls — B-Buds (lbs)', es: 'Smalls — Buds B (lbs)' } },
      { k: 'machineShakeLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Machine Shake (lbs)', es: 'Shake de máquina (lbs)' } },
      { k: 'sugarTrimLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Sugar Trim (lbs)', es: 'Hoja azucarada (lbs)' } },
      F.waste(),
      ...totalsBlock('inputBuckedLb', ['flowerALb', 'smallsBLb', 'machineShakeLb', 'sugarTrimLb', 'wasteLb']),
      { k: 'aBudPct', t: 'calc', fmt: 'pct', calc: (v) => pct(v.flowerALb, v.inputBuckedLb),
        l: { en: 'A-Bud Yield %', es: '% de rendimiento Bud A' } },
      { k: 'runHours', t: 'number', min: 0, step: 0.25,
        l: { en: 'Machine Run Hours', es: 'Horas de máquina' } },
      { k: 'lbPerHour', t: 'calc', calc: (v) => (num(v.runHours) > 0 ? num(v.inputBuckedLb) / num(v.runHours) : null),
        l: { en: 'Throughput (lbs/hr)', es: 'Rendimiento (lbs/h)' } },
      F.teamLead(), F.crewSize(), F.crew(), F.notes(), F.photo()
    ],
    flow: { lossKind: 'conserving',
            input: { field: 'inputBuckedLb', category: 'bucked_flower' },
            outputs: [
              { field: 'flowerALb', category: 'flower_a' },
              { field: 'smallsBLb', category: 'smalls_b' },
              { field: 'machineShakeLb', category: 'shake' },
              { field: 'sugarTrimLb', category: 'sugar_trim' },
              { field: 'wasteLb', category: 'waste' }
            ] }
  },

  // ── PROCESSING: HAND TRIM / HAND TOUCH (WORK ORDER) ───────────────────────
  {
    key: 'hand_trim',
    dept: { en: 'Processing', es: 'Procesamiento' },
    title: { en: 'Hand Trim / Hand Touch', es: 'Corte a mano / retoque' },
    desc: { en: 'The trimming work order — weigh each trimmer’s finished flower and total the run.',
            es: 'La orden de trabajo de corte — pese la flor terminada de cada persona y sume la corrida.' },
    color: 'purple',
    headline: 'finishedFlowerLb',
    // One page per lot, built like Bucking: every open page (anyone's) is in
    // the switcher at the top, several lots run at once, and a page stays
    // open across days until it's submitted.
    sharedDay: true,
    canDelete: true,
    // A Queue tab next to the form: the trimming queue (set on the Work
    // Orders page), with the strain, UID and bucked weight.
    queueTab: true,
    links: [{ href: '/work_orders.html?tab=trim', l: { en: 'Work Orders →', es: 'Órdenes de trabajo →' } }],
    // A lot is often trimmed over several days: a tab per day under the lot
    // tabs; the weighing log shows the picked day and stamps new bags with it.
    dayTabs: { lines: 'weights', fromGrams: true },
    // The table under the form: pounds of finished flower per person, per
    // lot, for one day (each bag carries the day it was weighed).
    dailySummary: { lines: 'weights', empCol: 'employeeNo', valueCol: 'grams', dateCol: 'day', unit: 'lb', fromGrams: true,
                    title: { en: 'Daily Summary — Pounds by Person', es: 'Resumen del día — libras por persona' },
                    hint: { en: 'Finished flower weighed that day on every hand trim page, in pounds. Open pages included.',
                            es: 'Flor terminada pesada ese día en todas las hojas de corte a mano, en libras. Incluye hojas abiertas.' } },
    fields: [
      F.date(),
      F.project(),
      // Picked from every lot that's been bucked (`picker`: buckedLots in
      // ops_common.js, "Strain || abbreviation || last 4"). "Other" is for
      // bucked flower from somewhere else: a popup asks for the strain and
      // the package UID.
      { k: 'sourceUid', t: 'uid', req: true, prefill: 'lookup', picker: { list: 'bucked', otherPopup: true },
        l: { en: 'Lot Number', es: 'Número de lote' },
        pickedLabel: { en: 'Package UID', es: 'UID del paquete' },
        hint: { en: 'Bucked flower lots. Picking one fills in the strain, customer ID and bucked weight. Brought-in bucked flower: pick Other.',
                es: 'Lotes de flor desvarada. Al elegir uno se llenan la variedad, el ID de cliente y el peso desvarado. Flor desvarada traída de fuera: elija Otro.' } },
      { k: 'strain', t: 'select', ref: 'strains', allowOther: true, req: true, prefill: 'lookup',
        l: { en: 'Strain', es: 'Variedad (cepa)' } },
      { k: 'strainGrade', t: 'select',
        l: { en: 'Strain Grade', es: 'Grado de la variedad' },
        opts: [
          { v: 'A', l: { en: 'A', es: 'A' } },
          { v: 'B', l: { en: 'B', es: 'B' } },
          { v: 'whole_plant', l: { en: 'Whole Plant', es: 'Planta entera' } },
          { v: 'mixed', l: { en: 'Mixed', es: 'Mixto' } }
        ] },
      { k: 'cid', t: 'select', ref: 'customers', allowOther: true, prefill: 'lookup',
        l: { en: 'Customer ID (CID)', es: 'ID de cliente (CID)' } },
      { k: 'startingBuckedLb', t: 'number', req: true, min: 0, step: 0.01, prefill: 'lookup',
        l: { en: 'Total Starting Bucked Weight (lbs)', es: 'Peso desvarado inicial total (lbs)' } },
      // Machine (went through the machine trimmer first) or Hand only — a
      // pick-one `group`, side by side.
      { k: 'machineTrimmed', t: 'check', group: 'trimType',
        l: { en: 'Machine', es: 'Máquina' } },
      { k: 'handTrimmed', t: 'check', group: 'trimType',
        l: { en: 'Hand', es: 'Mano' } },
      // What the trimmers are paid on this lot, per finished pound.
      // Required: the trimmers' pay is pounds × this (a lot can't be
      // submitted without it).
      { k: 'trimRatePerLb', t: 'number', req: true, min: 0, step: 0.01,
        l: { en: 'Trimmer Rate ($ per lb)', es: 'Tarifa de corte ($ por lb)' },
        hint: { en: 'What we pay the trimmers per pound on this lot. Needed to submit.',
                es: 'Lo que se paga a las personas de corte por libra en este lote. Necesaria para enviar.' } },

      // The weighing worksheet from the paper form, as a running log (like
      // Bucking's) so two tablets on one lot merge their bags.
      { k: 'weights', t: 'lineitems', entry: true, req: true,
        l: { en: 'Finished Flower — Weighing Worksheet', es: 'Flor terminada — hoja de pesaje' },
        hint: { en: 'Employee #, how many full bags and their grams each (454 = 1 lb), plus any partial bag — Add logs a line for each bag.',
                es: 'N.º de empleado, cuántas bolsas llenas y sus gramos c/u (454 = 1 lb), más una bolsa parcial — Agregar registra una línea por bolsa.' },
        cols: [
          { k: 'employeeNo', t: 'text', l: { en: 'Employee #', es: 'N.º de empleado' }, inputmode: 'numeric', req: true },
          { k: 'grams', t: 'number', l: { en: 'Weight (gm)', es: 'Peso (gm)' }, min: 0, step: 1, req: true, dp: 0 }
        ],
        // The entry bar takes several full bags at once: Bags × Grams each
        // (454 — a pound — stays filled in) plus one Partial, and Add logs a
        // row per bag, all under the one employee #.
        multi: { col: 'grams', def: 454,
                 qty: { en: 'Bags', es: 'Bolsas' },
                 each: { en: 'Grams each', es: 'Gramos c/u' },
                 partial: { en: 'Partial (gm)', es: 'Parcial (gm)' } },
        totalCol: 'grams' },

      { k: 'totalGrams', t: 'calc', dp: 0,
        calc: (v) => (v.weights || []).reduce((a, r) => a + num(r.grams), 0),
        l: { en: 'Total Finished Flower (grams)', es: 'Flor terminada total (gramos)' } },
      { k: 'finishedFlowerLb', t: 'calc',
        calc: (v) => (v.weights || []).reduce((a, r) => a + num(r.grams), 0) / G_PER_LB,
        l: { en: 'Total Finished Flower (lbs)', es: 'Flor terminada total (lbs)' },
        hint: { en: 'grams ÷ 454.', es: 'gramos ÷ 454.' } },
      { k: 'trimmerCount', t: 'calc', dp: 0,
        calc: (v) => new Set((v.weights || []).map((r) => String(r.employeeNo || '').trim()).filter(Boolean)).size,
        l: { en: 'Trimmers on this Order', es: 'Personas en esta orden' } },
      { k: 'gramsPerTrimmer', t: 'calc', dp: 0,
        calc: (v) => {
          const rows = v.weights || [];
          const people = new Set(rows.map((r) => String(r.employeeNo || '').trim()).filter(Boolean)).size;
          return people > 0 ? rows.reduce((a, r) => a + num(r.grams), 0) / people : null;
        },
        l: { en: 'Avg Grams / Trimmer', es: 'Gramos promedio por persona' } },

      // Weighed once, when the whole run is done.
      { k: 'endOfRun', t: 'heading',
        l: { en: 'End of Run', es: 'Fin de la corrida' },
        hint: { en: 'Fill these in on the last day of the run, then submit.',
                es: 'Llene esto el último día de la corrida y luego envíe.' } },
      { k: 'smallsLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Smalls Pulled (lbs)', es: 'Smalls separados (lbs)' } },
      { k: 'normTrimLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Normal Trim (lbs)', es: 'Recorte normal (lbs)' } },
      { k: 'aPlusTrimLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'A+ Trim (lbs)', es: 'Recorte A+ (lbs)' } },
      F.waste(),
      { k: 'bagCount', t: 'number', min: 0, step: 1, dp: 0,
        l: { en: 'Finished Bag Count', es: 'Conteo de bolsas terminadas' } },
      ...totalsBlock('startingBuckedLb', ['finishedFlowerLb', 'smallsLb', 'normTrimLb', 'aPlusTrimLb', 'sugarTrimLb', 'wasteLb']),
      F.teamLead(), F.laborHours(), F.notes(), F.photo()
    ],
    // A manager signs off the output weights before anything is done in
    // Metrc (weightCheckState below; the Metrc Queue's Confirm weights).
    weightCheck: ['finishedFlowerLb', 'smallsLb', 'normTrimLb', 'aPlusTrimLb', 'sugarTrimLb', 'wasteLb'],
    // The new Metrc package tag on each output. They don't exist until the
    // packages are made in Metrc, so they aren't on the floor form: the Metrc
    // Queue (metrc.html) fills them in on the submitted record, through
    // netlify/functions/metrc-queue.js. Waste stays on the source tag and is
    // wasted out, so it has none. Each traces back to the lot
    // (buildAliasMap in ops_analytics.js), and Raw Inventory lists the output
    // under it.
    // Trim isn't tagged per strain any more (October 2026): every few days
    // the trim on hand is packaged together on a Mixed Trim Package form,
    // which gets the one new tag. `when` false: the trim lines only show on
    // records that already have a tag, from before.
    metrcTags: [
      { k: 'newFinishedUid', from: 'finishedFlowerLb', l: { en: 'Finished Flower', es: 'Flor terminada' } },
      { k: 'newSmallsUid', from: 'smallsLb', l: { en: 'Smalls', es: 'Smalls' } },
      { k: 'newTrimUid', from: 'normTrimLb', when: () => false, l: { en: 'Normal Trim', es: 'Recorte normal' } },
      { k: 'newAPlusTrimUid', from: 'aPlusTrimLb', when: () => false, l: { en: 'A+ Trim', es: 'Recorte A+' } },
      { k: 'newSugarTrimUid', from: 'sugarTrimLb', when: () => false, l: { en: 'Sugar Trim', es: 'Recorte azucarado' } }
    ],
    // sugarTrimLb isn't on the form any more (Normal / A+ Trim replaced it),
    // but older records have it, so it stays in the totals and the flow.
    flow: { lossKind: 'conserving',
            input: { field: 'startingBuckedLb', category: 'bucked_flower' },
            outputs: [
              { field: 'finishedFlowerLb', category: 'flower_a' },
              { field: 'smallsLb', category: 'smalls_b' },
              { field: 'normTrimLb', category: 'trim' },
              { field: 'aPlusTrimLb', category: 'trim_a_plus' },
              { field: 'sugarTrimLb', category: 'sugar_trim' },
              { field: 'wasteLb', category: 'waste' }
            ] }
  },

  // ── PROCESSING: SMALLS HAND TRIM (BY THE HOURLY) ──────────────────────────
  // The paper "Work Order Form (Smalls | By the Hourly)": one page per flavor
  // per day. Several flavors run at once, so `sharedDay` puts every open
  // smalls page in the switcher at the top (anyone's, not just yours) to jump
  // between flavors, and `dailySummary` draws the notebook tally under the
  // form — employee # × flavor, grams, for the day.
  {
    key: 'smalls_trim',
    dept: { en: 'Processing', es: 'Procesamiento' },
    title: { en: 'Smalls Hand Trim', es: 'Corte a mano — smalls' },
    desc: { en: 'Smalls work order, by the hourly — one page per flavor per day. Weigh each trimmer’s finished smalls.',
            es: 'Orden de trabajo de smalls, por hora — una hoja por sabor por día. Pese los smalls terminados de cada persona.' },
    color: 'blue',
    headline: 'finishedSmallsLb',
    sharedDay: true,
    dailySummary: { lines: 'weights', empCol: 'employeeNo', valueCol: 'grams' },
    fields: [
      F.date(),
      { k: 'sourceUid', t: 'uid', req: true,
        l: { en: 'Package UID', es: 'UID del paquete' },
        hint: { en: 'Metrc tag on the smalls package — the last 4 is enough.',
                es: 'Etiqueta Metrc del paquete de smalls — basta con los últimos 4.' } },
      { k: 'strain', t: 'select', ref: 'strains', allowOther: true, req: true,
        l: { en: 'Strain (flavor)', es: 'Variedad (sabor)' } },
      { k: 'startingLb', t: 'number', req: true, min: 0, step: 0.01,
        l: { en: 'Total Starting Weight (lbs)', es: 'Peso inicial total (lbs)' } },

      // Finished Smalls — Weighing Worksheet: one row per bag weighed out.
      { k: 'weights', t: 'lineitems', req: true,
        l: { en: 'Finished Smalls — Weighing Worksheet', es: 'Smalls terminados — hoja de pesaje' },
        hint: { en: 'One row per bag weighed out. The same employee # can appear on several rows.',
                es: 'Una fila por bolsa pesada. El mismo n.º de empleado puede aparecer en varias filas.' },
        cols: [
          { k: 'employeeNo', t: 'text', l: { en: 'Employee #', es: 'N.º de empleado' }, inputmode: 'numeric', req: true },
          { k: 'grams', t: 'number', l: { en: 'Weight (gm)', es: 'Peso (gm)' }, min: 0, step: 1, req: true }
        ],
        totalCol: 'grams' },

      { k: 'totalGrams', t: 'calc', dp: 0,
        calc: (v) => (v.weights || []).reduce((a, r) => a + num(r.grams), 0),
        l: { en: 'Total Finished Smalls (grams)', es: 'Smalls terminados total (gramos)' } },
      { k: 'finishedSmallsLb', t: 'calc',
        calc: (v) => (v.weights || []).reduce((a, r) => a + num(r.grams), 0) / G_PER_LB,
        l: { en: 'Total Finished Smalls (lbs)', es: 'Smalls terminados total (lbs)' },
        hint: { en: 'grams ÷ 454.', es: 'gramos ÷ 454.' } },
      { k: 'trimmerCount', t: 'calc', dp: 0,
        calc: (v) => new Set((v.weights || []).map((r) => String(r.employeeNo || '').trim()).filter(Boolean)).size,
        l: { en: 'Trimmers on this Page', es: 'Personas en esta hoja' } },

      { k: 'shakeLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Shake (lbs)', es: 'Shake (lbs)' } },
      F.waste(),
      ...totalsBlock('startingLb', ['finishedSmallsLb', 'shakeLb', 'wasteLb']),
      { k: 'newFinishedUid', t: 'uid', l: { en: 'New UID — Finished Smalls', es: 'UID nuevo — smalls terminados' },
        hint: { en: 'The new Metrc tag on the finished smalls, once it has one.',
                es: 'La nueva etiqueta Metrc de los smalls terminados, cuando la tenga.' } },

      // Back of the paper form: who did the follow-up paperwork.
      { k: 'wasteAdjustedBy', t: 'text', l: { en: 'Waste Adjusted (starting package UID) — initials', es: 'Desecho ajustado (UID inicial) — iniciales' } },
      { k: 'inventoryUpdatedBy', t: 'text', l: { en: '2CW Processor Inventory Updated — initials', es: 'Inventario del procesador 2CW actualizado — iniciales' } },
      { k: 'notes', t: 'textarea', l: { en: 'Smalls Manager Notes', es: 'Notas del encargado de smalls' } },
      F.photo()
    ],
    flow: { lossKind: 'conserving',
            input: { field: 'startingLb', category: 'smalls_b' },
            outputs: [
              { field: 'finishedSmallsLb', category: 'smalls_b' },
              { field: 'shakeLb', category: 'shake' },
              { field: 'wasteLb', category: 'waste' }
            ] }
  },

  // ── PROCESSING: MIXED TRIM PACKAGE ────────────────────────────────────────
  // Trim isn't packaged per strain: every couple of days the trim on hand
  // (Hand Trim's Normal / A+, Bucking's trim, …) goes into one "mixed"
  // package. A row per source package going in; the new package's tag is
  // made in Metrc and entered from the Metrc Queue (`metrcTags`). Raw
  // Inventory takes each row off its source and lists the mixed package
  // under the new tag.
  {
    key: 'trim_package',
    dept: { en: 'Processing', es: 'Procesamiento' },
    title: { en: 'Mixed Trim Package', es: 'Paquete de recorte mixto' },
    desc: { en: 'The list of trim to package together as one mixed package — each source package and its pounds.',
            es: 'La lista de recorte para empacar junto en un paquete mixto — cada paquete de origen y sus libras.' },
    color: 'gold',
    headline: 'totalLb',
    fields: [
      F.date(),
      { k: 'requestedBy', t: 'text', req: true,
        l: { en: 'List From', es: 'Lista de' },
        hint: { en: 'Who put the list together.', es: 'Quién hizo la lista.' } },
      { k: 'packageType', t: 'select', req: true, def: 'trim',
        l: { en: 'New Package Is', es: 'El paquete nuevo es' },
        opts: [
          { v: 'trim', l: { en: 'Trim (mixed)', es: 'Recorte (mixto)' } },
          { v: 'trim_a_plus', l: { en: 'A+ Trim (mixed)', es: 'Recorte A+ (mixto)' } },
          { v: 'sugar_trim', l: { en: 'Sugar Trim (mixed)', es: 'Recorte azucarado (mixto)' } },
          { v: 'shake', l: { en: 'Shake (mixed)', es: 'Shake (mixto)' } }
        ] },
      { k: 'lines', t: 'lineitems', req: true,
        l: { en: 'Trim Going In', es: 'Recorte que entra' },
        hint: { en: 'One row per source package: scan or type its UID (the strain fills in from Canix), the kind of trim and the pounds going in.',
                es: 'Una fila por paquete de origen: escanee o escriba su UID (la variedad se llena desde Canix), el tipo de recorte y las libras que entran.' },
        cols: [
          { k: 'sourceUid', t: 'uid', req: true, canixStrain: 'strain', l: { en: 'Source UID', es: 'UID de origen' } },
          { k: 'strain', t: 'select', ref: 'strains', allowOther: true, l: { en: 'Strain', es: 'Variedad' } },
          { k: 'trimType', t: 'select', carry: true,
            l: { en: 'Trim', es: 'Recorte' },
            opts: [
              { v: 'trim', l: { en: 'Normal', es: 'Normal' } },
              { v: 'trim_a_plus', l: { en: 'A+', es: 'A+' } },
              { v: 'sugar_trim', l: { en: 'Sugar', es: 'Azucarado' } },
              { v: 'shake', l: { en: 'Shake', es: 'Shake' } }
            ] },
          { k: 'weightLb', t: 'number', req: true, min: 0, step: 0.01, l: { en: 'Weight (lbs)', es: 'Peso (lbs)' } }
        ],
        totalCol: 'weightLb' },
      { k: 'totalLb', t: 'calc', calc: (v) => (v.lines || []).reduce((a, r) => a + num(r.weightLb), 0),
        l: { en: 'Total Mixed Trim (lbs)', es: 'Recorte mixto total (lbs)' } },
      { k: 'packageCount', t: 'calc', dp: 0, calc: (v) => new Set((v.lines || []).map((r) => r.sourceUid).filter(Boolean)).size,
        l: { en: 'Source Packages', es: 'Paquetes de origen' } },
      F.notes(), F.photo()
    ],
    metrcTags: [
      { k: 'newMixedTrimUid', from: 'totalLb', l: { en: 'Mixed Trim', es: 'Recorte mixto' } }
    ]
  },

  // ── CULTIVATION: FRESH FROZEN ────────────────────────────────────────────
  {
    key: 'fresh_frozen',
    dept: { en: 'Cultivation', es: 'Cultivo' },
    title: { en: 'Fresh Frozen', es: 'Fresco congelado' },
    desc: { en: 'Bucked-and-bagged material going straight into totes and the freezer for extraction.',
            es: 'Material desvarado y embolsado que va directo a totes y al congelador para extracción.' },
    color: 'blue',
    headline: 'totalLb',
    fields: [
      F.date(), F.site(), F.strain(),
      { k: 'sourceUid', t: 'uid', l: { en: 'Harvest UID Tag', es: 'Etiqueta UID de cosecha' } },
      { k: 'harvestBatchName', t: 'text', l: { en: 'Harvest / Batch Name', es: 'Nombre de cosecha / lote' } },
      { k: 'bagCount', t: 'number', req: true, min: 0, step: 1, dp: 0,
        l: { en: 'Bag Count', es: 'Conteo de bolsas' } },
      { k: 'totalLb', t: 'number', req: true, min: 0, step: 0.01,
        l: { en: 'Total Weight (lbs)', es: 'Peso total (lbs)' } },
      { k: 'lbPerBag', t: 'calc', calc: (v) => (num(v.bagCount) > 0 ? num(v.totalLb) / num(v.bagCount) : null),
        l: { en: 'Avg lbs / Bag', es: 'Lbs promedio por bolsa' } },
      { k: 'toteCount', t: 'number', min: 0, step: 1, dp: 0,
        l: { en: 'Tote Count', es: 'Conteo de totes' } },
      { k: 'toteIds', t: 'text', l: { en: 'Tote IDs', es: 'ID de totes' } },
      { k: 'freezer', t: 'select', ref: 'freezers', allowOther: true, req: true,
        l: { en: 'Freezer', es: 'Congelador' } },
      { k: 'freezerTempF', t: 'number', step: 1, dp: 0,
        l: { en: 'Freezer Temp (°F)', es: 'Temp. del congelador (°F)' } },
      { k: 'intendedUse', t: 'select',
        l: { en: 'Intended Use', es: 'Uso previsto' },
        opts: [
          { v: 'live_rosin', l: { en: 'Live Rosin', es: 'Live Rosin' } },
          { v: 'live_resin', l: { en: 'Live Resin', es: 'Live Resin' } },
          { v: 'bulk_sale', l: { en: 'Bulk sale', es: 'Venta a granel' } }
        ] },
      F.teamLead(), F.crewSize(), F.crew(), F.notes(), F.photo()
    ],
    flow: { lossKind: 'origin', outputs: [{ field: 'totalLb', category: 'fresh_frozen' }] }
  },

  // ── BIOMASS REQUEST (PROCESSING → MANUFACTURING) ──────────────────────────
  {
    key: 'biomass_request',
    dept: { en: 'Manufacturing', es: 'Manufactura' },
    title: { en: 'Biomass Request', es: 'Solicitud de biomasa' },
    desc: { en: 'Request biomass from the processing facility for a manufacturing run.',
            es: 'Solicite biomasa de la planta de procesamiento para una corrida de manufactura.' },
    color: 'purple',
    headline: 'requestedLb',
    fields: [
      F.date(),
      { k: 'requestedBy', t: 'text', req: true, l: { en: 'Requested By', es: 'Solicitado por' } },
      { k: 'destinationDept', t: 'select', req: true,
        l: { en: 'For Which Line?', es: '¿Para qué línea?' },
        opts: [
          { v: 'prerolls', l: { en: 'Manufacturing — Prerolls', es: 'Manufactura — Prerolls' } },
          { v: 'pouches', l: { en: 'Manufacturing — Ground Flower Pouches', es: 'Manufactura — Bolsas de flor molida' } },
          { v: 'flower', l: { en: 'Manufacturing — Flower', es: 'Manufactura — Flor' } },
          { v: 'concentrates', l: { en: 'Manufacturing — Concentrates', es: 'Manufactura — Concentrados' } },
          { v: 'bulk_sale', l: { en: 'Bulk sale / transfer out', es: 'Venta a granel / transferencia' } }
        ] },
      { k: 'brand', t: 'select', ref: 'brands', allowOther: true,
        l: { en: 'Brand', es: 'Marca' } },
      { k: 'category', t: 'select', req: true, refConst: 'BIOMASS',
        l: { en: 'Biomass Category', es: 'Categoría de biomasa' } },
      { k: 'strain', t: 'select', ref: 'strains', allowOther: true,
        l: { en: 'Strain', es: 'Variedad (cepa)' },
        hint: { en: 'Leave blank if any strain will do.', es: 'Deje en blanco si cualquier variedad sirve.' } },
      { k: 'requestedLb', t: 'number', req: true, min: 0, step: 0.01,
        l: { en: 'Requested Weight (lbs)', es: 'Peso solicitado (lbs)' } },
      { k: 'neededBy', t: 'date', l: { en: 'Needed By', es: 'Necesario para' } },
      { k: 'purpose', t: 'text', l: { en: 'Purpose / SKU', es: 'Propósito / SKU' } },
      { k: 'status', t: 'select', req: true, today: false,
        l: { en: 'Status', es: 'Estado' },
        opts: [
          { v: 'requested', l: { en: 'Requested', es: 'Solicitado' } },
          { v: 'approved', l: { en: 'Approved', es: 'Aprobado' } },
          { v: 'transferred', l: { en: 'Transferred', es: 'Transferido' } },
          { v: 'denied', l: { en: 'Denied', es: 'Denegado' } }
        ], def: 'requested' },
      { k: 'sourceUid', t: 'uid', showIf: (v) => v.status === 'approved' || v.status === 'transferred',
        l: { en: 'Source Package UID', es: 'UID del paquete de origen' } },
      { k: 'transferredLb', t: 'number', min: 0, step: 0.01, showIf: (v) => v.status === 'transferred',
        l: { en: 'Actually Transferred (lbs)', es: 'Transferido realmente (lbs)' } },
      { k: 'transferDate', t: 'date', showIf: (v) => v.status === 'transferred',
        l: { en: 'Transfer Date', es: 'Fecha de transferencia' } },
      { k: 'approvedBy', t: 'text', showIf: (v) => v.status !== 'requested',
        l: { en: 'Approved By', es: 'Aprobado por' } },
      F.notes()
    ],
    flow: { transfer: { field: 'transferredLb', categoryField: 'category', whenStatus: 'transferred' } }
  },

  // ── MANUFACTURING: PRE-ROLL PRODUCTION ────────────────────────────────────
  // Matches the paper pre-roll production sheet. Built like Hand Trim: one
  // page per run, every open run (anyone's) in the switcher at the top with
  // "+ New run", so several runs can be open at once, and a run stays open
  // across days until QC signs it off and someone submits it. Who worked
  // each day is confirmed against the Master Schedule (`attendance`); the
  // hours come from the Labor Log, through the run's Project. Runs from
  // before October 2026 have a Workforce Log of hours (`crew`) instead —
  // still read by preroll-costs.js and crewLaborLog.
  {
    key: 'preroll_production',
    dept: { en: 'Manufacturing', es: 'Manufactura' },
    title: { en: 'Pre-Roll Production', es: 'Producción de prerolls' },
    desc: { en: 'One run of pre-rolls from start to finish — output, waste, and who’s working on it, a tab per day. Stays open across days until submitted.',
            es: 'Una corrida de prerolls de principio a fin — producción, desecho y quién trabajó, una pestaña por día. Queda abierta varios días hasta enviarla.' },
    color: 'purple',
    headline: 'totalPrerolls',
    sharedDay: true,
    switcher: { open: { en: 'Runs open', es: 'Corridas abiertas' }, add: { en: '+ New run', es: '+ Nueva corrida' },
                one: { en: 'run', es: 'corrida' }, many: { en: 'runs', es: 'corridas' },
                page: { en: 'pre-roll run', es: 'corrida de prerolls' } },
    canDelete: true,
    // A Queue tab next to the form: the pre-roll queue in the dashboard's
    // order, with Start (a new run for the request) or Open (its run).
    queueTab: true,
    links: [{ href: '/work_orders.html?tab=preroll', l: { en: 'Work Orders →', es: 'Órdenes de trabajo →' } }],
    // A tab per day under the run tabs: the output log and the crew show
    // the picked day and stamp new rows with it. `headline` labels the
    // Today board's total, which counts only the day looked at.
    dayTabs: { lines: ['output', 'attendance'],
               headline: { en: 'Pre-Rolls Made That Day', es: 'Prerolls hechos ese día' } },
    fields: [
      { ...F.date(), l: { en: 'Start Date', es: 'Fecha de inicio' } },
      F.project(),
      // Picked from the pre-roll queue, in the dashboard's order: fills in
      // what the request knows; the rest is typed as usual.
      { k: 'prNum', t: 'text', l: { en: 'Production Request', es: 'Solicitud de producción' },
        prPicker: { fills: { batchId: 'ref', brand: 'brand', packType: 'packType', strain: 'strain', sourceUid: 'sourceUid', unitSizeG: 'unitSizeG' } },
        hint: { en: 'Pick from the Pre-Roll Queue — it fills in what it can. Links this batch to the request on the Pre-Roll Dashboard.',
                es: 'Elija de la fila de prerolls — llena lo que pueda. Vincula este lote con la solicitud en el tablero de prerolls.' } },
      { k: 'batchId', t: 'text', req: true, l: { en: 'Batch ID', es: 'ID de lote' } },
      // Brand and pack come from the request's product (preroll_products);
      // both show in the Metrc Queue.
      { k: 'brand', t: 'select', ref: 'brands', allowOther: true,
        l: { en: 'Brand', es: 'Marca' } },
      { k: 'packType', t: 'select', allowOther: true,
        l: { en: 'Pack Type', es: 'Tipo de empaque' },
        opts: [
          { v: 'single', l: { en: 'Single', es: 'Individual' } },
          { v: '10pk', l: { en: '10-Pack', es: 'Paquete de 10' } },
          { v: '28pk', l: { en: '28-Pack', es: 'Paquete de 28' } }
        ] },
      F.strain(),
      { k: 'sourceUid', t: 'uid', req: true, l: { en: 'Source UID', es: 'UID de origen' },
        hint: { en: 'Metrc tag of the material going into the pre-rolls.',
                es: 'Etiqueta Metrc del material que entra en los prerolls.' } },
      { k: 'inputCategory', t: 'select', refConst: 'BIOMASS', req: true,
        l: { en: 'Input Material', es: 'Material de entrada' } },
      { k: 'startingWtG', t: 'number', req: true, min: 0, step: 0.1, dp: 1,
        l: { en: 'Starting Weight (grams)', es: 'Peso inicial (gramos)' } },
      { k: 'startingLb', t: 'calc', calc: (v) => (num(v.startingWtG) > 0 ? num(v.startingWtG) / G_PER_LB : null),
        l: { en: 'Starting Weight (lbs)', es: 'Peso inicial (lbs)' } },
      { k: 'humidityPct', t: 'number', min: 0, max: 100, step: 0.1, dp: 1,
        l: { en: 'Humidity %', es: '% de humedad' } },
      { k: 'unitSizeG', t: 'number', min: 0, step: 0.01,
        l: { en: 'Pre-Roll Size (grams each)', es: 'Tamaño del preroll (gramos c/u)' },
        hint: { en: 'e.g. 1 or 0.5 — used for the yield check below.', es: 'p. ej. 1 o 0.5 — se usa para el rendimiento abajo.' } },

      // Running logs (`entry: true`, like Hand Trim's bags): an entry bar and
      // Add, so two tablets on one run merge their rows. Each row carries the
      // day it was logged (the day tab picked).
      { k: 'output', t: 'lineitems', entry: true, req: true,
        l: { en: 'Pre-Roll Output', es: 'Producción de prerolls' },
        hint: { en: 'Add a row each time a count is taken — pre-rolls made and waste weighed out.',
                es: 'Agregue una fila cada vez que se cuente — prerolls hechos y desecho pesado.' },
        cols: [
          { k: 'count', t: 'number', l: { en: 'Pre-Rolls (each)', es: 'Prerolls (c/u)' }, min: 0, step: 1, dp: 0, inputmode: 'numeric' },
          { k: 'wasteG', t: 'number', l: { en: 'Waste (grams)', es: 'Desecho (gramos)' }, min: 0, step: 0.1, dp: 1 },
          { k: 'notes', t: 'text', l: { en: 'Notes', es: 'Notas' } }
        ],
        totalCol: 'count' },
      { k: 'totalPrerolls', t: 'calc', dp: 0, calc: (v) => (v.output || []).reduce((a, r) => a + num(r.count), 0),
        l: { en: 'Total Pre-Rolls (whole run)', es: 'Total de prerolls (toda la corrida)' } },
      { k: 'totalWasteG', t: 'calc', dp: 1, calc: (v) => (v.output || []).reduce((a, r) => a + num(r.wasteG), 0),
        l: { en: 'Total Waste (grams)', es: 'Desecho total (gramos)' } },
      { k: 'accountedPct', t: 'calc', fmt: 'pct',
        calc: (v) => {
          if (!(num(v.unitSizeG) > 0)) return null;
          const made = (v.output || []).reduce((a, r) => a + num(r.count), 0) * num(v.unitSizeG);
          const waste = (v.output || []).reduce((a, r) => a + num(r.wasteG), 0);
          return pct(made + waste, v.startingWtG);
        },
        l: { en: 'Starting Weight Accounted For', es: 'Peso inicial contabilizado' },
        hint: { en: '(pre-rolls × size + waste) ÷ starting weight. Should land near 100% by the end of the run.',
                es: '(prerolls × tamaño + desecho) ÷ peso inicial. Debe acercarse al 100% al final de la corrida.' },
        flag: (x) => x < 0.95 || x > 1.05 },

      // Who's working the run each day: the people Master Schedule has on
      // the run's project that day, each marked here or not, plus anyone
      // added at the station (buildCrewCheck in ops_form.html). A running
      // log like the two above — rows {key, userId, name, status: 'here' |
      // 'out' | 'added' | 'removed', day}, the latest per person per day
      // counting — so two tablets merge. Hours aren't kept here: they come
      // from the Labor Log, through the run's Project.
      { k: 'attendance', t: 'crewcheck', entry: true,
        l: { en: 'Crew', es: 'Personal' },
        hint: { en: 'Who is working in the pre-roll room today, from the Master Schedule. Mark anyone who isn’t here, and add anyone who is but isn’t on the schedule.',
                es: 'Quién trabaja hoy en el cuarto de prerolls, según el Plan Maestro. Marque a quien no vino y agregue a quien está pero no aparece en el horario.' } },
      { k: 'crewSize', t: 'calc', dp: 0, calc: (v) => crewOnRun(v.attendance).size || null,
        l: { en: 'People on this Run', es: 'Personas en esta corrida' } },

      { k: 'endOfRun', t: 'heading',
        l: { en: 'End of Run', es: 'Fin de la corrida' },
        hint: { en: 'Fill these in on the last day of the run, then submit.',
                es: 'Llene esto el último día de la corrida y luego envíe.' } },
      { k: 'newPrerollUid', t: 'uid', l: { en: 'New UID — Pre-Rolls', es: 'UID nuevo — prerolls' } },
      { k: 'newWasteUid', t: 'uid', l: { en: 'New UID — Waste', es: 'UID nuevo — desecho' } },
      { k: 'finishDate', t: 'date', today: false, l: { en: 'Finish Date', es: 'Fecha de terminación' } },
      { k: 'qcComplete', t: 'select',
        l: { en: 'Q.C. Complete', es: 'Control de calidad completo' },
        opts: [
          { v: 'yes', l: { en: 'Yes', es: 'Sí' } },
          { v: 'no', l: { en: 'Not yet', es: 'Todavía no' } }
        ] },
      F.notes(), F.photo()
    ],
    // The second-person count check happens after submit, in the Metrc
    // Queue (weightCheckState; Verify counts), not on the floor form.
    weightCheck: ['totalPrerolls', 'totalWasteG'],
    checkKind: 'count',
    // Pre-rolls are made from material already moved to manufacturing (a
    // Biomass Request), so the input comes off the manufacturing side of the
    // ledger, like a Manufacturing Run.
    flow: { lossKind: 'transform', input: { field: 'startingLb', categoryField: 'inputCategory' }, outputs: [] }
  },

  // ── MANUFACTURING: GROUND FLOWER POUCHES ──────────────────────────────────
  // Same team and the same shape as Pre-Roll Production — a page per run,
  // day tabs, output log, crew check, End of Run — but the output is pouches
  // of ground flower (for now only Howie Roll 14 g). Its work orders share the
  // pre-roll queue (preroll_queue.js, line 'pouch'), so both are ranked in
  // one list on the Pre-Roll Dashboard and Work Orders.
  {
    key: 'pouch_production',
    dept: { en: 'Manufacturing', es: 'Manufactura' },
    title: { en: 'Ground Flower Pouches', es: 'Bolsas de flor molida' },
    desc: { en: 'One run of ground flower pouches (Howie Roll 14 g) from start to finish — output, waste, and who’s working on it, a tab per day. Stays open across days until submitted.',
            es: 'Una corrida de bolsas de flor molida (Howie Roll 14 g) de principio a fin — producción, desecho y quién trabajó, una pestaña por día. Queda abierta varios días hasta enviarla.' },
    color: 'purple',
    headline: 'totalPouches',
    sharedDay: true,
    switcher: { open: { en: 'Runs open', es: 'Corridas abiertas' }, add: { en: '+ New run', es: '+ Nueva corrida' },
                one: { en: 'run', es: 'corrida' }, many: { en: 'runs', es: 'corridas' },
                page: { en: 'pouch run', es: 'corrida de bolsas' } },
    canDelete: true,
    queueTab: true,
    links: [{ href: '/work_orders.html?tab=preroll', l: { en: 'Work Orders →', es: 'Órdenes de trabajo →' } }],
    dayTabs: { lines: ['output', 'attendance'],
               headline: { en: 'Pouches Made That Day', es: 'Bolsas hechas ese día' } },
    fields: [
      { ...F.date(), l: { en: 'Start Date', es: 'Fecha de inicio' } },
      F.project(),
      { k: 'prNum', t: 'text', l: { en: 'Production Request', es: 'Solicitud de producción' },
        prPicker: { line: 'pouch', fills: { batchId: 'ref', brand: 'brand', strain: 'strain', lines: 'inputs', unitSizeG: 'unitSizeG' } },
        hint: { en: 'Pick from the queue — it fills in what it can. Links this batch to the request on the Pre-Roll Dashboard.',
                es: 'Elija de la fila — llena lo que pueda. Vincula este lote con la solicitud en el tablero de prerolls.' } },
      { k: 'batchId', t: 'text', req: true, l: { en: 'Batch ID', es: 'ID de lote' } },
      { k: 'brand', t: 'select', ref: 'brands', allowOther: true,
        l: { en: 'Brand', es: 'Marca' } },
      F.strain(),
      // A run can grind several packages together — flower, smalls and A / A+
      // trim — so the input is a row per source package (POUCH_INPUTS).
      { k: 'lines', t: 'lineitems', req: true,
        l: { en: 'Material Going In', es: 'Material que entra' },
        hint: { en: 'One row per source package: what it is, its Metrc tag and the grams going in.',
                es: 'Una fila por paquete de origen: qué es, su etiqueta Metrc y los gramos que entran.' },
        cols: [
          { k: 'material', t: 'select', req: true, carry: true, l: { en: 'Material', es: 'Material' },
            opts: POUCH_INPUTS.map((v) => ({ v, l: pouchInputLabel(v) })) },
          { k: 'sourceUid', t: 'uid', req: true, l: { en: 'Source UID', es: 'UID de origen' } },
          { k: 'weightG', t: 'number', req: true, min: 0, step: 0.1, l: { en: 'Grams', es: 'Gramos' } }
        ],
        totalCol: 'weightG' },
      { k: 'startingWtG', t: 'calc', dp: 1, calc: (v) => (v.lines || []).reduce((a, r) => a + num(r.weightG), 0) || null,
        l: { en: 'Starting Weight (grams)', es: 'Peso inicial (gramos)' } },
      { k: 'startingLb', t: 'calc', calc: (v) => (num(v.startingWtG) > 0 ? num(v.startingWtG) / G_PER_LB : null),
        l: { en: 'Starting Weight (lbs)', es: 'Peso inicial (lbs)' } },
      { k: 'humidityPct', t: 'number', min: 0, max: 100, step: 0.1, dp: 1,
        l: { en: 'Humidity %', es: '% de humedad' } },
      { k: 'unitSizeG', t: 'number', min: 0, step: 0.01, def: 14,
        l: { en: 'Pouch Size (grams each)', es: 'Tamaño de la bolsa (gramos c/u)' },
        hint: { en: 'Howie Roll pouches are 14 g — used for the yield check below.', es: 'Las bolsas Howie Roll son de 14 g — se usa para el rendimiento abajo.' } },

      { k: 'output', t: 'lineitems', entry: true, req: true,
        l: { en: 'Pouch Output', es: 'Producción de bolsas' },
        hint: { en: 'Add a row each time a count is taken — pouches filled and waste weighed out.',
                es: 'Agregue una fila cada vez que se cuente — bolsas llenadas y desecho pesado.' },
        cols: [
          { k: 'count', t: 'number', l: { en: 'Pouches (each)', es: 'Bolsas (c/u)' }, min: 0, step: 1, dp: 0, inputmode: 'numeric' },
          { k: 'wasteG', t: 'number', l: { en: 'Waste (grams)', es: 'Desecho (gramos)' }, min: 0, step: 0.1, dp: 1 },
          { k: 'notes', t: 'text', l: { en: 'Notes', es: 'Notas' } }
        ],
        totalCol: 'count' },
      { k: 'totalPouches', t: 'calc', dp: 0, calc: (v) => (v.output || []).reduce((a, r) => a + num(r.count), 0),
        l: { en: 'Total Pouches (whole run)', es: 'Total de bolsas (toda la corrida)' } },
      { k: 'totalWasteG', t: 'calc', dp: 1, calc: (v) => (v.output || []).reduce((a, r) => a + num(r.wasteG), 0),
        l: { en: 'Total Waste (grams)', es: 'Desecho total (gramos)' } },
      { k: 'accountedPct', t: 'calc', fmt: 'pct',
        calc: (v) => {
          if (!(num(v.unitSizeG) > 0)) return null;
          const made = (v.output || []).reduce((a, r) => a + num(r.count), 0) * num(v.unitSizeG);
          const waste = (v.output || []).reduce((a, r) => a + num(r.wasteG), 0);
          return pct(made + waste, v.startingWtG);
        },
        l: { en: 'Starting Weight Accounted For', es: 'Peso inicial contabilizado' },
        hint: { en: '(pouches × size + waste) ÷ starting weight. Should land near 100% by the end of the run.',
                es: '(bolsas × tamaño + desecho) ÷ peso inicial. Debe acercarse al 100% al final de la corrida.' },
        flag: (x) => x < 0.95 || x > 1.05 },

      { k: 'attendance', t: 'crewcheck', entry: true,
        l: { en: 'Crew', es: 'Personal' },
        hint: { en: 'Who is working on the pouches today, from the Master Schedule. Mark anyone who isn’t here, and add anyone who is but isn’t on the schedule.',
                es: 'Quién trabaja hoy en las bolsas, según el Plan Maestro. Marque a quien no vino y agregue a quien está pero no aparece en el horario.' } },
      { k: 'crewSize', t: 'calc', dp: 0, calc: (v) => crewOnRun(v.attendance).size || null,
        l: { en: 'People on this Run', es: 'Personas en esta corrida' } },

      { k: 'endOfRun', t: 'heading',
        l: { en: 'End of Run', es: 'Fin de la corrida' },
        hint: { en: 'Fill these in on the last day of the run, then submit.',
                es: 'Llene esto el último día de la corrida y luego envíe.' } },
      { k: 'newPouchUid', t: 'uid', l: { en: 'New UID — Pouches', es: 'UID nuevo — bolsas' } },
      { k: 'newWasteUid', t: 'uid', l: { en: 'New UID — Waste', es: 'UID nuevo — desecho' } },
      { k: 'finishDate', t: 'date', today: false, l: { en: 'Finish Date', es: 'Fecha de terminación' } },
      { k: 'qcComplete', t: 'select',
        l: { en: 'Q.C. Complete', es: 'Control de calidad completo' },
        opts: [
          { v: 'yes', l: { en: 'Yes', es: 'Sí' } },
          { v: 'no', l: { en: 'Not yet', es: 'Todavía no' } }
        ] },
      F.notes(), F.photo()
    ],
    // As Pre-Roll Production: the count check is in the Metrc Queue.
    weightCheck: ['totalPouches', 'totalWasteG'],
    checkKind: 'count',
    // Each row comes off its own category (lines: biomassLedger in
    // ops_analytics.js).
    flow: { lossKind: 'transform', input: { field: 'startingLb', lines: { field: 'lines', categoryCol: 'material', gramsCol: 'weightG' } }, outputs: [] }
  },

  // ── MANUFACTURING OUTPUT ──────────────────────────────────────────────────
  {
    key: 'mfg_output',
    dept: { en: 'Manufacturing', es: 'Manufactura' },
    title: { en: 'Manufacturing Run', es: 'Corrida de manufactura' },
    desc: { en: 'Log a finished-goods run — what went in, how many units came out.',
            es: 'Registre una corrida de producto terminado — qué entró y cuántas unidades salieron.' },
    color: 'purple',
    headline: 'unitsProduced',
    fields: [
      F.date(),
      { k: 'line', t: 'select', req: true,
        l: { en: 'Line', es: 'Línea' },
        opts: [
          { v: 'prerolls', l: { en: 'Prerolls', es: 'Prerolls' } },
          { v: 'flower', l: { en: 'Flower packaging', es: 'Empaque de flor' } },
          { v: 'concentrates', l: { en: 'Concentrates', es: 'Concentrados' } }
        ] },
      { k: 'brand', t: 'select', ref: 'brands', allowOther: true, req: true,
        l: { en: 'Brand', es: 'Marca' } },
      { k: 'sku', t: 'text', req: true, l: { en: 'SKU / Product', es: 'SKU / producto' } },
      F.strain(),
      { k: 'sourceUid', t: 'uid', l: { en: 'Input Package UID', es: 'UID del paquete de entrada' } },
      { k: 'inputCategory', t: 'select', refConst: 'BIOMASS', req: true,
        l: { en: 'Input Biomass Category', es: 'Categoría de biomasa de entrada' } },
      { k: 'inputLb', t: 'number', req: true, min: 0, step: 0.01,
        l: { en: 'Input Weight (lbs)', es: 'Peso de entrada (lbs)' } },
      { k: 'unitsProduced', t: 'number', req: true, min: 0, step: 1, dp: 0,
        l: { en: 'Units Produced', es: 'Unidades producidas' } },
      { k: 'unitSizeG', t: 'number', min: 0, step: 0.01,
        l: { en: 'Unit Size (grams)', es: 'Tamaño de unidad (gramos)' } },
      { k: 'packedLb', t: 'calc', calc: (v) => (num(v.unitsProduced) * num(v.unitSizeG)) / G_PER_LB,
        l: { en: 'Packed Weight (lbs)', es: 'Peso empacado (lbs)' } },
      { k: 'wasteLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Waste / Loss (lbs)', es: 'Desecho / pérdida (lbs)' } },
      { k: 'packYieldPct', t: 'calc', fmt: 'pct',
        calc: (v) => pct((num(v.unitsProduced) * num(v.unitSizeG)) / G_PER_LB, v.inputLb),
        l: { en: 'Packaging Yield %', es: '% de rendimiento de empaque' } },
      { k: 'destination', t: 'select', ref: 'licenses', allowOther: true,
        l: { en: 'Ship To', es: 'Enviar a' } },
      F.teamLead(), F.crewSize(), F.laborHours(), F.crew(), F.notes(), F.photo()
    ],
    // Finished goods leave the biomass ledger entirely, so the input weight
    // "disappearing" here is the run working, not weight going missing.
    flow: { lossKind: 'transform', input: { field: 'inputLb', categoryField: 'inputCategory' }, outputs: [] }
  },

  // ── SHIPPING: PRODUCT TRANSFER — OUTGOING ─────────────────────────────────
  // The paper "Product Transfer Form (OUTGOING)", version 7: who it's for,
  // driver and plate (the same pickers as Harvest) and a row per package
  // going out. In the Metrc Queue for the manifest. Raw Inventory takes each
  // row off its source package (TRANSFER_TYPES says which stock a product
  // type code is). The license, order numbers, manifest and office checklist
  // are `editOnly` — not asked for on the floor, so the form gets done: the
  // Metrc Queue shows the manifest, license, sales order and initiated /
  // accepted from the Canix sync (MetrcTransfers.transferForForm), and the
  // office can still type the rest in with Fix form.
  {
    key: 'transfer_out',
    dept: { en: 'Shipping', es: 'Envíos' },
    title: { en: 'Product Transfer — Outgoing', es: 'Transferencia de producto — salida' },
    desc: { en: 'A transfer going out to a customer — customer, driver and plate, and each package and its weight. Manifest, license and sales order come from Metrc.',
            es: 'Una transferencia que sale a un cliente — cliente, conductor y placa, y cada paquete y su peso. Manifiesto, licencia y orden de venta vienen de Metrc.' },
    color: 'blue',
    headline: 'totalLb',
    fields: [
      { k: 'completedBy', t: 'text', req: true, l: { en: 'Person Completing Form', es: 'Persona que llena el formulario' } },
      { ...F.date(), l: { en: 'Date of Request', es: 'Fecha de la solicitud' } },
      { k: 'requestor', t: 'text', l: { en: 'Requestor’s Name', es: 'Nombre de quien solicita' } },
      { k: 'customer', t: 'text', req: true, l: { en: 'Customer Name', es: 'Nombre del cliente' } },
      { k: 'dccLicense', t: 'text', editOnly: true, l: { en: 'DCC License #', es: 'N.º de licencia DCC' } },
      { k: 'destination', t: 'text', editOnly: true, l: { en: 'Destination', es: 'Destino' } },
      { k: 'customerOrderNo', t: 'text', editOnly: true, l: { en: 'Customer Order #', es: 'N.º de pedido del cliente' } },
      { k: 'salesOrderNo', t: 'text', editOnly: true, l: { en: 'Sales Order #', es: 'N.º de orden de venta' } },
      { k: 'invoiceNo', t: 'text', editOnly: true, l: { en: 'Invoice #', es: 'N.º de factura' } },
      // The Metrc manifest this form is for — how the Metrc Queue knows a
      // manifest already has its form (otherwise it lists it as Needs form).
      // Filled in by a Needs form link; else matched by package UID.
      { k: 'manifestNo', t: 'text', editOnly: true, inputmode: 'numeric', l: { en: 'Metrc Manifest #', es: 'N.º de manifiesto de Metrc' } },
      { k: 'terms', t: 'select', editOnly: true, l: { en: 'Terms', es: 'Términos' },
        opts: [
          { v: 'DF', l: { en: 'DF', es: 'DF' } },
          { v: 'MC', l: { en: 'MC', es: 'MC' } }
        ] },
      { k: 'proposedDate', t: 'date', today: false, l: { en: 'Proposed Transfer Date', es: 'Fecha propuesta de transferencia' } },
      { k: 'actualDate', t: 'date', today: false, l: { en: 'Actual Transfer Date', es: 'Fecha real de transferencia' } },
      { k: 'driver', t: 'select', driverPicker: true, l: { en: 'Driver', es: 'Conductor' } },
      { k: 'licensePlate', t: 'select', platePicker: true, allowOther: true, l: { en: 'Vehicle Plate #', es: 'Placa del vehículo' } },

      { k: 'lines', t: 'lineitems', req: true,
        l: { en: 'Products Going Out', es: 'Productos que salen' },
        hint: { en: 'One row per package. Pick the product type, then the batch it comes off — that fills in strain, PID, CID and source UID and shows what’s available; type the weight going out. Weight in lbs — pieces for pre-rolls. Transfer Package UID is the new tag on the package going out, if it gets one.',
                es: 'Una fila por paquete. Elija el tipo de producto y luego el lote de donde sale — eso llena variedad, PID, CID y UID de origen y muestra lo disponible; escriba el peso que sale. Peso en lbs — piezas para prerolls. El UID del paquete de transferencia es la etiqueta nueva del paquete que sale, si la lleva.' },
        cols: [
          { k: 'productType', t: 'select', req: true, carry: true, l: { en: 'Product Type', es: 'Tipo de producto' },
            opts: [
              { v: '', l: { en: '', es: '' } },
              ...Object.entries(TRANSFER_TYPES).map(([v, x]) => ({ v, l: { en: `${v} — ${x.l.en}`, es: `${v} — ${x.l.es}` } }))
            ] },
          // The batches Raw Inventory has on hand for the product type (its
          // TRANSFER_TYPES tab / cat; ops_form.html, raw_stock.js). Picking
          // one fills `fills` (column → stock row property); `stockAvail`
          // shows its lbs less what this form's other rows take off it.
          { k: 'stockKey', t: 'stock', formOnly: true, stock: (r) => TRANSFER_TYPES[r.productType] || null,
            fills: { strain: 'strain', pid: 'code', cid: 'cid', sourceUid: 'uid' }, weightCol: 'weight',
            l: { en: 'Batch', es: 'Lote' } },
          { k: 'strain', t: 'select', ref: 'strains', allowOther: true, l: { en: 'Strain', es: 'Variedad' } },
          { k: 'pid', t: 'select', ref: 'properties', allowOther: true, l: { en: 'PID', es: 'PID' } },
          { k: 'cid', t: 'select', ref: 'customers', allowOther: true, l: { en: 'CID', es: 'CID' } },
          { k: 'sourceUid', t: 'uid', req: true, canixStrain: 'strain', l: { en: '2CW Source Package UID', es: 'UID del paquete de origen 2CW' } },
          { k: 'availableLb', t: 'stockAvail', formOnly: true, stockCol: 'stockKey', l: { en: 'Available (lbs)', es: 'Disponible (lbs)' } },
          { k: 'weight', t: 'number', req: true, min: 0, step: 0.01, l: { en: 'Weight (lbs) / pieces', es: 'Peso (lbs) / piezas' } },
          { k: 'transferUid', t: 'uid', l: { en: '2CW Transfer Package UID', es: 'UID del paquete de transferencia 2CW' } },
          { k: 'pricePerLb', t: 'number', min: 0, step: 0.01, l: { en: 'Price per lb ($)', es: 'Precio por lb ($)' } }
        ],
        totalCol: 'weight' },
      { k: 'totalLb', t: 'calc',
        calc: (v) => (v.lines || []).filter((r) => !(TRANSFER_TYPES[r.productType] || {}).pieces).reduce((a, r) => a + num(r.weight), 0),
        l: { en: 'Subtotal (lbs)', es: 'Subtotal (lbs)' },
        hint: { en: 'Everything but pre-rolls.', es: 'Todo menos prerolls.' } },
      { k: 'totalPieces', t: 'calc', dp: 0,
        calc: (v) => { const p = (v.lines || []).filter((r) => (TRANSFER_TYPES[r.productType] || {}).pieces); return p.length ? p.reduce((a, r) => a + num(r.weight), 0) : null; },
        l: { en: 'Pre-Rolls (pieces)', es: 'Prerolls (piezas)' } },
      { k: 'totalValue', t: 'calc',
        calc: (v) => { const p = (v.lines || []).filter((r) => num(r.pricePerLb) > 0); return p.length ? p.reduce((a, r) => a + num(r.weight) * num(r.pricePerLb), 0) : null; },
        l: { en: 'Total ($)', es: 'Total ($)' },
        hint: { en: 'Weight × price per lb, on the rows with a price.', es: 'Peso × precio por lb, en las filas con precio.' } },

      { k: 'checklist', t: 'heading', editOnly: true,
        l: { en: 'Checklist', es: 'Lista de verificación' },
        hint: { en: 'Office only. Manifest initiated / accepted show in the Metrc Queue from Canix whether or not they’re ticked here.',
                es: 'Solo oficina. Manifiesto iniciado / aceptado se ven en la Cola de Metrc desde Canix, estén marcados aquí o no.' } },
      { k: 'ckTransferLog', t: 'check', editOnly: true, l: { en: '2CW Transfer Log Updated', es: 'Registro de transferencias 2CW actualizado' } },
      { k: 'ckOrderTracker', t: 'check', editOnly: true, l: { en: '2CW Customer Order Tracker Updated', es: 'Seguimiento de pedidos de clientes 2CW actualizado' } },
      { k: 'ckSalesTracker', t: 'check', editOnly: true, l: { en: '2CW Sales Tracker Updated', es: 'Seguimiento de ventas 2CW actualizado' } },
      { k: 'ckManifestInitiated', t: 'check', editOnly: true, l: { en: 'Manifest Transfer Initiated', es: 'Transferencia de manifiesto iniciada' } },
      { k: 'ckManifestAccepted', t: 'check', editOnly: true, l: { en: 'Manifest Transfer Accepted', es: 'Transferencia de manifiesto aceptada' } },
      { k: 'ckInvoiceSent', t: 'check', editOnly: true, l: { en: '2CW Invoice Sent to Customer', es: 'Factura 2CW enviada al cliente' } },
      { k: 'ckInventoryUpdated', t: 'check', editOnly: true, l: { en: '2CW Processor Inventory Updated', es: 'Inventario del procesador 2CW actualizado' } },
      F.notes(), F.photo()
    ]
  },

  // ── SHIPPING: PRODUCT TRANSFER — INCOMING ─────────────────────────────────
  // Finished or dry material coming in from another facility — a return
  // (smalls sent back), product we trimmed at another site — that no station
  // form made here. One form per manifest, a row per package; Raw Inventory
  // lists each row as stock on the tab its product type says
  // (TRANSFER_INTAKE_TYPES), under the package's UID, so downstream forms and
  // outgoing transfers take it off like any other batch. Not in the Metrc
  // Queue: accepting the manifest is the Metrc Queue's Incoming transfers list.
  {
    key: 'transfer_in',
    dept: { en: 'Shipping', es: 'Envíos' },
    title: { en: 'Product Transfer — Incoming', es: 'Transferencia de producto — entrada' },
    desc: { en: 'Material coming in from another facility — a return, or product trimmed at another site — so it shows in Raw Inventory.',
            es: 'Material que llega de otra instalación — una devolución, o producto cortado en otro sitio — para que aparezca en el inventario.' },
    color: 'blue',
    headline: 'totalLb',
    fields: [
      { k: 'completedBy', t: 'text', req: true, l: { en: 'Person Completing Form', es: 'Persona que llena el formulario' } },
      { ...F.date(), l: { en: 'Date Received', es: 'Fecha de recepción' } },
      { k: 'reason', t: 'select', req: true, l: { en: 'Why It’s Coming In', es: 'Por qué llega' },
        opts: [
          { v: '', l: { en: '', es: '' } },
          { v: 'return', l: { en: 'Return', es: 'Devolución' } },
          { v: 'processed_offsite', l: { en: 'Processed at another site', es: 'Procesado en otro sitio' } },
          { v: 'purchase', l: { en: 'Purchase', es: 'Compra' } },
          { v: 'other', l: { en: 'Other', es: 'Otro' } }
        ] },
      { k: 'fromFacility', t: 'text', req: true, l: { en: 'From (facility / customer)', es: 'De (instalación / cliente)' } },
      { k: 'fromLicense', t: 'text', l: { en: 'From DCC License #', es: 'N.º de licencia DCC de origen' } },
      { k: 'manifestNo', t: 'text', inputmode: 'numeric', l: { en: 'Metrc Manifest #', es: 'N.º de manifiesto de Metrc' } },
      { k: 'driver', t: 'select', driverPicker: true, l: { en: 'Driver', es: 'Conductor' } },
      { k: 'licensePlate', t: 'select', platePicker: true, allowOther: true, l: { en: 'Vehicle Plate #', es: 'Placa del vehículo' } },

      { k: 'lines', t: 'lineitems', req: true,
        l: { en: 'Products Coming In', es: 'Productos que llegan' },
        hint: { en: 'One row per package, as it is on the manifest. Package UID is the Metrc tag on the package we received — the strain fills in from Canix once the sync has it. Pick the trim type for trim.',
                es: 'Una fila por paquete, como viene en el manifiesto. El UID del paquete es la etiqueta de Metrc del paquete recibido — la variedad se llena desde Canix cuando la sincronización lo tenga. Elija el tipo de recorte para el recorte.' },
        cols: [
          { k: 'productType', t: 'select', req: true, carry: true, l: { en: 'Product Type', es: 'Tipo de producto' },
            opts: [
              { v: '', l: { en: '', es: '' } },
              ...TRANSFER_INTAKE_TYPES.map((v) => ({ v: String(v), l: { en: `${v} — ${TRANSFER_TYPES[v].l.en}`, es: `${v} — ${TRANSFER_TYPES[v].l.es}` } }))
            ] },
          { k: 'uid', t: 'uid', req: true, canixStrain: 'strain', l: { en: 'Package UID', es: 'UID del paquete' } },
          { k: 'strain', t: 'select', ref: 'strains', allowOther: true, l: { en: 'Strain', es: 'Variedad' } },
          { k: 'trimType', t: 'select', l: { en: 'Trim Type', es: 'Tipo de recorte' },
            opts: [
              { v: '', l: { en: '', es: '' } },
              { v: 'trim', l: { en: 'Normal', es: 'Normal' } },
              { v: 'trim_a_plus', l: { en: 'A+', es: 'A+' } },
              { v: 'sugar_trim', l: { en: 'Sugar', es: 'Azucarado' } },
              { v: 'shake', l: { en: 'Shake', es: 'Shake' } }
            ] },
          { k: 'pid', t: 'select', ref: 'properties', allowOther: true, l: { en: 'PID', es: 'PID' } },
          { k: 'cid', t: 'select', ref: 'customers', allowOther: true, l: { en: 'CID', es: 'CID' } },
          { k: 'weight', t: 'number', req: true, min: 0, step: 0.01, l: { en: 'Weight (lbs)', es: 'Peso (lbs)' } },
          { k: 'location', t: 'text', l: { en: 'Stored At', es: 'Guardado en' } }
        ],
        totalCol: 'weight' },
      { k: 'totalLb', t: 'calc', calc: (v) => (v.lines || []).reduce((a, r) => a + num(r.weight), 0),
        l: { en: 'Total (lbs)', es: 'Total (lbs)' } },
      F.notes(), F.photo()
    ]
  }
];

// Forms that stand apart from the flow: entered through ops_form.html like
// any station, but left out of OPERATIONS_STATIONS, so nothing that walks the
// stations (Raw Inventory, Metrc Queue, Today board, Labor Log, dashboards,
// analytics, emailed reports, lot lookups) ever reads them. Only the hub,
// the admin panel's station access and the form itself use ALL_STATIONS.
//
// Hand Trim — Past Records (`hand_trim_history`): old paper hand trim sheets
// typed in after the stock is long gone, for the record and for its report
// (hand_trim_history.html). Hand Trim's own form, less what ties it to the
// flow: the Lot Number is typed (no bucked-lot list, nothing prefilled), and
// no Queue tab, Metrc tags or flow.
const STANDALONE_STATIONS = [
  (() => {
    const ht = OPERATIONS_STATIONS.find((s) => s.key === 'hand_trim');
    const drop = new Set(['project']);
    const fields = ht.fields.filter((f) => !drop.has(f.k)).map((f) => {
      const { prefill, picker, pickedLabel, ...rest } = f;
      if (f.k === 'sourceUid') return { ...rest,
        hint: { en: 'The package UID from the paper sheet.', es: 'El UID del paquete de la hoja de papel.' } };
      // Old sheets don't always show the rate.
      if (f.k === 'trimRatePerLb') return { ...rest, req: false,
        hint: { en: 'What the trimmers were paid per pound, if the sheet shows it.',
                es: 'Lo que se pagó por libra, si la hoja lo muestra.' } };
      return rest;
    });
    return {
      ...ht,
      key: 'hand_trim_history',
      standalone: true,
      title: { en: 'Hand Trim — Past Records', es: 'Corte a mano — registros pasados' },
      desc: { en: 'Type in old hand trim sheets. Kept on its own: it never touches inventory, Metrc, the Labor Log or the dashboards.',
              es: 'Capture hojas viejas de corte a mano. Queda aparte: nunca toca el inventario, Metrc, el registro de labor ni los tableros.' },
      color: 'cyan',
      switcher: { open: { en: 'Sheets open', es: 'Hojas abiertas' }, add: { en: '+ New sheet', es: '+ Nueva hoja' },
                  one: { en: 'sheet', es: 'hoja' }, many: { en: 'sheets', es: 'hojas' },
                  page: { en: 'past hand trim', es: 'corte a mano pasado' } },
      queueTab: false,
      links: [{ href: '/hand_trim_history.html', l: { en: 'Report →', es: 'Reporte →' } }],
      // Edit on a submitted record goes back to the report, not the Today board.
      recordsHref: '/hand_trim_history.html',
      dailySummary: { ...ht.dailySummary,
                      hint: { en: 'Finished flower credited to that day on every past-records sheet, in pounds. Open sheets included.',
                              es: 'Flor terminada de ese día en todas las hojas de registros pasados, en libras. Incluye hojas abiertas.' } },
      fields,
      metrcTags: undefined,
      flow: undefined
    };
  })()
];

// Which stage a station pulls its `prefill: 'lookup'` values from, and which
// field on that stage supplies each prefilled key.
const PREFILL_MAP = {
  // Take Down looks up the farm package by its `incomingUid` (the only uid
  // field there with prefill: 'lookup' — the on-stem UID is a new tag). Its
  // room isn't mapped: it's picked first, to narrow the package list.
  dry_check:   { from: 'intake_wet',   map: { strain: 'strain', pid: 'pid', cid: 'cid', wetIntakeLb: 'totalWetLb' } },
  // Bucking looks up the on-stem package Take Down made (or a part released
  // off a held one under its own tag), and warns when it's still on hold.
  buck:        { from: 'dry_check',    map: { strain: 'strain', dryUnbuckedLb: 'unbuckedLb' },
                 warn: (up) => (up.result && up.result !== 'pass'
                   ? { en: 'This package is on hold at Take Down. A manager has to release it (On-Stem Flower page) before it’s bucked.',
                       es: 'Este paquete está en espera en la bajada. Un gerente tiene que liberarlo (página Flor en tallo) antes de desvararlo.' }
                   : null) },
  machine_trim:{ from: 'buck',         map: { strain: 'strain', inputBuckedLb: 'buckedFlowerLb' } },
  // Hand Trim starts from bucked flower; `cid` only comes with a lot picked
  // from the list (buckedLots traces it back to the intake).
  hand_trim:   { from: 'buck',         map: { strain: 'strain', cid: 'cid', startingBuckedLb: 'buckedFlowerLb' },
                 warn: (up) => (up.inProgress
                   ? { en: 'Still being bucked — the starting weight is what’s been bucked so far. Update it if more comes over.',
                       es: 'Todavía se está desvarando — el peso inicial es lo desvarado hasta ahora. Actualícelo si llega más.' }
                   : null) }
};

// Order of the pipeline, for the dashboard's stage funnel.
const PIPELINE_ORDER = ['harvest', 'intake_wet', 'dry_check', 'buck', 'machine_trim', 'hand_trim'];

const STATION_BY_KEY = Object.fromEntries(OPERATIONS_STATIONS.map((s) => [s.key, s]));
// Every form ops_form.html can open, standalone ones included (see
// STANDALONE_STATIONS) — for the hub, admin access and the form page only.
const ALL_STATIONS = [...OPERATIONS_STATIONS, ...STANDALONE_STATIONS];
const ALL_STATION_BY_KEY = Object.fromEntries(ALL_STATIONS.map((s) => [s.key, s]));

// Labor Log processes that aren't station forms (labor_log.html's process
// list, alongside the stations). 'other' is "Other / general".
const LABOR_PROCESSES = {
  transport: { en: 'Transportation', es: 'Transporte' },
  other:     { en: 'Other / general', es: 'Otro / general' }
};
// Work locations — Scheduling's day schedules and the Master Schedule's
// projects. 'other' takes a typed name (`locationName`).
const WORK_LOCATIONS = [
  ['adobe', 'Adobe'], ['airway', 'Airway'], ['wildcat', 'Wildcat'], ['comstock', 'Comstock'],
  ['lucerne', 'Lucerne'], ['sulphur_bank', 'Sulphur Bank'], ['highland', 'Highland'], ['other', null]
];
// Master Schedule projects (master_schedule.html, station_key
// 'work_project'): fields { name, location, locationName, process, start,
// end (dates; no end = open-ended), days (0 = Sun … 6 = Sat; empty = every
// day), startTime, endTime, status, lead: {userId, name} (the project lead),
// roles: [{id, name, process, startTime?, endTime?, people: [{userId,
// name}]}], uids, notes, overrides: {date: {skip, note, out, extra, flc,
// here, times}} }. Roles are the standing responsibilities on the
// project and the people under each — the daily/weekly schedule is every
// project running that day with its lead and roles. A role's start or end
// is only set when it differs from the project's.
// With overnight hours (end before start) the end date is the morning the
// last shift ends, so "Oct 6 – Oct 7, 10 PM–6 AM" is one night, starting the
// 6th; with the end date equal to the start it's still that one night.
const projectRunsOn = (f, date) => {
  if (!f || (f.status || 'active') === 'done' || !date) return false;
  if (f.start && date < f.start) return false;
  if (f.end && date > f.end) return false;
  if (f.end && date === f.end && f.end !== f.start && projectHours(f)[1] > 1440) return false;
  const dow = new Date(date + 'T12:00:00').getDay();
  return !(f.days && f.days.length) || f.days.includes(dow);
};
// A project's (or one role's) hours that day as [startMin, endMin], the end
// past 1440 when it runs over midnight and start + 8 h when there's no end;
// [null, null] when no times are set (all day). A role's own start/end each
// override the project's, so a role can differ in just one of them.
const projectHours = (f, role) => {
  const toMin = (s) => { const [h, m] = String(s || '').split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null; };
  const s = toMin((role && role.startTime) || f.startTime);
  if (s == null) return [null, null];
  const e0 = toMin((role && role.endTime) || f.endTime);
  return [s, e0 == null ? s + 480 : (e0 <= s ? e0 + 1440 : e0)];
};
// The project lead as a role of its own (id '_lead', listed first), then
// the responsibilities — everyone working the project, for the schedule,
// conflicts and the Labor Log's right-click.
const projectRoles = (f, leadLabel) => [
  ...(f && f.lead && f.lead.name ? [{ id: '_lead', name: leadLabel || 'Lead', isLead: true, people: [{ ...f.lead, lead: true }] }] : []),
  ...((f && f.roles) || []).map((r) => ({ ...r, people: r.people || [] }))
];
// A clock time ('HH:MM') as minutes inside a project's (or role's) hours
// that day: past 1440 when the hours run overnight and the time is after
// midnight ('02:00' in a 10 PM–6 AM shift is 1560). null for no time.
const shiftMin = (f, role, hm) => {
  const [h, m] = String(hm || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const x = h * 60 + m, e = projectHours(f, role)[1];
  return e != null && e > 1440 && x <= e - 1440 ? x + 1440 : x;
};
// One person's hours on a project on a day, as [[startMin, endMin], …]: the
// role's (projectHours) unless that day's changes give them times of their
// own — overrides[date].times[personKey] = [{start, end}] ('HH:MM', blank =
// the role's), written by Crew Check-In (crew_checkin.html) when a lead
// moves someone to another station partway through the day, or they go home
// early. [] means no time there that day (moved off before it started). An
// all-day role with times of its own runs midnight to midnight, and an end
// at or before its start runs past midnight (6:41 PM–12:00 AM).
const personSpans = (f, role, date, key) => {
  const own = ((((f && f.overrides) || {})[date] || {}).times || {})[key];
  const [s, e] = projectHours(f, role);
  if (!Array.isArray(own)) return [[s, e]];
  const s0 = s == null ? 0 : s, e0 = s == null ? 1440 : e;
  return own.map((x) => {
    const a = x.start ? shiftMin(f, role, x.start) : s0;
    const b = x.end ? shiftMin(f, role, x.end) : e0;
    return [a, b <= a && x.end ? b + 1440 : b];
  }).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
};
// True when that day's changes give the person times of their own there.
const hasOwnTimes = (f, date, key) => Array.isArray(((((f && f.overrides) || {})[date] || {}).times || {})[key]);

// A crew check (Pre-Roll's `attendance`): the latest row per person per
// day, as a Map 'day|key' -> row.
const crewLatest = (rows) => {
  const m = new Map();
  (rows || []).filter((r) => r && r.key).slice().sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
    .forEach((r) => m.set(`${r.day || ''}|${r.key}`, r));
  return m;
};
// Everyone marked here (or added) on any day of the run, by person key.
const crewOnRun = (rows) => new Set([...crewLatest(rows).values()].filter((r) => r.status === 'here' || r.status === 'added').map((r) => r.key));

// Display name for any Labor Log process key — station or not.
const processTitle = (k) => (STATION_BY_KEY[k] && STATION_BY_KEY[k].title) || LABOR_PROCESSES[k] || { en: k || '—', es: k || '—' };

if (typeof module !== 'undefined') {
  module.exports = { weightCheckState, weightSnapshot, TRANSFER_TYPES, TRANSFER_INTAKE_TYPES, crewLatest, crewOnRun, OPERATIONS_STATIONS, STATION_BY_KEY, STANDALONE_STATIONS, ALL_STATIONS, ALL_STATION_BY_KEY, BIOMASS, SELLABLE, PREFILL_MAP, PIPELINE_ORDER, G_PER_LB, LABOR_PROCESSES, WORK_LOCATIONS, projectRunsOn, projectHours, projectRoles, shiftMin, personSpans, hasOwnTimes, processTitle, buckedLb };
}
