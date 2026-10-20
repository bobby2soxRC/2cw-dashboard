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
// received.
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

  const api = { ACCEPT_WITHIN_H, URGENT_H, pacificTime, incomingTransfers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MetrcTransfers = api;
})(this);
