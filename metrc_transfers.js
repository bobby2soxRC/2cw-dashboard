// Incoming Metrc transfers still waiting to be accepted at one of our
// licenses — the Metrc Queue's "Incoming transfers" section (metrc.html).
//
// The rule: receipt of cannabis has to be recorded in the track-and-trace
// system (Metrc) within 24 hours (4 CCR § 15049(b)). Canix doesn't give the
// arrival time, so the clock starts at the transfer's departure — arrival is
// always later, so this is the early (safe) deadline.
//
// Read from data/canix_transfers_recent.json (scripts/canix_sync.py, last 30
// days, every Canix sync): a transfer whose destination is one of our
// licenses (data/canix_facilities.json) with a package still "Shipped" (not
// Accepted / Rejected / Voided). Only transfers sent from a license we have
// Canix for show up — an outside farm's transfer isn't in Canix until it's
// received; those come from Wet Intake instead (unacceptedIntakes below).
//
// Tests: node scripts/test_metrc_transfers.js
(function (root) {
  const ACCEPT_WITHIN_H = 24;
  const URGENT_H = 8;   // this many hours or less left → urgent

  // Canix's departure_time is the Pacific wall-clock time with a "Z" on it
  // (Metrc shows "10:12 am" for "…T10:12:00.000Z"), so read the digits as
  // California time.
  function pacificTime(s) {
    const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)/.exec(String(s || ''));
    if (!m) return null;
    const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    // California's offset at about that moment (-7 or -8 hours), checked
    // again at the result so a time near the DST switch lands right.
    const offset = (ms) => {
      const p = {};
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - ms;
    };
    let ms = asUtc - offset(asUtc);
    ms = asUtc - offset(ms);
    return ms;
  }

  // One entry per transfer destination that's ours and still has a package
  // in transit, soonest deadline first.
  function incomingTransfers(transfers, facilities, now) {
    const ours = new Map((facilities || []).filter((f) => f && f.license_number).map((f) => [f.license_number, f.name || f.license_number]));
    const out = [];
    for (const t of transfers || []) {
      const manifest = String((t && t.manifest_number) || '').trim();
      if (!manifest) continue;   // not made in Metrc yet
      for (const d of t.destinations || []) {
        if (!ours.has(d.destination_facility)) continue;
        const contents = (d.contents || []).filter((c) => c && c.status !== 'Voided');
        const waiting = contents.filter((c) => c.status === 'Shipped');
        if (!waiting.length) continue;
        const left = pacificTime(d.departure_time);
        const due = left === null ? null : left + ACCEPT_WITHIN_H * 3600000;
        const hoursLeft = due === null ? null : (due - now) / 3600000;
        out.push({
          manifest,
          fromLicense: t._facility_license_number || '',
          fromName: t._facility_name || t._facility_license_number || '',
          toLicense: d.destination_facility,
          toName: ours.get(d.destination_facility),
          departure: left,
          due,
          hoursLeft,
          level: hoursLeft === null ? 'urgent' : hoursLeft < 0 ? 'overdue' : hoursLeft <= URGENT_H ? 'urgent' : 'ok',
          packages: waiting.length,
          tags: waiting.map((c) => (c.package || {}).tag).filter(Boolean),
          weightLb: waiting.reduce((s, c) => s + (String(c.shipped_weight_unit || 'Pounds').toLowerCase().startsWith('pound') ? Number(c.shipped_weight) || 0 : 0), 0)
        });
      }
    }
    return out.sort((a, b) => (a.due === null ? -Infinity : a.due) - (b.due === null ? -Infinity : b.due));
  }

  // Outside farms: their transfer isn't in Canix, and their package only
  // shows up in our Canix inventory once it's accepted. So a Wet Intake whose
  // scanned package is on none of our transfers and not in our inventory
  // was received on the floor but not accepted in Metrc yet — clock from
  // when the intake form was started (the truck's there). Only intakes from
  // the last INTAKE_DAYS: after a few days the wet package can go inactive
  // (taken down) and drop out of the inventory file.
  //
  // intakes: [{ id, startedAt (ms), uids: [...], manifest, farm, strain, lb }]
  const INTAKE_DAYS = 4;
  const normTag = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  function unacceptedIntakes(intakes, transfers, inventory, facilities, now) {
    const ours = new Set((facilities || []).map((f) => f && f.license_number).filter(Boolean));
    const known = [];   // tags on our transfers, and packages received at our licenses
    for (const t of transfers || []) for (const d of t.destinations || []) for (const c of d.contents || []) {
      const tag = normTag(((c || {}).package || {}).tag);
      if (tag) known.push(tag);
    }
    for (const p of inventory || []) if (p && ours.has(p._facility_license_number)) known.push(normTag(p.tag));
    const seen = (uid) => { const u = normTag(uid); return u.length >= 4 && known.some((k) => k === u || k.endsWith(u)); };
    const groups = new Map();
    for (const r of intakes || []) {
      if (!r.startedAt || now - r.startedAt > INTAKE_DAYS * 86400000) continue;
      const missing = (r.uids || []).filter((u) => normTag(u).length >= 4 && !seen(u));
      if (!missing.length) continue;
      // One row per manifest when it was typed in, else per intake form.
      const key = r.manifest ? `m:${r.manifest}` : `i:${r.id}`;
      const g = groups.get(key) || { manifest: r.manifest || '', fromLicense: r.farm || '', fromName: r.farm || '', toLicense: '', toName: '',
        intake: true, ids: [], startedAt: r.startedAt, tags: [], strains: [], weightLb: 0 };
      g.ids.push(r.id);
      g.startedAt = Math.min(g.startedAt, r.startedAt);
      missing.forEach((u) => { if (!g.tags.includes(normTag(u))) g.tags.push(normTag(u)); });   // a UID repeats on each bin row
      g.weightLb += Number(r.lb) || 0;
      if (r.strain && !g.strains.includes(r.strain)) g.strains.push(r.strain);
      if (!g.fromLicense && r.farm) g.fromLicense = g.fromName = r.farm;
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => {
      const due = g.startedAt + ACCEPT_WITHIN_H * 3600000, hoursLeft = (due - now) / 3600000;
      return { ...g, departure: g.startedAt, due, hoursLeft, packages: g.tags.length,
        level: hoursLeft < 0 ? 'overdue' : hoursLeft <= URGENT_H ? 'urgent' : 'ok' };
    }).sort((a, b) => a.due - b.due);
  }

  // ── Outgoing transfers with no Product Transfer — Outgoing form ──────────
  // A manifest made in Metrc from one of our licenses to someone else's,
  // carrying raw material (weighed in pounds or kilograms — pre-rolls and
  // finished goods go by the piece, lab samples by the gram), with no
  // submitted transfer_out form for it: the Metrc Queue lists it as "Needs
  // form", and its link opens the form filled in from the transfer.
  //
  // A form covers a transfer when its Manifest # matches, or any of its rows'
  // source / transfer package UIDs is one of the transfer's tags (a typed
  // UID can be just the end of the tag). Only manifests that left on or after
  // NEEDS_FORM_SINCE — the day the form went live — so older ones, done on
  // paper, don't flood the queue.
  //
  // forms:     [{ id, manifest, uids: [...] }]
  // inventory: Canix packages, for each tag's item and strain when the sync
  //            didn't put them on the transfer (_item / _strain).
  const NEEDS_FORM_SINCE = '2026-10-20';
  const LB_PER = { pounds: 1, pound: 1, lb: 1, lbs: 1, kilograms: 2.20462, kilogram: 2.20462, kg: 2.20462 };
  const toLb = (w, unit) => {
    const k = LB_PER[String(unit || '').trim().toLowerCase()];
    return k && Number.isFinite(Number(w)) ? Number(w) * k : null;
  };
  const normManifest = (v) => String(v || '').replace(/\D/g, '').replace(/^0+/, '');
  // Canix item name → Product Transfer type code (TRANSFER_TYPES in
  // operations_stations.js). Most specific first: "Cured - Whole Plant - …
  // Flower" is unbucked, "Flower | Smalls | OG" is smalls.
  function productTypeOf(name) {
    const s = String(name || '').toLowerCase();
    if (!s) return '';
    if (/fresh\s*frozen|\bff\b/.test(s)) return '6';
    if (/pre-?\s?roll/.test(s)) return '8';
    if (/seed/.test(s)) return '7';
    if (/whole\s*plant|wet|unbucked|on[\s-]?stem/.test(s)) return '1';
    if (/bucked/.test(s)) return '2';
    if (/trim|biomass|shake|sugar/.test(s)) return '5';
    if (/small|\bb[\s-]?bud/.test(s)) return '4';
    if (/flower|bud/.test(s)) return '3';
    return '';
  }
  // A transfer's departure as the California calendar day, YYYY-MM-DD.
  const pacificDay = (s) => (/^(\d{4}-\d\d-\d\d)/.exec(String(s || '')) || [])[1] || '';

  function outgoingNeedingForm(transfers, facilities, forms, inventory, since = NEEDS_FORM_SINCE) {
    const ours = new Set((facilities || []).map((f) => f && f.license_number).filter(Boolean));
    const invByTag = new Map((inventory || []).filter((p) => p && p.tag).map((p) => [normTag(p.tag), p]));
    const formManifests = new Set(), formUids = [];
    for (const f of forms || []) {
      const m = normManifest(f.manifest);
      if (m) formManifests.add(m);
      for (const u of f.uids || []) { const n = normTag(u); if (n.length >= 6) formUids.push(n); }
    }
    const covered = (tag) => formUids.some((u) => u === tag || tag.endsWith(u));
    const out = [];
    for (const t of transfers || []) {
      const manifest = String((t && t.manifest_number) || '').trim();
      if (!manifest || !ours.has(t._facility_license_number)) continue;
      for (const d of t.destinations || []) {
        if (!d || ours.has(d.destination_facility)) continue;   // between our own licenses
        const day = pacificDay(d.departure_time);
        if (since && (!day || day < since)) continue;
        const live = (d.contents || []).filter((c) => c && c.status !== 'Voided');
        const raw = live.filter((c) => toLb(c.shipped_weight, c.shipped_weight_unit) !== null);
        if (!raw.length) continue;
        if (formManifests.has(normManifest(manifest))) continue;
        const tags = live.map((c) => normTag((c.package || {}).tag)).filter(Boolean);
        if (tags.some(covered)) continue;
        const packages = raw.map((c) => {
          const tag = String((c.package || {}).tag || '');
          const item = ((invByTag.get(normTag(tag)) || {}).item) || {};
          const name = c._item || item.name || '';
          return {
            tag,
            lb: Math.round(toLb(c.shipped_weight, c.shipped_weight_unit) * 100) / 100,
            item: name,
            strain: c._strain || (item.strain || {}).name || '',
            productType: productTypeOf(name)
          };
        });
        out.push({
          manifest,
          fromLicense: t._facility_license_number || '',
          fromName: t._facility_name || t._facility_license_number || '',
          toLicense: d.destination_facility || '',
          departure: pacificTime(d.departure_time),
          date: day,
          salesOrderNo: t._sales_order_no || '',
          customer: t._customer_name || '',
          accepted: live.every((c) => c.status === 'Accepted'),
          packages,
          tags: packages.map((p) => p.tag),
          strains: [...new Set(packages.map((p) => p.strain).filter(Boolean))],
          weightLb: Math.round(packages.reduce((s, p) => s + p.lb, 0) * 100) / 100
        });
      }
    }
    return out.sort((a, b) => (a.departure || 0) - (b.departure || 0));
  }

  const api = { ACCEPT_WITHIN_H, URGENT_H, INTAKE_DAYS, NEEDS_FORM_SINCE, pacificTime, incomingTransfers, unacceptedIntakes, productTypeOf, outgoingNeedingForm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MetrcTransfers = api;
})(this);
