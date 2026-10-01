// Post-harvest services and rates from the 2026 pricing sheet, shared by the
// Drying Schedule (drying_schedule.html) and the client request form
// (drying_request.html). The keys are what's stored in
// drying_intakes.services — add new ones freely, but don't rename a key once
// clients have it saved, and add any new key to ALLOWED_SERVICES in
// netlify/functions/drying-request.js too.
const DRYING_SERVICES = [
  { group: 'Drying', items: [
    { k: 'drying', l: 'Drying', short: 'Drying', rate: '$3.00 / wet lb' }] },
  { group: 'Harvest labor', items: [
    { k: 'farm_labor', l: 'Farm labor / farm support', short: 'Farm support', rate: '$25 / hr / person' }] },
  { group: 'Trimming & processing', items: [
    { k: 'hand_bucking', l: 'Hand bucking', short: 'Bucking', rate: '$7 / lb' },
    { k: 'hand_trim', l: '100% hand trim', short: 'Hand trim', rate: '$75 / lb' },
    { k: 'machine_trim', l: 'Machine trim, 2 passes w/ hand finish', short: 'Machine trim', rate: '$65 / lb' },
    { k: 'trim_smalls', l: 'Trim to smalls', short: 'Smalls', rate: '$35 / lb' },
    { k: 'batching', l: 'Batching, 1 lb turkey bags', short: 'Batching', rate: '$3 / bag + labor' }] },
  { group: 'Storage', items: [
    { k: 'dry_storage', l: 'Dry storage (on-stem)', short: 'Storage', rate: '$15 / box / mo, 30 days free' }] },
  { group: 'Transportation', items: [
    { k: 'cargo_van', l: 'Cargo van', short: 'Van', rate: '$125 / hr' },
    { k: 'box_truck', l: '24′–26′ box truck w/ liftgate', short: 'Box truck', rate: '$175 / hr' },
    { k: 'reefer', l: '40′ reefer trailer', short: 'Reefer', rate: '$300 / hr' }] },
  { group: 'Testing (pass-through)', items: [
    { k: 'rd_potency', l: 'R&D potency', short: 'Potency test', rate: '$100 / batch' },
    { k: 'rd_full_panel', l: 'R&D full panel w/ terpenes', short: 'Full panel', rate: '$420 / batch' }] }
];
