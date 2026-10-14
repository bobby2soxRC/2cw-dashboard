// Invoice request for services — 2CW Operations asking 2CW Finance to invoice
// a customer for work already done, the way the drying deposit request
// (MSA.openInvoice in msa_agreement.js) asks for the deposit. Opened from the
// Customer IDs tab (information_hub.html) with InvoiceServices.open({ cid }).
//
// Pick the customer, then a process; the work done for that customer at that
// process is listed to tick onto the request:
//   Drying        Wet Intake records with the customer's CID (net wet lbs)
//   Bucking       bucked lots, CID traced back through Take Down to Wet Intake
//   Machine/Hand  trim records, CID from the record or traced by UID
//   Transport     Labor Log hours (process 'transport') on the customer's
//                 Master Schedule projects, UIDs or farm licenses — or not
//                 tied to anything but logged on a day one of their harvest
//                 projects ran
//   Farm labor    Labor Log hours at Harvest / Wet Intake / Take Down / Other,
//                 tied to the customer the same way
//   Other         any service from the price list (storage, batching,
//                 testing …) or a blank line, typed in
// Each line starts at the customer's contract rate and can be changed, and
// the request can take a discount (% or $); any rate under contract or a
// discount needs a reason, which prints on the PDF.
//
// A project belongs to a customer through its Customer (CID) field
// (master_schedule.html), or else through the CIDs its UIDs trace back to.
// A farm license (pid) belongs to whichever customers' Wet Intakes used it.
//
// Saved requests are operations_forms rows (station_key 'invoice_request'),
// so what's on one shows as invoiced (red ✓) next time; voiding a request
// frees its items again. Contract rates per customer are rows with
// station_key 'customer_rates' ({ cid, rates: { service key: $ }, source }),
// written when a Service Agreement PDF is made from the customer's
// Documents sheet, or edited in this dialog; without one the standard rates
// (Exhibit B defaults, EXB in msa_agreement.js) apply. Both use the open
// anon access operations_forms already has; the history trigger logs edits.
(function () {
  const M = window.MSA;
  const REQ_KEY = 'invoice_request', RATES_KEY = 'customer_rates';
  const PROCESSES = [
    { k: 'drying', l: 'Drying — wet intake weights', service: 'drying' },
    { k: 'buck', l: 'Bucking — bucked lots', service: 'hand_bucking' },
    { k: 'machine_trim', l: 'Machine trim', service: 'machine_trim' },
    { k: 'hand_trim', l: 'Hand trim', service: 'hand_trim' },
    { k: 'transport', l: 'Transport — Labor Log hours', service: 'box_truck' },
    { k: 'farm_labor', l: 'Farm labor — Labor Log hours', service: 'farm_labor' },
    { k: 'other', l: 'Other services / custom line' }
  ];
  // Labor Log processes billed at the Farm Labor rate (MSA 3.C.a: hanging,
  // moving and taking down plants are pass-through labor).
  const FARM_LABOR_PROCS = ['harvest', 'intake_wet', 'dry_check', 'other'];
  const VEHICLES = ['box_truck', 'cargo_van', 'reefer'];
  // The box truck's 8-hour booking rate lives in the agreement's notes.
  const BOX8 = 'box_truck_8h';
  const RATE_KEYS = () => [...Object.keys(M.EXB).flatMap((k) => (k === 'box_truck' ? [k, BOX8] : [k]))];
  const rateLabel = (k) => (k === BOX8 ? 'Box truck — 8+ hour booking' : M.serviceLabel(k));
  const standardRates = () => {
    const r = {};
    Object.entries(M.EXB).forEach(([k, x]) => { r[k] = M.parseNum(x.rate); });
    const m = String(M.EXB.box_truck.notes || '').match(/\$([\d,.]+)/);
    r[BOX8] = m ? M.parseNum(m[1]) : r.box_truck;
    return r;
  };
  // Exhibit B lines (the Service Agreement dialog's) → { service key: $ }.
  function ratesFromLines(lines) {
    const out = {};
    (lines || []).forEach((l) => {
      const k = l.k || Object.keys(M.EXB).find((x) => M.serviceLabel(x) === l.label);
      const v = M.parseNum(l.rate);
      if (!k || v == null) return;
      out[k] = v;
      const m = k === 'box_truck' && String(l.notes || '').match(/\$([\d,.]+)\s*\/\s*hr/i);
      if (m) out[BOX8] = M.parseNum(m[1]);
    });
    return out;
  }

  const esc = M.esc;
  const num = (x) => { const n = Number(String(x == null ? '' : x).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
  const r2 = (x) => Math.round(x * 100) / 100;
  const money = (x) => (x < 0 ? '-' : '') + M.money(Math.abs(r2(x)));
  const fmtN = (x) => Number(x || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const short = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || '') ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  const tail = (u) => String(u || '').slice(-5);
  const me = () => { try { return (sessionStorage.getItem('2cw_user_name') || '').trim(); } catch (e) { return ''; } };
  const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  // ── Data ───────────────────────────────────────────────────────────────
  async function rowsOf(client, station, narrow) {
    const out = [];
    for (let page = 0; page < 20; page++) {
      let q = client.from('operations_forms').select('*').eq('station_key', station).eq('status', 'submitted');
      if (narrow) q = narrow(q);
      const { data, error } = await q.order('work_date', { ascending: false }).range(page * 1000, page * 1000 + 999);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return out;
  }

  async function loadAll(client) {
    const procs = ['transport', ...FARM_LABOR_PROCS];
    const [intakes, downs, bucks, mtrims, htrims, projects, labor, reqs, rates, codes, dry] = await Promise.all([
      loadSubmitted('intake_wet'), loadSubmitted('dry_check'), loadSubmitted('buck'), loadSubmitted('machine_trim'), loadSubmitted('hand_trim'),
      rowsOf(client, 'work_project'), rowsOf(client, 'labor_entry', (q) => q.in('fields->>process', procs)),
      rowsOf(client, REQ_KEY), rowsOf(client, RATES_KEY),
      client.from('ref_codes').select('*').eq('kind', 'cid').order('code').then((r) => r.data || []),
      client.from('drying_intakes').select('*').order('created_at', { ascending: false }).limit(300).then((r) => r.data || [])
    ]);
    return { intakes: intakes || [], downs: downs || [], bucks: bucks || [], mtrims: mtrims || [], htrims: htrims || [],
      projects: projects.filter((p) => !(p.fields || {}).voided).map(flattenRecord), labor: labor.map(flattenRecord),
      reqs, rates, codes, dry };
  }

  // Which customer(s) a UID, a farm license, a project or a labor entry
  // belongs to.
  function makeTracer(D) {
    const intakeCid = (uid) => { const i = D.intakes.find((x) => uidTailMatch(x.sourceUid, uid)); return (i && i.cid) || ''; };
    const uidCache = new Map();
    const cidForUid = (uid) => {
      const u = normUid(uid);
      if (u.length < 4) return '';
      if (uidCache.has(u)) return uidCache.get(u);
      let c = intakeCid(u);
      if (!c) {
        // Take Down's on-stem UID, or a part released off one.
        const d = D.downs.find((x) => uidTailMatch(x.sourceUid, u) || (x.releases || []).some((r) => uidTailMatch(r.uid, u)));
        c = d ? (d.cid || intakeCid(d.incomingUid) || '') : '';
      }
      uidCache.set(u, c);
      return c;
    };
    const pidCids = new Map();
    D.intakes.forEach((i) => { if (i.pid && i.cid) (pidCids.get(i.pid) || pidCids.set(i.pid, new Set()).get(i.pid)).add(i.cid); });
    const projCids = (p) => {
      if (!p) return new Set();
      if (p.cid) return new Set([p.cid]);
      return new Set((p.uids || []).map((u) => cidForUid(u.uid)).filter(Boolean));
    };
    const projById = new Map(D.projects.map((p) => [p.id, p]));
    const entryCids = (e) => {
      const s = new Set();
      (e.uids || []).forEach((u) => { const c = cidForUid(u.uid); if (c) s.add(c); });
      if (e.project) projCids(projById.get(e.project)).forEach((c) => s.add(c));
      [...(e.farms || []), ...(e.farm ? [e.farm] : [])].forEach((p) => (pidCids.get(p) || []).forEach((c) => s.add(c)));
      return s;
    };
    return { cidForUid, projCids, entryCids, projById };
  }

  // What each saved (not voided) request already covers: item key → request.
  function invoicedMap(reqs) {
    const m = new Map();
    reqs.forEach((r) => {
      const f = r.fields || {};
      if (f.voided) return;
      (f.lines || []).forEach((l) => (l.ids || []).forEach((id) => m.set(id, { number: f.number, date: r.work_date })));
    });
    return m;
  }

  // ── The work done for one customer at one process ──────────────────────
  // Items: { key, ids, date, label, sub, qty, unit, service, desc, detail,
  // invoiced?: {number, date}, note? }. `ids` are what a saved request
  // records, so a lot or labor entry is never on two live requests.
  function itemsFor(D, T, inv, cid, proc, showUnmatched) {
    const mark = (it) => {
      const done = it.ids.filter((id) => inv.has(id));
      if (done.length && done.length === it.ids.length) it.invoiced = inv.get(done[0]);
      return it;
    };
    const lot = (r, prefix) => [short(r.date), r.strain, r.sourceUid && `…${tail(r.sourceUid)}`].filter(Boolean).join(' · ');
    if (proc === 'drying') {
      return D.intakes.filter((r) => r.cid === cid && !isFreshFrozen(r)).map((r) => mark({
        key: 'intake:' + r.id, ids: ['intake:' + r.id], date: r.date, service: 'drying', unit: 'wet lb', qty: r2(num(r.totalWetLb)),
        label: lot(r), sub: `${fmtN(r.totalWetLb)} lbs wet, net of tare${r.manifestNo ? ` · manifest ${r.manifestNo}` : ''}`,
        desc: `Drying — ${r.strain || 'intake'} (UID …${tail(r.sourceUid)})`, detail: `Wet intake ${short(r.date)}${r.manifestNo ? `, manifest ${r.manifestNo}` : ''}`
      }));
    }
    if (proc === 'buck') {
      return buckedLots(D.bucks, D.downs, D.intakes, []).filter((r) => r.cid === cid).map((r) => mark({
        key: 'buck:' + r.id, ids: ['buck:' + r.id], date: r.date, service: 'hand_bucking', unit: 'lb', qty: r2(num(r.startingDryLb)),
        label: lot(r), sub: `${fmtN(r.startingDryLb)} lbs dry bucked → ${fmtN(r.buckedFlowerLb)} lbs bucked flower`,
        desc: `Hand bucking — ${r.strain || 'lot'} (UID …${tail(r.sourceUid)})`, detail: `${fmtN(r.startingDryLb)} lbs dry in, ${fmtN(r.buckedFlowerLb)} lbs bucked flower out`
      }));
    }
    if (proc === 'machine_trim' || proc === 'hand_trim') {
      const hand = proc === 'hand_trim';
      return (hand ? D.htrims : D.mtrims).filter((r) => (r.cid || T.cidForUid(r.sourceUid)) === cid).map((r) => {
        const inLb = hand ? r.startingBuckedLb : r.inputBuckedLb, outLb = hand ? r.finishedFlowerLb : r.flowerALb;
        return mark({
          key: `${proc}:${r.id}`, ids: [`${proc}:${r.id}`], date: r.date, service: proc, unit: 'lb', qty: r2(num(inLb)),
          label: lot(r), sub: `${fmtN(inLb)} lbs bucked in → ${fmtN(outLb)} lbs ${hand ? 'finished' : 'A-bud'} flower`,
          desc: `${hand ? 'Hand trim' : 'Machine trim'} — ${r.strain || 'lot'} (UID …${tail(r.sourceUid)})`,
          detail: `${fmtN(inLb)} lbs bucked in, ${fmtN(outLb)} lbs ${hand ? 'finished' : 'A-bud'} flower out`
        });
      });
    }
    if (proc === 'transport' || proc === 'farm_labor') {
      const ok = proc === 'transport' ? (p) => p === 'transport' : (p) => FARM_LABOR_PROCS.includes(p);
      const mine = D.projects.filter((p) => T.projCids(p).has(cid));
      const groups = new Map();
      D.labor.forEach((e) => {
        if (!ok(e.process) || !(num(e.hours) > 0)) return;
        const cids = T.entryCids(e);
        let note = '';
        if (cids.size) {
          if (!cids.has(cid)) return;
          if (cids.size > 1) note = `Also tied to CID ${[...cids].filter((c) => c !== cid).join(', ')}`;
        } else {
          // Not tied to anything — offered when one of the customer's
          // projects ran that day (a driver logging plain "Transport").
          const p = mine.find((x) => projectRunsOn({ ...x, status: 'active' }, e.date));
          if (p) note = `Not logged to a project — same day as “${p.name}”`;
          else if (showUnmatched) note = 'Not tied to any customer';
          else return;
        }
        const gk = [e.date, e.project || '', proc === 'farm_labor' ? e.process : '', note ? 'x' : ''].join('|');
        if (!groups.has(gk)) groups.set(gk, { gk, date: e.date, project: e.project, process: e.process, note, entries: [] });
        groups.get(gk).entries.push(e);
      });
      return [...groups.values()].map((g) => {
        const fresh = g.entries.filter((e) => !inv.has('labor:' + e.id));
        const use = fresh.length ? fresh : g.entries;
        const byPerson = new Map();
        use.forEach((e) => { const n = e.employeeName || e.employeeId || '?'; byPerson.set(n, (byPerson.get(n) || 0) + num(e.hours)); });
        const people = [...byPerson.entries()].map(([n, h]) => `${n} ${fmtN(r2(h))} h`).join(', ');
        const proj = g.project && T.projById.get(g.project);
        const where = proj ? proj.name : (use[0].projectName || use[0].farmName || (use[0].uids || []).map((u) => '…' + tail(u.uid)).join(' ') || '');
        const ptitle = t(processTitle(g.process));
        // A truck runs once however many ride in it: transport bills the
        // longest anyone logged that day; farm labor bills every person-hour.
        const qty = proc === 'transport' ? r2(Math.max(...byPerson.values())) : r2([...byPerson.values()].reduce((a, h) => a + h, 0));
        const it = {
          key: 'labor:' + g.gk, ids: use.map((e) => 'labor:' + e.id), date: g.date, unit: proc === 'transport' ? 'hr' : 'person-hr', qty,
          service: proc === 'transport' ? 'box_truck' : 'farm_labor',
          label: [short(g.date), proc === 'farm_labor' ? ptitle : '', where].filter(Boolean).join(' · '),
          sub: `${people}${proc === 'farm_labor' ? ` · ${byPerson.size} ${byPerson.size === 1 ? 'person' : 'people'}` : ''}`,
          note: [g.note, fresh.length && fresh.length < g.entries.length ? `${g.entries.length - fresh.length} of the entries already invoiced` : ''].filter(Boolean).join(' · '),
          desc: proc === 'transport' ? `Transport — ${short(g.date)}${where ? ` — ${where}` : ''}` : `Farm labor (${ptitle}) — ${short(g.date)}${where ? ` — ${where}` : ''}`,
          detail: proc === 'transport' ? `Hours logged: ${people}` : `${byPerson.size} ${byPerson.size === 1 ? 'person' : 'people'}: ${people}`
        };
        if (!fresh.length) it.invoiced = inv.get('labor:' + g.entries[0].id);
        return it;
      });
    }
    return [];
  }

  // ── Contract rates ─────────────────────────────────────────────────────
  function ratesRowFor(D, cid) {
    return D.rates.filter((r) => (r.fields || {}).cid === cid)
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0] || null;
  }
  async function saveContractRates(cid, rates, source, client) {
    client = client || getClient();
    if (!client) throw new Error('Supabase isn’t configured.');
    const { data: rows, error: e1 } = await client.from('operations_forms').select('id,fields')
      .eq('station_key', RATES_KEY).eq('fields->>cid', cid).limit(1);
    if (e1) throw e1;
    const who = me();
    const fields = { cid, rates, source: source || 'manual', savedBy: who, savedAt: new Date().toISOString() };
    const { error } = rows && rows.length
      ? await client.from('operations_forms').update({ fields, updated_by: who || null }).eq('id', rows[0].id)
      : await client.from('operations_forms').insert({ station_key: RATES_KEY, status: 'submitted', owner_user: who || null, updated_by: who || null,
          work_date: localDay(), submitted_at: new Date().toISOString(), fields });
    if (error) throw error;
  }

  // ── PDF ────────────────────────────────────────────────────────────────
  function totals(req) {
    const lines = req.lines || [];
    const sub = r2(lines.reduce((a, l) => a + num(l.qty) * num(l.rate), 0));
    const atContract = r2(lines.reduce((a, l) => a + num(l.qty) * (l.contract == null ? num(l.rate) : num(l.contract)), 0));
    const disc = req.discountType === '%' ? r2(sub * num(req.discountValue) / 100) : r2(num(req.discountValue));
    return { sub, atContract, adjust: r2(sub - atContract), disc, total: r2(sub - disc) };
  }
  function pdfBlocks(req) {
    const b = req.billTo || {};
    const tt = totals(req);
    const dash = (s) => String(s || '').replace(/\*/g, '').trim() || '—';
    const stateName = M.STATES[b.state] || b.state;
    const dates = (req.lines || []).map((l) => l.date).filter(Boolean).sort();
    const rows = (req.lines || []).map((l) => [
      [l.desc, l.detail].filter(Boolean).join(' — '),
      fmtN(l.qty), l.unit || '', l.contract == null ? '—' : money(l.contract), money(num(l.rate)), money(num(l.qty) * num(l.rate))]);
    const sumRows = [['Total at contract rates', money(tt.atContract)]];
    if (tt.adjust) sumRows.push([tt.adjust < 0 ? 'Rate discount (rates below contract, above)' : 'Rate adjustment (rates above contract, above)', money(tt.adjust)]);
    if (tt.disc) sumRows.push([`Discount${req.discountType === '%' ? ` (${fmtN(req.discountValue)}%)` : ''}`, money(-tt.disc)]);
    sumRows.push(['Total to invoice', money(tt.total)]);
    return [
      { t: 'title', text: 'INVOICE REQUEST — SERVICES' },
      { t: 'table', cols: [130, 338], boldFirstCol: true, rows: [
        ['From:', '2CW Operations'], ['To:', '2CW Finance'],
        ['Requested by:', dash(req.requestedBy)], ['Date:', M.fmtDate(req.date) || dash(req.date)], ['Request #:', dash(req.number)]] },
      { t: 'sub', text: 'Bill to' },
      { t: 'table', cols: [130, 338], boldFirstCol: true, rows: [
        ['Customer:', `${dash(req.customerName)} (CID ${dash(req.cid)})`],
        ['Legal business name:', dash(b.legal_name)],
        ['Entity:', [stateName, b.entity].filter(Boolean).join(' ') || '—'],
        ['Farm name:', dash(b.farm_name)], ['License #:', dash(b.license_number)],
        ['Mailing address:', [b.address, b.city].map((x) => String(x || '').trim()).filter(Boolean).join(', ') || '—'],
        ['Contact:', dash(b.contact_name)], ['Phone:', dash(b.contact_phone)], ['Email:', dash(b.contact_email)]] },
      { t: 'sub', text: 'Services' },
      { t: 'table', cols: [178, 50, 52, 62, 62, 64], borders: true, header: ['Description', 'Qty', 'Unit', 'Contract rate', 'Rate', 'Amount'], rows },
      { t: 'table', cols: [404, 64], borders: true, rows: sumRows },
      { t: 'p', text: `**Please invoice the customer for: ${money(tt.total)}**`, size: 13 },
      ...(dates.length ? [{ t: 'p', text: `Service dates: ${short(dates[0])}${dates[dates.length - 1] !== dates[0] ? ` – ${short(dates[dates.length - 1])}` : ''}.` }] : []),
      ...(tt.adjust < 0 || tt.disc ? [{ t: 'sub', text: 'Reason for discount' }, { t: 'p', text: dash(req.discountNote) }] : []),
      ...(String(req.notes || '').trim() ? [{ t: 'sub', text: 'Notes' }, { t: 'p', text: req.notes.replace(/\*/g, '') }] : []),
      { t: 'p', text: `Contract rates: ${req.ratesSource || 'standard rates (Master Service Agreement, Exhibit B)'}. Quantities are from 2CW’s operations records (net wet weight at intake, pounds in at each processing stage, hours from the Labor Log).` }
    ];
  }
  const pdfFor = (req) => ({
    blocks: pdfBlocks(req),
    footer: `Invoice request ${req.number || ''} — ${req.customerName || req.cid || ''}`,
    fileName: `2CW Invoice Request - ${String(req.customerName || req.cid || 'Customer').replace(/[\\/:*?"<>|]+/g, '').trim()} - ${req.number || req.date}.pdf`
  });
  const downloadReq = (req) => M.download({ legal_name: (req.billTo || {}).legal_name || req.customerName }, 'services', pdfFor(req));

  // ── The dialog ─────────────────────────────────────────────────────────
  const CSS = `
    .msa.inv{max-width:960px}
    .inv .inv-items{border:1px solid var(--border,#1e2129);border-radius:10px;max-height:320px;overflow-y:auto}
    .inv .inv-item{display:flex;gap:10px;align-items:flex-start;padding:9px 12px;margin:0;border-top:1px solid var(--border,#1e2129);cursor:pointer;
      font-family:inherit;font-size:.88rem;letter-spacing:0;text-transform:none;color:var(--text,#e8eaf0)}
    .inv .inv-item:first-child{border-top:none}
    .inv .inv-item input{width:18px;height:18px;margin-top:2px;flex:0 0 auto;accent-color:var(--blue,#5a9fd4)}
    .inv .inv-item .s{color:var(--subtext,#9aa0b0);font-size:.8rem;margin-top:2px}
    .inv .inv-item .n{color:var(--gold,#d4a843);font-size:.78rem;margin-top:2px}
    .inv .inv-item.done{cursor:default;opacity:.75}
    .inv .inv-done{color:var(--red,#ef5350);font-weight:700}
    .inv details>summary{cursor:pointer;color:var(--subtext,#9aa0b0);font-size:.82rem;padding:8px 12px}
    .inv .inv-empty{padding:14px;color:var(--subtext,#9aa0b0);font-size:.85rem}
    .inv .inv-line{display:grid;grid-template-columns:2.6fr .8fr .7fr .9fr .9fr .9fr auto;gap:6px;align-items:start;padding:8px 0;border-top:1px solid var(--border,#1e2129)}
    .inv .inv-line input,.inv .inv-line select{font-size:.82rem;padding:.45rem .5rem}
    .inv .inv-line .ro{padding:.45rem 0;font-size:.85rem}
    .inv .inv-line .d{font-size:.75rem;color:var(--subtext,#9aa0b0);margin-top:4px}
    .inv .inv-line .off{font-size:.72rem;color:var(--gold,#d4a843);margin-top:3px}
    .inv .inv-tot{margin-top:10px;display:grid;grid-template-columns:1fr auto;gap:4px 18px;font-size:.9rem;max-width:460px;margin-left:auto}
    .inv .inv-tot b{font-size:1rem}
    .inv .inv-rates{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px;margin-top:8px}
    .inv .inv-hist{font-size:.85rem}
    .inv .inv-hist .row{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:7px 0;border-top:1px solid var(--border,#1e2129);flex-wrap:wrap}
    .inv .inv-hist .void{text-decoration:line-through;color:var(--muted,#5a6070)}
    .inv textarea{width:100%;box-sizing:border-box;background:#0c0d0f;border:1px solid var(--border,#1e2129);color:var(--text,#e8eaf0);border-radius:8px;padding:.55rem .65rem;font-family:inherit;font-size:.9rem;min-height:60px}
    .inv .inv-chk{display:flex;gap:8px;align-items:center;font-size:.82rem;color:var(--subtext,#9aa0b0);margin:8px 0 0;text-transform:none;letter-spacing:0;font-family:inherit}
    .inv .inv-chk input{width:16px;height:16px}
    @media (max-width:700px){ .inv .inv-line{grid-template-columns:1fr 1fr 1fr} .inv .inv-line>.desc{grid-column:1/-1} .inv .inv-hdrow{display:none} }`;

  async function open(opts = {}) {
    if (!document.getElementById('msa-css')) { const st = document.createElement('style'); st.id = 'msa-css'; st.textContent = M.CSS; document.head.appendChild(st); }
    if (!document.getElementById('inv-css')) { const st = document.createElement('style'); st.id = 'inv-css'; st.textContent = CSS; document.head.appendChild(st); }
    const client = getClient();
    const bg = document.createElement('div');
    bg.className = 'msa-bg';
    bg.innerHTML = '<div class="msa inv"><h2>Invoice request for services</h2><div class="msa-sub">Loading the operations records…</div></div>';
    document.body.appendChild(bg);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const close = () => { bg.remove(); document.body.style.overflow = prevOverflow; document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });

    let D;
    try {
      if (!client) throw new Error('Supabase isn’t configured.');
      D = await loadAll(client);
    } catch (e) {
      bg.querySelector('.msa-sub').innerHTML = `<span style="color:var(--red,#ef5350)">Couldn’t load the records: ${esc(e.message || e)}</span>`;
      return;
    }
    let T = makeTracer(D), inv = invoicedMap(D.reqs);

    const st = { cid: opts.cid || '', proc: '', showUnmatched: false, lines: [], billTo: {}, discountType: '%', discountValue: '', discountNote: '', notes: '', editRates: false };
    let contract = standardRates(), ratesSource = '';
    const customer = () => D.codes.find((c) => c.code === st.cid) || null;
    const contractFor = (service, qty) => (service === 'box_truck' && num(qty) >= 8 && contract[BOX8] != null ? contract[BOX8] : (contract[service] != null ? contract[service] : null));

    function pickCustomer(cid) {
      st.cid = cid; st.lines = []; st.proc = '';
      const row = ratesRowFor(D, cid);
      contract = { ...standardRates(), ...((row && row.fields.rates) || {}) };
      ratesSource = row ? `${row.fields.source === 'msa' ? 'from the Service Agreement' : 'set for this customer'} (saved ${short(row.fields.savedAt || row.updated_at)}${row.fields.savedBy ? ` by ${row.fields.savedBy}` : ''})` : '';
      // Who to bill: the last request's details, else their newest drying
      // request whose farm or legal name matches the customer name.
      const last = D.reqs.filter((r) => (r.fields || {}).cid === cid).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      if (last && last.fields.billTo) { st.billTo = { ...last.fields.billTo }; return; }
      const c = customer();
      const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const n = norm(c && c.name);
      const match = n && D.dry.find((x) => [x.farm_name, x.legal_business_name].some((y) => norm(y) && (norm(y) === n || norm(y).startsWith(n) || n.startsWith(norm(y)))));
      const f = match ? M.fromIntake(match) : { legal_name: (c && c.name) || '', entity: M.guessEntity(c && c.name) };
      st.billTo = { legal_name: f.legal_name || '', entity: f.entity || '', state: f.state || '', farm_name: f.farm_name || '', license_number: f.license_number || '',
        address: f.address || '', city: f.city || '', contact_name: f.contact_name || '', contact_phone: f.contact_phone || '', contact_email: f.contact_email || '' };
    }
    if (st.cid) pickCustomer(st.cid);

    const lineFromItem = (it) => {
      const c = contractFor(it.service, it.qty);
      return { key: it.key, ids: it.ids, date: it.date, service: it.service, desc: it.desc, detail: it.detail, qty: it.qty, unit: it.unit,
        contract: c, rate: c == null ? '' : c, vehicle: VEHICLES.includes(it.service) };
    };
    // A line's contract rate follows its service and quantity (the box
    // truck's 8-hour rate); a rate still at the old contract follows along.
    function syncContract(l) {
      if (!l.service) return;
      const c = contractFor(l.service, l.qty);
      if (c === l.contract) return;
      if (l.rate === '' || num(l.rate) === num(l.contract)) l.rate = c == null ? '' : c;
      l.contract = c;
    }

    const fld = (k, label, attrs = '') => `<div><label>${label}</label><input data-b="${k}" value="${esc(st.billTo[k] || '')}" ${attrs}/></div>`;
    function itemsHtml() {
      if (!st.proc || st.proc === 'other') return '';
      const items = itemsFor(D, T, inv, st.cid, st.proc, st.showUnmatched).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const open = items.filter((i) => !i.invoiced), done = items.filter((i) => i.invoiced);
      const row = (i) => `<label class="inv-item ${i.invoiced ? 'done' : ''}">
          ${i.invoiced ? '<span class="inv-done" title="Already on an invoice request">✓</span>' : `<input type="checkbox" data-item="${esc(i.key)}" ${st.lines.some((l) => l.key === i.key) ? 'checked' : ''}>`}
          <div><div>${esc(i.label)}</div><div class="s">${esc(i.sub)}</div>
          ${i.invoiced ? `<div class="s inv-done">Invoiced — request ${esc(i.invoiced.number || '')}, ${esc(short(i.invoiced.date))}</div>` : ''}
          ${i.note ? `<div class="n">${esc(i.note)}</div>` : ''}</div></label>`;
      const labor = st.proc === 'transport' || st.proc === 'farm_labor';
      return `<div class="inv-items">${open.length ? open.map(row).join('') : `<div class="inv-empty">Nothing left to invoice for this customer here${done.length ? '' : ' — no records tied to them yet'}.</div>`}
        ${done.length ? `<details><summary>Already invoiced (${done.length})</summary>${done.map(row).join('')}</details>` : ''}</div>
        ${labor ? `<label class="inv-chk"><input type="checkbox" id="inv-unm" ${st.showUnmatched ? 'checked' : ''}> Also show hours not tied to any customer</label>
          <div class="msa-sub" style="margin:6px 0 0">Hours count for this customer when they’re logged to one of their Master Schedule projects (its Customer field, or UIDs that trace back to them), to their UIDs, or to their farm license.${st.proc === 'transport' ? ' Transport bills the longest hours anyone logged that day — one truck — change the quantity if two vehicles ran.' : ''}</div>` : ''}`;
    }
    function lineHtml(l, i) {
      const below = l.contract != null && l.rate !== '' && num(l.rate) < num(l.contract);
      const above = l.contract != null && l.rate !== '' && num(l.rate) > num(l.contract);
      const pct = l.contract ? Math.round((1 - num(l.rate) / num(l.contract)) * 1000) / 10 : 0;
      return `<div class="inv-line" data-i="${i}">
        <div class="desc"><input data-l="desc" value="${esc(l.desc)}" placeholder="Description">
          ${l.vehicle ? `<select data-l="service" style="margin-top:4px">${VEHICLES.map((k) => `<option value="${k}" ${l.service === k ? 'selected' : ''}>${esc(M.serviceLabel(k))}</option>`).join('')}</select>` : ''}
          <input data-l="detail" value="${esc(l.detail || '')}" placeholder="Details (optional)" style="margin-top:4px;font-size:.75rem"></div>
        <div><input data-l="qty" value="${esc(l.qty)}" inputmode="decimal" placeholder="Qty"></div>
        <div><input data-l="unit" value="${esc(l.unit || '')}" placeholder="Unit"></div>
        <div class="ro">${l.contract == null ? '<span style="color:var(--muted,#5a6070)">—</span>' : money(l.contract)}</div>
        <div><input data-l="rate" value="${esc(l.rate)}" inputmode="decimal" placeholder="Rate">
          <div class="off" data-off>${below ? `${pct}% under contract` : above ? 'Above contract' : ''}</div></div>
        <div class="ro" data-amt>${money(num(l.qty) * num(l.rate))}</div>
        <button type="button" class="msa-x" data-rm="${i}" title="Remove">×</button></div>`;
    }
    function totalsHtml() {
      const tt = totals(st);
      const needNote = (tt.adjust < 0 || tt.disc > 0) && !st.discountNote.trim();
      return `<span>Total at contract rates</span><span>${money(tt.atContract)}</span>
        ${tt.adjust ? `<span>${tt.adjust < 0 ? 'Rate discount' : 'Rate adjustment'}</span><span>${money(tt.adjust)}</span>` : ''}
        ${tt.disc ? `<span>Discount</span><span>${money(-tt.disc)}</span>` : ''}
        <b>Total to invoice</b><b>${money(tt.total)}</b>
        ${needNote ? '<span style="grid-column:1/-1;color:var(--gold,#d4a843);font-size:.8rem">Add the reason for the discount below.</span>' : ''}`;
    }
    function histHtml() {
      const list = D.reqs.filter((r) => (r.fields || {}).cid === st.cid).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      if (!list.length) return '<div class="msa-sub" style="margin:0">None yet.</div>';
      return list.map((r) => { const f = r.fields; return `<div class="row"><span class="${f.voided ? 'void' : ''}">${esc(f.number || '')} · ${esc(short(r.work_date))} · ${esc(f.requestedBy || '')} · <b>${money(num(f.total))}</b> · ${(f.lines || []).length} line${(f.lines || []).length === 1 ? '' : 's'}</span>
        <span>${f.voided ? `<span style="color:var(--muted,#5a6070)">Voided${f.voidReason ? ` — ${esc(f.voidReason)}` : ''}</span>` : `<button type="button" class="msa-btn" data-pdf="${r.id}">PDF</button> <button type="button" class="msa-btn" data-void="${r.id}">Void</button>`}</span></div>`; }).join('');
    }
    function ratesHtml() {
      return `<div class="inv-rates">${RATE_KEYS().map((k) => `<div><label>${esc(rateLabel(k))}</label><input data-rate="${k}" value="${contract[k] == null ? '' : contract[k]}" inputmode="decimal"></div>`).join('')}</div>
        <div class="msa-acts" style="margin-top:10px"><button type="button" class="msa-btn" id="inv-rates-std">Reset to standard</button><button type="button" class="msa-btn msa-go" id="inv-rates-save">Save rates for this customer</button></div>`;
    }

    function draw() {
      const c = customer();
      const codes = [...D.codes].sort((a, b) => (b.active - a.active) || String(a.name || '').localeCompare(String(b.name || '')));
      bg.innerHTML = `<div class="msa inv" role="dialog" aria-label="Invoice request for services">
        <h2>Invoice request for services</h2>
        <div class="msa-sub">2CW Operations asking 2CW Finance to invoice a customer for work done. Pick the customer, then a process, and tick the work to bill; rates start at the customer’s contract rates. Saving marks the work as invoiced and downloads the PDF to send to Finance.</div>
        <div class="msa-g">
          <div><label for="inv-cid">Customer</label><select id="inv-cid"><option value="">Pick a customer…</option>${codes.map((x) => `<option value="${esc(x.code)}" ${x.code === st.cid ? 'selected' : ''}>${esc(x.name || x.code)} — CID ${esc(x.code)}${x.active ? '' : ' (inactive)'}</option>`).join('')}</select></div>
          ${st.cid ? `<div><label for="inv-proc">Process</label><select id="inv-proc"><option value="">Pick a process…</option>${PROCESSES.map((p) => `<option value="${p.k}" ${p.k === st.proc ? 'selected' : ''}>${esc(p.l)}</option>`).join('')}</select></div>` : ''}
        </div>
        ${!st.cid ? '' : `
        ${st.proc === 'other' ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
            <select id="inv-addsvc" style="flex:1 1 240px"><option value="">+ Add a service from the price list…</option>${Object.keys(M.EXB).map((k) => `<option value="${k}">${esc(M.serviceLabel(k))} — ${esc(M.EXB[k].unit.toLowerCase())}</option>`).join('')}</select>
            <button type="button" class="msa-btn" id="inv-blank">+ Blank line</button></div>
            <div class="msa-sub" style="margin:6px 0 0">A blank line takes a negative amount too — e.g. less the drying deposit already invoiced.</div>` : `<div style="margin-top:12px">${itemsHtml()}</div>`}

        <div class="msa-sect">Request lines</div>
        ${st.lines.length ? `<div class="inv-line inv-hdrow" style="border-top:none;padding-bottom:0"><span class="msa-hd">Description</span><span class="msa-hd">Qty</span><span class="msa-hd">Unit</span><span class="msa-hd">Contract</span><span class="msa-hd">Rate</span><span class="msa-hd">Amount</span><span></span></div>
          ${st.lines.map(lineHtml).join('')}` : '<div class="msa-sub" style="margin:0">Nothing on the request yet — pick a process above and tick the work to bill.</div>'}
        <div class="msa-g" style="margin-top:12px">
          <div><label for="inv-dtype">Discount on the whole request</label><div style="display:flex;gap:6px">
            <select id="inv-dtype" style="flex:0 0 70px"><option value="%" ${st.discountType === '%' ? 'selected' : ''}>%</option><option value="$" ${st.discountType === '$' ? 'selected' : ''}>$</option></select>
            <input id="inv-dval" value="${esc(st.discountValue)}" inputmode="decimal" placeholder="0"></div></div>
          <div><label for="inv-dnote">Reason for discount</label><input id="inv-dnote" value="${esc(st.discountNote)}" placeholder="Needed for any discount or rate under contract"></div>
        </div>
        <div class="inv-tot" id="inv-tot">${totalsHtml()}</div>

        <div class="msa-sect">Contract rates</div>
        <div class="msa-sub" style="margin:0">${ratesSource ? `This customer’s rates, ${esc(ratesSource)}.` : 'No agreement rates saved for this customer — using the standard rates (MSA Exhibit B). Making the Service Agreement PDF from their Documents saves its rates here.'}
          <a href="#" id="inv-rates-tog" style="color:var(--blue,#5a9fd4)">${st.editRates ? 'Hide' : 'View / edit'}</a></div>
        ${st.editRates ? ratesHtml() : ''}

        <div class="msa-sect">Bill to</div>
        <div class="msa-g">
          ${fld('legal_name', 'Legal business name')}${fld('farm_name', 'Farm name')}
          ${fld('license_number', 'License #')}${fld('contact_name', 'Contact')}
          ${fld('address', 'Mailing address', 'placeholder="Street"')}${fld('city', 'City, state, zip')}
          ${fld('contact_phone', 'Phone', 'type="tel"')}${fld('contact_email', 'Email', 'type="email"')}
        </div>
        <div style="margin-top:10px"><label for="inv-notes">Notes for Finance (optional)</label><textarea id="inv-notes">${esc(st.notes)}</textarea></div>

        <div class="msa-sect">Earlier requests — ${esc((c && c.name) || st.cid)}</div>
        <div class="inv-hist">${histHtml()}</div>`}
        <div class="msa-err" id="inv-err"></div>
        <div class="msa-acts">
          <button type="button" class="msa-btn" id="inv-close">Close</button>
          ${st.cid ? `<button type="button" class="msa-btn msa-go" id="inv-go" ${st.lines.length ? '' : 'disabled'}>Save &amp; download PDF</button>` : ''}
        </div></div>`;
      wire();
    }
    const errBox = (m) => { const e = bg.querySelector('#inv-err'); e.textContent = m || ''; e.style.display = m ? 'block' : 'none'; };
    const refreshTotals = () => { const el = bg.querySelector('#inv-tot'); if (el) el.innerHTML = totalsHtml(); };

    function wire() {
      const $ = (s) => bg.querySelector(s);
      $('#inv-close').onclick = close;
      $('#inv-cid').onchange = (e) => {
        if (st.lines.length && !confirm('Switch customer? The lines on this request are cleared.')) { e.target.value = st.cid; return; }
        pickCustomer(e.target.value); draw();
      };
      if (!st.cid) return;
      $('#inv-proc').onchange = (e) => { st.proc = e.target.value; draw(); };
      const unm = $('#inv-unm'); if (unm) unm.onchange = () => { st.showUnmatched = unm.checked; draw(); };
      bg.querySelectorAll('[data-item]').forEach((cb) => { cb.onchange = () => {
        const key = cb.dataset.item;
        if (cb.checked) {
          const it = itemsFor(D, T, inv, st.cid, st.proc, st.showUnmatched).find((x) => x.key === key);
          if (it) st.lines.push(lineFromItem(it));
        } else st.lines = st.lines.filter((l) => l.key !== key);
        draw();
      }; });
      const add = $('#inv-addsvc');
      if (add) add.onchange = () => {
        const k = add.value; if (!k) return;
        const c = contractFor(k, 0);
        st.lines.push({ key: 'custom:' + Math.random().toString(36).slice(2), ids: [], service: k, desc: M.serviceLabel(k), detail: M.EXB[k].notes || '',
          qty: '', unit: M.EXB[k].unit.replace(/^Per /i, '').toLowerCase(), contract: c, rate: c == null ? '' : c, vehicle: false });
        draw();
      };
      const blank = $('#inv-blank');
      if (blank) blank.onclick = () => { st.lines.push({ key: 'custom:' + Math.random().toString(36).slice(2), ids: [], service: '', desc: '', detail: '', qty: 1, unit: '', contract: null, rate: '', vehicle: false }); draw(); };
      bg.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { st.lines.splice(Number(b.dataset.rm), 1); draw(); }; });
      bg.querySelectorAll('.inv-line[data-i]').forEach((row) => {
        const l = st.lines[Number(row.dataset.i)];
        row.querySelectorAll('[data-l]').forEach((el) => {
          const ev = el.tagName === 'SELECT' ? 'change' : 'input';
          el.addEventListener(ev, () => {
            const k = el.dataset.l;
            l[k] = el.value;
            if (k === 'service') { syncContract(l); draw(); return; }
            if (k === 'qty') {
              const before = l.contract; syncContract(l);
              if (l.contract !== before) { draw(); return; }
            }
            row.querySelector('[data-amt]').textContent = money(num(l.qty) * num(l.rate));
            const off = row.querySelector('[data-off]');
            const below = l.contract != null && l.rate !== '' && num(l.rate) < num(l.contract);
            off.textContent = below ? `${Math.round((1 - num(l.rate) / num(l.contract)) * 1000) / 10}% under contract` : (l.contract != null && num(l.rate) > num(l.contract) ? 'Above contract' : '');
            refreshTotals();
          });
        });
      });
      $('#inv-dtype').onchange = (e) => { st.discountType = e.target.value; refreshTotals(); };
      $('#inv-dval').oninput = (e) => { st.discountValue = e.target.value; refreshTotals(); };
      $('#inv-dnote').oninput = (e) => { st.discountNote = e.target.value; refreshTotals(); };
      $('#inv-notes').oninput = (e) => { st.notes = e.target.value; };
      bg.querySelectorAll('[data-b]').forEach((el) => { el.oninput = () => { st.billTo[el.dataset.b] = el.value; }; });
      $('#inv-rates-tog').onclick = (e) => { e.preventDefault(); st.editRates = !st.editRates; draw(); };
      if (st.editRates) {
        $('#inv-rates-std').onclick = () => { const s = standardRates(); bg.querySelectorAll('[data-rate]').forEach((el) => { el.value = s[el.dataset.rate]; }); };
        $('#inv-rates-save').onclick = async (e) => {
          const btn = e.currentTarget, rates = {};
          bg.querySelectorAll('[data-rate]').forEach((el) => { if (el.value.trim() !== '') rates[el.dataset.rate] = num(el.value); });
          btn.disabled = true; btn.textContent = 'Saving…';
          try {
            await saveContractRates(st.cid, rates, 'manual', client);
            D.rates = await rowsOf(client, RATES_KEY);
            const keep = { lines: st.lines, billTo: st.billTo, proc: st.proc };
            pickCustomer(st.cid);
            Object.assign(st, keep, { editRates: false });
            st.lines.forEach(syncContract);
            draw();
          } catch (ex) { errBox(`Couldn’t save the rates: ${ex.message || ex}`); btn.disabled = false; btn.textContent = 'Save rates for this customer'; }
        };
      }
      bg.querySelectorAll('[data-pdf]').forEach((b) => { b.onclick = async () => {
        const r = D.reqs.find((x) => x.id === b.dataset.pdf);
        b.disabled = true;
        try { await downloadReq(r.fields); } catch (ex) { errBox(ex.message || String(ex)); }
        b.disabled = false;
      }; });
      bg.querySelectorAll('[data-void]').forEach((b) => { b.onclick = async () => {
        const r = D.reqs.find((x) => x.id === b.dataset.void);
        const why = prompt(`Void request ${r.fields.number}? Its work shows as not invoiced again. Tell Finance too if they already have it.\n\nReason:`);
        if (why == null) return;
        const fields = { ...r.fields, voided: true, voidReason: why.trim(), voidedBy: me(), voidedAt: new Date().toISOString() };
        const { error } = await client.from('operations_forms').update({ fields, updated_by: me() || null }).eq('id', r.id);
        if (error) { errBox(`Couldn’t void it: ${error.message}`); return; }
        r.fields = fields; inv = invoicedMap(D.reqs); draw();
      }; });
      const go = $('#inv-go');
      if (go) go.onclick = () => save(go);
    }

    async function save(btn) {
      errBox('');
      const lines = st.lines.map((l) => ({ ...l, desc: String(l.desc || '').trim(), qty: num(l.qty), rate: num(l.rate) }));
      if (lines.some((l) => !l.desc)) return errBox('Every line needs a description.');
      if (lines.some((l) => !l.qty)) return errBox('Every line needs a quantity.');
      const tt = totals({ ...st, lines });
      if ((tt.adjust < 0 || tt.disc > 0) && !st.discountNote.trim()) return errBox('Add the reason for the discount (a rate under contract or a discount on the request).');
      if (tt.total < 0) return errBox('The total is below zero.');
      // Someone else may have invoiced the same work since this opened.
      let fresh;
      try { fresh = await rowsOf(client, REQ_KEY); } catch (ex) { return errBox(`Couldn’t check earlier requests: ${ex.message || ex}`); }
      const taken = invoicedMap(fresh);
      const clash = lines.find((l) => (l.ids || []).some((id) => taken.has(id)));
      if (clash) { D.reqs = fresh; inv = taken; draw(); return errBox(`“${clash.desc}” was just put on request ${taken.get(clash.ids.find((id) => taken.has(id))).number}. Remove it and try again.`); }
      const date = localDay();
      const seq = fresh.filter((r) => (r.fields || {}).cid === st.cid && r.work_date === date).length + 1;
      const c = customer();
      const req = {
        number: `IR-${st.cid}-${date.replace(/-/g, '')}-${seq}`, cid: st.cid, customerName: (c && c.name) || '', date, requestedBy: me(),
        billTo: { ...st.billTo }, lines: lines.map(({ vehicle, ...l }) => l), discountType: st.discountType, discountValue: num(st.discountValue),
        discountNote: st.discountNote.trim(), notes: st.notes.trim(), ratesSource: ratesSource ? `this customer’s rates, ${ratesSource}` : '',
        subtotal: tt.sub, contractTotal: tt.atContract, discount: tt.disc, total: tt.total
      };
      btn.disabled = true; btn.textContent = 'Saving…';
      const { data, error } = await client.from('operations_forms').insert({
        station_key: REQ_KEY, status: 'submitted', owner_user: me() || null, updated_by: me() || null,
        work_date: date, submitted_at: new Date().toISOString(), fields: req }).select();
      if (error) { btn.disabled = false; btn.textContent = 'Save & download PDF'; return errBox(`Couldn’t save the request: ${error.message}`); }
      D.reqs = [...fresh, ...(data || [])]; inv = invoicedMap(D.reqs);
      st.lines = []; st.discountValue = ''; st.discountNote = ''; st.notes = '';
      draw();
      try { await downloadReq(req); } catch (ex) { errBox(`Saved as ${req.number}, but the PDF didn’t download: ${ex.message || ex} — use its PDF button below.`); }
    }

    draw();
  }

  const api = { open, saveContractRates, ratesFromLines, itemsFor, makeTracer, invoicedMap, totals, pdfBlocks, standardRates };
  if (typeof window !== 'undefined') window.InvoiceServices = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
