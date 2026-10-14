// Post-harvest services and rates from the 2026 pricing sheet, shared by the
// Drying Schedule (drying_schedule.html) and the client request form
// (drying_request.html). The keys are what's stored in
// drying_intakes.services — add new ones freely, but don't rename a key once
// clients have it saved, and add any new key to ALLOWED_SERVICES in
// netlify/functions/drying-request.js too, and its Exhibit B unit and rate
// to EXB in msa_agreement.js. group_es / es / rate_es are the Spanish text
// the client form shows when it's switched to Español.
const DRYING_SERVICES = [
  { group: 'Drying', group_es: 'Secado', items: [
    { k: 'drying', l: 'Drying', short: 'Drying', rate: '$3.00 / wet lb',
      es: 'Secado', rate_es: '$3.00 / lb húmeda' }] },
  { group: 'Harvest labor', group_es: 'Mano de obra de cosecha', items: [
    { k: 'farm_labor', l: 'Farm labor / farm support', short: 'Farm support', rate: '$25 / hr / person',
      es: 'Mano de obra / apoyo en la granja', rate_es: '$25 / hr / persona' }] },
  { group: 'Trimming & processing', group_es: 'Recorte y procesamiento', items: [
    { k: 'hand_bucking', l: 'Hand bucking', short: 'Bucking', rate: '$7 / lb',
      es: 'Desgrane a mano (bucking)', rate_es: '$7 / lb' },
    { k: 'hand_trim', l: '100% hand trim', short: 'Hand trim', rate: '$75 / lb',
      es: '100% recorte a mano', rate_es: '$75 / lb' },
    { k: 'machine_trim', l: 'Machine trim, 2 passes w/ hand finish', short: 'Machine trim', rate: '$65 / lb',
      es: 'Recorte a máquina, 2 pasadas con acabado a mano', rate_es: '$65 / lb' },
    { k: 'trim_smalls', l: 'Trim to smalls', short: 'Smalls', rate: '$35 / lb',
      es: 'Recorte a cogollos pequeños (smalls)', rate_es: '$35 / lb' },
    { k: 'batching', l: 'Batching, 1 lb turkey bags', short: 'Batching', rate: '$3 / bag + labor',
      es: 'Empaque por lotes, bolsas turkey de 1 lb', rate_es: '$3 / bolsa + mano de obra' }] },
  { group: 'Storage', group_es: 'Almacenamiento', items: [
    { k: 'dry_storage', l: 'Dry storage (on-stem)', short: 'Storage', rate: '$15 / box / mo, 30 days free',
      es: 'Almacenamiento seco (en tallo)', rate_es: '$15 / caja / mes, 30 días gratis' }] },
  { group: 'Transportation', group_es: 'Transporte', items: [
    { k: 'cargo_van', l: 'Cargo van', short: 'Van', rate: '$125 / hr',
      es: 'Camioneta de carga', rate_es: '$125 / hr' },
    { k: 'box_truck', l: '24′–26′ box truck w/ liftgate', short: 'Box truck', rate: '$175 / hr',
      es: 'Camión de caja de 24′–26′ con rampa elevadora', rate_es: '$175 / hr' },
    { k: 'reefer', l: '40′ reefer trailer', short: 'Reefer', rate: '$300 / hr',
      es: 'Remolque refrigerado de 40′', rate_es: '$300 / hr' }] },
  { group: 'Testing (pass-through)', group_es: 'Pruebas de laboratorio (costo directo)', items: [
    { k: 'rd_potency', l: 'R&D potency', short: 'Potency test', rate: '$100 / batch',
      es: 'Prueba de potencia (I+D)', rate_es: '$100 / lote' },
    { k: 'rd_full_panel', l: 'R&D full panel w/ terpenes', short: 'Full panel', rate: '$420 / batch',
      es: 'Panel completo con terpenos (I+D)', rate_es: '$420 / lote' }] }
];
