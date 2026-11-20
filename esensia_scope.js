// Esensia partner scope. Ben's strains only — the list Robert's Nov 20, 2026
// yield report used. The dashboard page never reads Canix itself;
// netlify/functions/esensia-inventory.js runs buildView and returns this
// object, so other strains, costs, and customers are not in the response.
//
// A package is included when its Canix strain is one of these names, or when
// the strain is blank and the item name is one of them (Shake - SWD).
// San #10 / SAN#10 are one strain. MW is Magic Wand. Grapes & Cream and
// Grapes and Cream are one strain. Similar names are not (LSK, Marilyn
// Monroe, a strain field of GC, Grape Gas). Pre-rolls, pouches, and other
// packaged retail are left out — those are another brand's finished goods.
//
// Plant counts come from a Canix harvest whose name matches the package's
// source harvest exactly. The count is the harvest batch, not the pounds
// left in the package. A harvest whose own strain is a different one (Grape
// Gas on a BBJ package) is shown on the row and left out of the strain total.
// Several source harvests on one package get no plant count.
//
// Finished flower already packaged is ACTUAL. estimatedAdditionalFlowerLb is
// only set from a yield model the caller passes in, and it is never written
// into the package weight.
(function (root) {
  const STRAINS = [
    { key: 'BBJ', label: 'BBJ', code: 'BBJ', aliases: ['BBJ', 'Blueberry Jam'] },
    { key: 'EBD', label: 'EBD', code: 'EBD', aliases: ['EBD'] },
    { key: 'GRAPES', label: 'Grapes & Cream', code: 'GRAPES', aliases: ['Grapes & Cream', 'Grapes and Cream'] },
    { key: 'LJ', label: 'LJ', code: 'LJ', aliases: ['LJ', 'Lime Juice'] },
    { key: 'LS', label: 'LS', code: 'LS', aliases: ['LS'] },
    { key: 'MW', label: 'Magic Wand', code: 'MW', aliases: ['Magic Wand', 'MW'] },
    { key: 'PDST', label: 'PDST', code: 'PDST', aliases: ['PDST'] },
    { key: 'SAN10', label: 'SAN #10', code: 'SAN#10', aliases: ['SAN #10', 'San #10', 'SAN#10', 'SAN 10'] },
    { key: 'SWD', label: 'SWD', code: 'SWD', aliases: ['SWD'] },
    { key: 'OC', label: 'OC', code: 'OC', aliases: ['OC'] },
    { key: 'STJ', label: 'STJ', code: 'STJ', aliases: ['STJ'] },
    { key: 'MAR', label: 'MAR', code: 'MAR', aliases: ['MAR'] },
    { key: 'RSP', label: 'RSP', code: 'RSP', aliases: ['RSP'] }
  ];
  const BY_KEY = Object.fromEntries(STRAINS.map((s) => [s.key, s]));
  const ALIAS = new Map();
  STRAINS.forEach((s) => s.aliases.forEach((a) => { const n = norm(a); if (n && !ALIAS.has(n)) ALIAS.set(n, s.key); }));

  const STAGE_ORDER = ['wet', 'fresh frozen', 'on stem', 'whole plant', 'bucked', 'flower', 'smalls', 'trim', 'shake', 'biomass', 'other'];
  const UNFINISHED = new Set(['wet', 'fresh frozen', 'on stem', 'whole plant', 'bucked']);
  const ORDERABLE = new Set(['flower', 'smalls', 'trim']);
  const OWN_FARMS = ['comstock', 'sulphur bank', 'lucern', 'wildcat', 'highland springs'];

  function norm(s) {
    return String(s || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9#]+/g, '').replace(/#+/g, '#');
  }
  function round2(n) { return Math.round(n * 100) / 100; }

  function packageStrainKey(strainName) {
    return ALIAS.get(norm(strainName)) || null;
  }

  // Blank strain only. "Shake - SWD" counts; "Fresh Frozen - BBJ" does not
  // when a different strain is already set on the package.
  function blankItemKey(itemName) {
    const parts = String(itemName || '').split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean).reverse();
    for (let i = 0; i < parts.length; i++) {
      const key = ALIAS.get(norm(parts[i]));
      if (key) return key;
    }
    return null;
  }

  function harvestMatches(key, harvestStrain) {
    const strain = BY_KEY[key];
    const n = norm(harvestStrain);
    if (!strain || !n) return false;
    if (ALIAS.get(n) === key) return true;
    const code = strain.code;
    if (code && /^[A-Z]{2,4}$/.test(code) && n.startsWith(code) && /\d/.test(n.charAt(code.length) || '')) return true;
    if (key === 'SAN10' && /^SAN#?\d/.test(n)) return true;
    return false;
  }

  function isRetail(itemName, typeName) {
    const blob = `${typeName || ''} ${itemName || ''}`.toLowerCase();
    if (/pre-?roll|vape|cartridge|pouch|seed|clone/.test(blob)) return true;
    if (/packaged/.test(blob)) return true;
    if (/\b(?:eighth|3\.5\s?g|14\s?g|1\s?g|0\.5\s?g|half ounce)\b/.test(blob)) return true;
    return false;
  }

  function stageOf(itemName, typeName) {
    const n = String(itemName || '').toLowerCase();
    const t = String(typeName || '').toLowerCase();
    if (/fresh frozen/.test(n) || /fresh frozen/.test(t)) return { stage: 'fresh frozen', detail: '' };
    if (/^wet\b/.test(n) || /fresh cannabis/.test(t)) return { stage: 'wet', detail: '' };
    if (/whole plant/.test(n)) return { stage: 'whole plant', detail: /cured/.test(n) ? 'cured' : '' };
    if (/unbucked/.test(n)) return { stage: 'on stem', detail: 'unbucked' };
    if (/^dry flower\b/.test(n) || /^dry\b/.test(n)) return { stage: 'on stem', detail: 'dry' };
    if (/^bucked\b/.test(n)) return { stage: 'bucked', detail: '' };
    if (/unfinished smalls/.test(n)) return { stage: 'smalls', detail: 'unfinished' };
    if (/^smalls\b/.test(n)) return { stage: 'smalls', detail: '' };
    if (/^shake\b/.test(n) || t === 'shake') return { stage: 'shake', detail: '' };
    if (/^trim\b/.test(n) || /\btrim\b/.test(n)) return { stage: 'trim', detail: '' };
    if (/^biomass\b/.test(n)) return { stage: 'biomass', detail: '' };
    if (/^men flower\b/.test(n) || /^flower\b/.test(n) || t === 'flower') return { stage: 'flower', detail: '' };
    return { stage: 'other', detail: '' };
  }

  function stageLabel(stage, detail) {
    if (stage === 'on stem' && detail === 'dry') return 'On stem (dry)';
    if (stage === 'on stem' && detail === 'unbucked') return 'On stem (unbucked)';
    if (stage === 'smalls' && detail === 'unfinished') return 'Smalls (unfinished)';
    if (stage === 'whole plant' && detail === 'cured') return 'Whole plant (cured)';
    if (stage === 'fresh frozen') return 'Fresh frozen';
    return stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : 'Other';
  }

  function toLb(weight, unit) {
    const n = Number(weight);
    if (!Number.isFinite(n) || n <= 0) return null;
    const u = String(unit || 'Pounds').toLowerCase();
    if (u.startsWith('pound') || u === 'lb' || u === 'lbs') return n;
    if (u.startsWith('gram')) return n / 453.592;
    if (u.startsWith('kilo')) return n * 2.20462;
    if (u.startsWith('ounce')) return n / 16;
    return null;
  }

  function sourceNames(raw) {
    if (Array.isArray(raw)) {
      return raw.map((x) => (typeof x === 'string' ? x : (x && (x.name || x.harvest_name)) || '')).map((s) => String(s).trim()).filter(Boolean);
    }
    return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  function indexHarvests(harvests) {
    const map = new Map();
    (harvests || []).forEach((h) => {
      const name = String(h && h.name || '').trim();
      if (!name) return;
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(h);
    });
    return map;
  }

  function pidFromName(name) {
    const m = String(name || '').toUpperCase().match(/^(?:AGP|WC|LUC)(\d{3,4})/);
    return m ? m[1].slice(-3) : null;
  }

  function ownFarm(name) {
    const n = String(name || '').toLowerCase();
    return OWN_FARMS.some((k) => n.startsWith(k));
  }

  function farmFromHarvest(h, properties) {
    const head = String(h && h._facility_name || '').split(':')[0].trim();
    if (head && !/^C(?:CL|11|12)/i.test(head)) return ownFarm(head) ? `${head} (2CW)` : `${head} (outside farm)`;
    const pid = pidFromName(h && h.name);
    const prop = pid && (properties || []).find((p) => String(p.pid) === pid);
    if (prop && prop.farm) return ownFarm(prop.farm) ? `${prop.farm} (2CW)` : `${prop.farm} (outside farm)`;
    return null;
  }

  function farmFromItem(itemName) {
    if (/mendogrown/i.test(itemName || '')) return 'Mendogrown (outside farm)';
    return null;
  }

  function heldAt(pkg, facilities) {
    const fc = facilities && facilities[String(pkg.facility_id)];
    if (fc && (fc.exclude || fc.status === 'archived')) return { skip: true };
    const lic = pkg._facility_license_number || (fc && fc.license_number) || '';
    const place = (fc && (fc.display_name || fc.farm_group)) || '';
    const label = [place, lic].filter(Boolean).join(' · ');
    return { skip: false, label: label || null };
  }

  function yieldApi() {
    if (root.FlowerYield) return root.FlowerYield;
    if (typeof require === 'function') {
      try { return require('./flower_yield.js'); } catch (e) { return null; }
    }
    return null;
  }

  function yieldStrains() {
    return STRAINS.map((s) => ({ name: s.label, aliases: s.aliases.filter((a) => norm(a) !== norm(s.label)) }));
  }

  function basisText(bits) {
    const label = { dry: 'dry-down', buck: 'buck', trim: 'trim', strain: 'this strain’s forms', all: 'the all-strain average', batch: 'this lot’s forms' };
    const seen = [];
    bits.forEach((b) => { if (seen.indexOf(b) === -1) seen.push(b); });
    if (!seen.length) return '';
    return seen.map((b) => {
      const [stage, basis] = b.split(':');
      return `${label[stage] || stage}: ${label[basis] || basis}`;
    }).join('; ');
  }

  function applyEstimates(view, model) {
    const Y = yieldApi();
    const usable = !!(model && Y && (model.dry.allLots || model.buck.allLots || model.trim.allLots));
    let total = 0;
    let any = false;
    view.strains.forEach((s) => {
      const unfinished = s.packages.filter((p) => UNFINISHED.has(p.stage) && p.lb > 0);
      if (!unfinished.length) {
        s.estimatedAdditionalFlowerLb = null;
        s.estimateNote = 'No unfinished material on hand. Finished flower is ACTUAL weight only.';
        return;
      }
      if (!usable) {
        s.estimatedAdditionalFlowerLb = null;
        s.estimateNote = 'ESTIMATED finished flower is not available. The pounds in the table are ACTUAL Canix weights.';
        return;
      }
      let est = 0;
      const bits = [];
      unfinished.forEach((p) => {
        const stage = (p.stage === 'wet' || p.stage === 'fresh frozen') ? 'drying' : (p.stage === 'bucked' ? 'bucked' : 'onstem');
        const e = Y.estimate(model, { stage, strain: s.label, lb: p.lb });
        if (e.steps.some((st) => st.basis === 'default')) return;
        est += e.lb;
        e.steps.forEach((st) => bits.push(`${st.stage}:${st.basis}`));
      });
      s.estimatedAdditionalFlowerLb = round2(est);
      s.estimateNote = 'ESTIMATED additional finished flower from unfinished packages still on hand. Not a weighed total.'
        + (bits.length ? ` ${basisText(bits)}.` : '');
      total += est;
      any = true;
    });
    view.estimatedAdditionalFlowerLb = any ? round2(total) : null;
  }

  function buildView({ packages, harvests, facilities, properties, asOf, yieldModel }) {
    const byName = indexHarvests(harvests);
    const grouped = Object.fromEntries(STRAINS.map((s) => [s.key, []]));

    (packages || []).forEach((pkg) => {
      if (!pkg || pkg.is_active === false || pkg.is_testing_package) return;
      const item = pkg.item || {};
      const typeName = (item.type && item.type.name) || '';
      if (/^waste$/i.test(typeName)) return;
      if (isRetail(item.name, typeName)) return;
      const where = heldAt(pkg, facilities);
      if (where.skip) return;
      const named = item.strain && item.strain.name;
      const key = named ? packageStrainKey(named) : blankItemKey(item.name);
      if (!key) return;
      const lb = toLb(pkg.weight, pkg.weight_unit);
      if (lb == null) return;
      const st = stageOf(item.name, typeName);
      const names = sourceNames(pkg.source_harvests);
      let farm = null;
      let plantCount = null;
      let plantsCounted = false;
      let harvestDate = null;
      let sourceHarvest = null;
      let plantNote = null;
      const mixed = names.length > 1;
      if (mixed) {
        plantNote = 'Several source harvests. Plant count is not assigned, and this package may include other batches.';
      } else if (names.length === 1) {
        sourceHarvest = names[0];
        const hits = byName.get(names[0]) || [];
        if (hits.length === 1) {
          const h = hits[0];
          farm = farmFromHarvest(h, properties);
          plantCount = Number(h.plant_count) > 0 ? Number(h.plant_count) : null;
          harvestDate = h.harvest_date ? String(h.harvest_date).slice(0, 10) : null;
          plantsCounted = harvestMatches(key, (h.strain && h.strain.name) || '');
          if (plantCount && !plantsCounted) {
            plantNote = 'This harvest’s Canix strain does not match the package, so its plants are not in the strain total.';
          }
        } else if (hits.length > 1) {
          plantNote = 'More than one Canix harvest uses this name, so no plant count is assigned.';
        }
      }
      if (!farm) farm = farmFromItem(item.name);
      grouped[key].push({
        tag: String(pkg.tag || ''),
        item: String(item.name || ''),
        stage: st.stage,
        detail: st.detail,
        stageLabel: stageLabel(st.stage, st.detail),
        status: String(pkg.status || ''),
        lb: round2(lb),
        heldAt: where.label,
        farm,
        plantCount,
        plantsCounted: !!(plantCount && plantsCounted),
        harvestDate,
        sourceHarvest,
        mixedHarvests: mixed,
        plantNote,
        orderable: ORDERABLE.has(st.stage)
      });
    });

    const strains = STRAINS.map((s) => {
      const rows = grouped[s.key].slice().sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || a.tag.localeCompare(b.tag));
      const byStage = {};
      let lb = 0;
      rows.forEach((r) => {
        byStage[r.stage] = round2((byStage[r.stage] || 0) + r.lb);
        lb += r.lb;
      });
      const sumStage = (stage) => round2(rows.filter((r) => r.stage === stage).reduce((a, r) => a + r.lb, 0));
      const counted = new Map();
      rows.forEach((r) => {
        if (r.plantsCounted && r.sourceHarvest && !counted.has(r.sourceHarvest)) counted.set(r.sourceHarvest, r.plantCount);
      });
      let plants = 0;
      counted.forEach((n) => { plants += n; });
      const farms = [];
      rows.forEach((r) => { if (r.farm && farms.indexOf(r.farm) === -1) farms.push(r.farm); });
      return {
        key: s.key,
        label: s.label,
        packages: rows,
        packageCount: rows.length,
        lb: round2(lb),
        byStage,
        actualFlowerLb: sumStage('flower'),
        actualSmallsLb: sumStage('smalls'),
        actualTrimLb: sumStage('trim'),
        actualShakeLb: sumStage('shake'),
        plantCount: plants || null,
        farms,
        estimatedAdditionalFlowerLb: null,
        estimateNote: null
      };
    });

    const view = {
      asOf: asOf || null,
      strains,
      actualFlowerLb: round2(strains.reduce((a, s) => a + s.actualFlowerLb, 0)),
      actualSmallsLb: round2(strains.reduce((a, s) => a + s.actualSmallsLb, 0)),
      actualTrimLb: round2(strains.reduce((a, s) => a + s.actualTrimLb, 0)),
      packageCount: strains.reduce((a, s) => a + s.packageCount, 0),
      lb: round2(strains.reduce((a, s) => a + s.lb, 0)),
      estimatedAdditionalFlowerLb: null,
      disclaimer: 'Finished flower on hand is ACTUAL — the Canix weight. Any additional finished flower is ESTIMATED from unfinished packages and is not a weighed total. Plant counts are the harvest batch, not the pounds left in the package.'
    };
    applyEstimates(view, yieldModel || null);
    return view;
  }

  const api = {
    STRAINS, STAGE_ORDER, norm, packageStrainKey, blankItemKey, harvestMatches,
    isRetail, stageOf, stageLabel, toLb, buildView, yieldStrains
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EsensiaScope = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
