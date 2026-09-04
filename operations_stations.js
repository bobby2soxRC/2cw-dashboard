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
//   t      text | number | date | time | select | textarea | uid | photo | calc | lineitems
//   l      label {en, es}
//   req    required
//   ref    name of a list in data/operations/reference.json to populate a select
//   opts   inline select options [{v, l:{en,es}}]
//   calc   (v) => number | null   — computed from the other values, read-only
//   dp     decimal places for number/calc display (default 2)
//   hint   {en, es} helper text under the field
//   showIf (v) => bool
//   prefill 'lookup' — pull from the upstream stage record matching sourceUid
// ─────────────────────────────────────────────────────────────────────────────

const G_PER_LB = 453.59237;

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

// Categories that are sellable / usable biomass (the rest is waste or an
// intermediate that gets consumed by the next stage).
const SELLABLE = ['flower_a', 'smalls_b', 'sugar_trim', 'trim', 'trim_a_plus', 'trim_a', 'trim_b', 'shake', 'fresh_frozen'];

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };
const sum = (v, keys) => keys.reduce((a, k) => a + num(v[k]), 0);
const pct = (part, whole) => (num(whole) > 0 ? num(part) / num(whole) : null);

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
  {
    key: 'harvest',
    dept: { en: 'Cultivation', es: 'Cultivo' },
    title: { en: 'Harvest', es: 'Cosecha' },
    desc: { en: 'Log a harvest off a farm block — plant count, wet weight, and where it is headed.',
            es: 'Registre una cosecha de un bloque — número de plantas, peso húmedo y su destino.' },
    color: 'green',
    headline: 'wetWeightLb',
    fields: [
      F.date(),
      F.site(),
      { k: 'pid', t: 'select', ref: 'properties', allowOther: true,
        l: { en: 'Property ID (PID)', es: 'ID de propiedad (PID)' } },
      { k: 'block', t: 'text', l: { en: 'Field / Block', es: 'Campo / bloque' } },
      { k: 'round', t: 'select', allowOther: true,
        l: { en: 'Season / Round', es: 'Temporada / ronda' },
        opts: [
          { v: 'R1', l: { en: 'Round 1', es: 'Ronda 1' } },
          { v: 'R2', l: { en: 'Round 2', es: 'Ronda 2' } },
          { v: 'R3', l: { en: 'Round 3', es: 'Ronda 3' } },
          { v: 'R4', l: { en: 'Round 4', es: 'Ronda 4' } }
        ] },
      F.strain(),
      { k: 'harvestBatchName', t: 'text', req: true,
        l: { en: 'Harvest / Batch Name', es: 'Nombre de cosecha / lote' },
        hint: { en: 'e.g. AF-071-Glitter Bomb-224-T2', es: 'p. ej. AF-071-Glitter Bomb-224-T2' } },
      { k: 'sourceUid', t: 'uid', l: { en: 'Metrc UID Tag', es: 'Etiqueta UID de Metrc' } },
      { k: 'harvestStyle', t: 'select', req: true,
        l: { en: 'Harvest Style', es: 'Estilo de cosecha' },
        opts: [
          { v: 'whole_plant', l: { en: 'Whole plant — hang to dry', es: 'Planta entera — colgar a secar' } },
          { v: 'bucked_wet', l: { en: 'Bucked wet — to dry facility', es: 'Desvarado húmedo — a secado' } },
          { v: 'fresh_frozen', l: { en: 'Fresh frozen — to freezer', es: 'Fresco congelado — a congelador' } }
        ] },
      { k: 'plantCount', t: 'number', min: 0, step: 1, dp: 0,
        l: { en: 'Plant Count', es: 'Número de plantas' } },
      { k: 'wetWeightLb', t: 'number', req: true, min: 0, step: 0.01,
        l: { en: 'Wet Weight (lbs)', es: 'Peso húmedo (lbs)' } },
      { k: 'lbPerPlant', t: 'calc', calc: (v) => (num(v.plantCount) > 0 ? num(v.wetWeightLb) / num(v.plantCount) : null),
        l: { en: 'Wet lbs / Plant', es: 'Lbs húmedos por planta' } },
      { k: 'binCount', t: 'number', min: 0, step: 1, dp: 0,
        l: { en: 'Bins / Bags Loaded', es: 'Bins / bolsas cargadas' } },
      { k: 'destination', t: 'select', req: true,
        l: { en: 'Destination', es: 'Destino' },
        opts: [
          { v: 'dry_facility', l: { en: 'Drying facility', es: 'Instalación de secado' } },
          { v: 'freezer', l: { en: 'Freezer (fresh frozen)', es: 'Congelador (fresco congelado)' } }
        ] },
      F.teamLead(), F.crewSize(), F.laborHours(), F.crew(), F.notes(), F.photo()
    ],
    flow: { lossKind: 'origin', outputs: [{ field: 'wetWeightLb', category: 'wet_whole_plant' }] }
  },

  // ── PROCESSING: FRESH PLANT INTAKE ────────────────────────────────────────
  // Matches the real paper log: one truck, one license, unloaded a few
  // containers at a time — each weigh-in gets its own line with its own UID,
  // strain, and format, since a truck can carry more than one of each.
  {
    key: 'intake_wet',
    dept: { en: 'Processing', es: 'Procesamiento' },
    title: { en: 'Fresh Plant Intake', es: 'Recepción de Planta Fresca' },
    desc: { en: 'Log a truck as it comes off the farm — one line per group of containers weighed as it’s unloaded.',
            es: 'Registre un camión que llega del rancho — una línea por cada grupo de contenedores pesado al descargar.' },
    color: 'blue',
    headline: 'totalWetLb',
    fields: [
      F.date(),
      { k: 'pid', t: 'select', ref: 'properties', allowOther: true, req: true,
        l: { en: 'License / PID', es: 'Licencia / PID' },
        hint: { en: 'Which license this truck is coming from.', es: 'De qué licencia proviene este camión.' } },
      { k: 'manifestPhoto', t: 'photo',
        l: { en: 'Metrc Manifest Photo', es: 'Foto del manifiesto de Metrc' },
        hint: { en: 'Photo of the manifest that came with this truck.',
                es: 'Foto del manifiesto que llegó con este camión.' } },
      { k: 'lines', t: 'lineitems', req: true,
        l: { en: 'Unloaded Containers', es: 'Contenedores descargados' },
        hint: { en: 'One row per weigh-in as the truck is unloaded — e.g. 3 bins weighed, then another 3 or 4.',
                es: 'Una fila por cada pesaje al descargar el camión — p. ej. 3 bins pesados, luego otros 3 o 4.' },
        cols: [
          { k: 'containerType', t: 'select', def: 'bins',
            l: { en: 'Container', es: 'Contenedor' },
            opts: [
              { v: 'bins', l: { en: 'Bins (Venes)', es: 'Venes' } },
              { v: 'totes', l: { en: 'Totes', es: 'Totes' } },
              { v: 'crates', l: { en: 'Crates', es: 'Cajas de campo' } },
              { v: 'boxes', l: { en: 'Boxes', es: 'Cajas' } }
            ] },
          { k: 'containerCount', t: 'number', l: { en: '#', es: '#' }, min: 0, step: 1, inputmode: 'numeric' },
          { k: 'weight', t: 'number', l: { en: 'Weight (lbs)', es: 'Peso (lbs)' }, min: 0, step: 0.01 },
          { k: 'sourceUid', t: 'text', l: { en: 'UID', es: 'UID' }, inputmode: 'latin' },
          { k: 'strain', t: 'text', l: { en: 'Strain', es: 'Variedad' } },
          { k: 'intakeFormat', t: 'select', def: 'wet_on_stem',
            l: { en: 'Format', es: 'Formato' },
            opts: [
              { v: 'wet_on_stem', l: { en: 'Wet on Stem', es: 'Húmedo en tallo' } },
              { v: 'fresh_frozen', l: { en: 'Fresh Frozen', es: 'Fresco congelado' } }
            ] }
        ],
        totalCol: 'weight' },
      { k: 'totalWetLb', t: 'calc', calc: (v) => (v.lines || []).reduce((a, r) => a + num(r.weight), 0),
        l: { en: 'Total Wet Weight (lbs)', es: 'Peso húmedo total (lbs)' } },
      { k: 'binCount', t: 'calc', dp: 0, calc: (v) => (v.lines || []).reduce((a, r) => a + num(r.containerCount), 0),
        l: { en: 'Total Containers', es: 'Contenedores totales' } },
      // One room for the whole load — the crew hangs a truck together in
      // whichever room has space, not split by strain/line. Flag if that
      // turns out wrong and a truck really does get split across rooms.
      { k: 'dryRoom', t: 'select', ref: 'dryRooms', allowOther: true, req: true,
        l: { en: 'Dry Room / Area', es: 'Sala / área de secado' } },
      F.teamLead(), F.crewSize(), F.laborHours(), F.crew(), F.notes()
    ],
    flow: {
      // buildLots/findUpstream read this to walk into `lines` instead of a
      // single top-level UID — a truck can carry more than one batch, so its
      // intake record has to split across lots/prefill by line, not as one.
      perLine: { arrayField: 'lines', uidCol: 'sourceUid', strainCol: 'strain', weightCol: 'weight', category: 'wet_whole_plant' },
      outputs: [{ field: 'totalWetLb', category: 'wet_whole_plant', pending: true }]
    }
  },

  // ── PROCESSING: POST-DRY CHECK ────────────────────────────────────────────
  {
    key: 'dry_check',
    dept: { en: 'Processing', es: 'Procesamiento' },
    title: { en: 'Post-Dry Check', es: 'Verificación post-secado' },
    desc: { en: 'Weigh the dried batch and record moisture before it moves to bucking.',
            es: 'Pese el lote seco y registre la humedad antes de pasar a desvarado.' },
    color: 'blue',
    headline: 'dryWeightLb',
    fields: [
      F.date(),
      F.sourceUid(),
      { k: 'strain', t: 'select', ref: 'strains', allowOther: true, prefill: 'lookup',
        l: { en: 'Strain', es: 'Variedad (cepa)' } },
      { k: 'dryRoom', t: 'select', ref: 'dryRooms', allowOther: true, prefill: 'lookup',
        l: { en: 'Dry Room / Area', es: 'Sala / área de secado' } },
      { k: 'wetIntakeLb', t: 'number', min: 0, step: 0.01, prefill: 'lookup',
        l: { en: 'Wet Intake Weight (lbs)', es: 'Peso húmedo de entrada (lbs)' } },
      { k: 'dryWeightLb', t: 'number', req: true, min: 0, step: 0.01,
        l: { en: 'Dry Weight (lbs)', es: 'Peso seco (lbs)' } },
      { k: 'moistureLossLb', t: 'calc', calc: (v) => num(v.wetIntakeLb) - num(v.dryWeightLb),
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
      { k: 'result', t: 'select', req: true,
        l: { en: 'Result', es: 'Resultado' },
        opts: [
          { v: 'pass', l: { en: 'Pass — release to bucking', es: 'Aprobado — liberar a desvarado' } },
          { v: 'hold', l: { en: 'Hold — needs more dry time', es: 'En espera — necesita más secado' } },
          { v: 'rework', l: { en: 'Rework — quality issue', es: 'Reproceso — problema de calidad' } }
        ] },
      { k: 'checkedBy', t: 'text', req: true, l: { en: 'Checked By', es: 'Verificado por' } },
      F.notes(), F.photo()
    ],
    flow: { lossKind: 'moisture',
            input: { field: 'wetIntakeLb', category: 'wet_whole_plant' },
            outputs: [{ field: 'dryWeightLb', category: 'dry_whole_plant' }] }
  },

  // ── PROCESSING: BUCKING ───────────────────────────────────────────────────
  // Superseded by a custom 4-tab page (buck_station.html — see customHref)
  // matching how the crew actually works: many strains being bucked at once,
  // by a rotating crew, over multiple days per batch — not one form filled
  // out once. The fields/flow below are KEPT (not deleted) because
  // buck_station.html writes a summary record in this exact shape when a
  // batch is closed, so machine_trim's prefill, the yield/variance calc, and
  // the dashboard all keep reading 'buck' the same way they always did —
  // they have no idea the data came from many small submissions instead of
  // one big form. See docs/OPERATIONS_APP.md for the full data model.
  {
    key: 'buck',
    dept: { en: 'Processing', es: 'Procesamiento' },
    title: { en: 'Bucking', es: 'Desvarado (bucking)' },
    desc: { en: 'Log bucked flower by employee and strain as it happens — batches, boxes, and the daily roster.',
            es: 'Registre la flor desvarada por empleado y variedad a medida que ocurre — lotes, cajas y el registro diario.' },
    color: 'gold',
    headline: 'buckedFlowerLb',
    customHref: '/buck_station.html',
    // No sourceUid/dep on F.sourceUid() here — buck_station.html writes
    // `sourceUid` directly as the batch's own UID (the one dry_check
    // created). Bucking never mints a new UID of its own, so the material
    // keeps flowing under that same tag straight through to Machine Trim.
    fields: [
      F.date(),
      { k: 'strain', t: 'select', ref: 'strains', allowOther: true,
        l: { en: 'Strain', es: 'Variedad (cepa)' } },
      { k: 'startingDryLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Total Starting Weight — Sum of Boxes (lbs)', es: 'Peso inicial total — suma de cajas (lbs)' },
        hint: { en: 'Sum of every box’s starting weight logged against this batch.',
                es: 'Suma del peso inicial de cada caja registrada para este lote.' } },
      { k: 'buckedFlowerLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Total Bucked Flower (lbs)', es: 'Flor desvarada total (lbs)' },
        hint: { en: 'Sum of every employee submission logged against this batch.',
                es: 'Suma de cada envío de empleado registrado para este lote.' } },
      { k: 'bigLeafLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Big Leaf (lbs)', es: 'Hoja grande (lbs)' } },
      { k: 'stemLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Stems / Sticks (lbs)', es: 'Tallos / palos (lbs)' } },
      F.waste(),
      { k: 'aPlusTrimLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'A+ Trim (lbs)', es: 'Recorte A+ (lbs)' } },
      { k: 'aTrimLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'A Trim (lbs)', es: 'Recorte A (lbs)' } },
      { k: 'bTrimLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'B Trim (lbs)', es: 'Recorte B (lbs)' } },
      ...totalsBlock('startingDryLb', ['buckedFlowerLb', 'bigLeafLb', 'stemLb', 'wasteLb', 'aPlusTrimLb', 'aTrimLb', 'bTrimLb']),
      { k: 'buckYieldPct', t: 'calc', fmt: 'pct', calc: (v) => pct(v.buckedFlowerLb, v.startingDryLb),
        l: { en: 'Bucked Flower Yield %', es: '% de rendimiento de flor desvarada' } },
      // Captured once, at batch close-out (buck_station.html's Batches tab) —
      // a coarse crew/hours summary alongside the granular per-submission
      // weight log, so the payroll-join seam (employeeNo × date × batch ×
      // hours) documented in OPERATIONS_APP.md keeps working for Bucking.
      F.teamLead(), F.crewSize(), F.laborHours(), F.crew(), F.notes(), F.photo()
    ],
    flow: { lossKind: 'conserving',
            input: { field: 'startingDryLb', category: 'dry_whole_plant' },
            outputs: [
              { field: 'buckedFlowerLb', category: 'bucked_flower' },
              { field: 'bigLeafLb', category: 'big_leaf' },
              { field: 'stemLb', category: 'stems' },
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
    fields: [
      { k: 'workOrderNo', t: 'text', l: { en: 'Work Order #', es: 'N.º de orden de trabajo' } },
      F.date(),
      F.sourceUid({ en: 'Package UID', es: 'UID del paquete' }),
      { k: 'strain', t: 'select', ref: 'strains', allowOther: true, req: true,
        l: { en: 'Strain', es: 'Variedad (cepa)' } },
      { k: 'strainGrade', t: 'select',
        l: { en: 'Strain Grade', es: 'Grado de la variedad' },
        opts: [
          { v: 'A', l: { en: 'A', es: 'A' } },
          { v: 'B', l: { en: 'B', es: 'B' } },
          { v: 'whole_plant', l: { en: 'Whole Plant', es: 'Planta entera' } },
          { v: 'mixed', l: { en: 'Mixed', es: 'Mixto' } }
        ] },
      { k: 'trimStyle', t: 'select', req: true,
        l: { en: 'Trim Style', es: 'Estilo de corte' },
        opts: [
          { v: 'hand_finish', l: { en: 'Machine trim + hand finish', es: 'Corte a máquina + acabado a mano' } },
          { v: 'full_hand', l: { en: '100% hand trim', es: '100% a mano' } }
        ] },
      { k: 'pid', t: 'select', ref: 'properties', allowOther: true,
        l: { en: 'Property ID (PID)', es: 'ID de propiedad (PID)' } },
      { k: 'cid', t: 'text', l: { en: 'Customer ID (CID)', es: 'ID de cliente (CID)' } },
      { k: 'startingBins', t: 'number', min: 0, step: 1, dp: 0,
        l: { en: 'Starting # of Bins / Bags', es: 'N.º inicial de bins / bolsas' } },
      { k: 'startingBuckedLb', t: 'number', req: true, min: 0, step: 0.01, prefill: 'lookup',
        l: { en: 'Total Starting Bucked Weight (lbs)', es: 'Peso desvarado inicial total (lbs)' } },

      // The weighing worksheet from the paper form: one row per trimmer.
      { k: 'weights', t: 'lineitems', req: true,
        l: { en: 'Finished Flower — Weighing Worksheet', es: 'Flor terminada — hoja de pesaje' },
        hint: { en: 'One row per trimmer. Add a row for every bag weighed out.',
                es: 'Una fila por persona. Agregue una fila por cada bolsa pesada.' },
        cols: [
          { k: 'employeeNo', t: 'text', l: { en: 'Employee #', es: 'N.º de empleado' }, inputmode: 'numeric' },
          { k: 'grams', t: 'number', l: { en: 'Weight (gm)', es: 'Peso (gm)' }, min: 0, step: 1 }
        ],
        totalCol: 'grams' },

      { k: 'totalGrams', t: 'calc', dp: 0,
        calc: (v) => (v.weights || []).reduce((a, r) => a + num(r.grams), 0),
        l: { en: 'Total Finished Flower (grams)', es: 'Flor terminada total (gramos)' } },
      { k: 'finishedFlowerLb', t: 'calc',
        calc: (v) => (v.weights || []).reduce((a, r) => a + num(r.grams), 0) / G_PER_LB,
        l: { en: 'Total Finished Flower (lbs)', es: 'Flor terminada total (lbs)' },
        hint: { en: 'grams ÷ 453.592. (The printed form says "× 454" — that is a typo on the form.)',
                es: 'gramos ÷ 453.592. (El formulario impreso dice "× 454" — es un error del formulario.)' } },
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

      { k: 'smallsLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Smalls Pulled (lbs)', es: 'Smalls separados (lbs)' } },
      { k: 'sugarTrimLb', t: 'number', min: 0, step: 0.01,
        l: { en: 'Sugar Trim / Scissor Leaf (lbs)', es: 'Hoja azucarada / de tijera (lbs)' } },
      F.waste(),
      { k: 'bagCount', t: 'number', min: 0, step: 1, dp: 0,
        l: { en: 'Finished Bag Count', es: 'Conteo de bolsas terminadas' } },
      ...totalsBlock('startingBuckedLb', ['finishedFlowerLb', 'smallsLb', 'sugarTrimLb', 'wasteLb']),
      F.teamLead(), F.laborHours(), F.notes(), F.photo()
    ],
    flow: { lossKind: 'conserving',
            input: { field: 'startingBuckedLb', category: 'bucked_flower' },
            outputs: [
              { field: 'finishedFlowerLb', category: 'flower_a' },
              { field: 'smallsLb', category: 'smalls_b' },
              { field: 'sugarTrimLb', category: 'sugar_trim' },
              { field: 'wasteLb', category: 'waste' }
            ] }
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
  }
];

// Which stage a station pulls its `prefill: 'lookup'` values from, and which
// field on that stage supplies each prefilled key.
const PREFILL_MAP = {
  // Fresh Plant Intake has no single top-level UID to type in (a truck can
  // carry several), so it no longer offers an incoming prefill from harvest —
  // the operator types the strain/UID per line off the manifest instead.
  dry_check:   { from: 'intake_wet',   map: { strain: 'strain', dryRoom: 'dryRoom', wetIntakeLb: 'weight' } },
  // Bucking has its own custom page (buck_station.html) now, not the generic
  // form, so it does its own upstream lookups directly rather than through
  // this table — no 'buck' entry needed here.
  machine_trim:{ from: 'buck',         map: { strain: 'strain', inputBuckedLb: 'buckedFlowerLb' } },
  hand_trim:   { from: 'machine_trim', map: { strain: 'strain', startingBuckedLb: 'flowerALb' } }
};

// Order of the pipeline, for the dashboard's stage funnel.
const PIPELINE_ORDER = ['harvest', 'intake_wet', 'dry_check', 'buck', 'machine_trim', 'hand_trim'];

const STATION_BY_KEY = Object.fromEntries(OPERATIONS_STATIONS.map((s) => [s.key, s]));

if (typeof module !== 'undefined') {
  module.exports = { OPERATIONS_STATIONS, STATION_BY_KEY, BIOMASS, SELLABLE, PREFILL_MAP, PIPELINE_ORDER, G_PER_LB };
}
