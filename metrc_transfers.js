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

  const api = { ACCEPT_WITHIN_H, URGENT_H, INTAKE_DAYS, pacificTime, incomingTransfers, unacceptedIntakes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MetrcTransfers = api;
})(this);
