// Bulk menu — a priced PDF menu of what's on hand, opened from Raw Materials
// Inventory (☰ Bulk menu). Pick the sections, untick batches to leave out,
// change a batch's pounds, set a price per pound for each category (Flower,
// Smalls, each kind of trim…) or for one batch, and Generate PDF draws the
// menu in the Soma Rosa Farms flyer style.
//
// The prices, batch changes and menu text are shared: one operations_forms
// row (station_key 'raw_inventory_menu', fixed id), saved as you type, so the
// next person starts from the same prices. Batches are keyed by the raw
// inventory row key, so a batch's price and pounds stay with it.
//
// The PDF is one tall page (html2canvas + jsPDF, like menu.html): on phones
// it goes to the share sheet, elsewhere it downloads.
(function () {
  const SETTINGS_ID = '72617769-6e76-4000-8000-000000000002';
  const MENU_W = 900;

  const L = {
    head:     { en: 'Bulk menu', es: 'Menú a granel' },
    pdf:      { en: '⇩ Generate PDF', es: '⇩ Generar PDF' },
    making:   { en: 'Making PDF…', es: 'Haciendo PDF…' },
    close:    { en: 'Close', es: 'Cerrar' },
    sections: { en: 'Sections', es: 'Secciones' },
    prices:   { en: 'Price per lb by category', es: 'Precio por lb por categoría' },
    pricesHint:{ en: 'A batch with its own price below uses that instead. No price shows “Call”.', es: 'Un lote con su propio precio abajo usa ese. Sin precio muestra “Llamar”.' },
    batches:  { en: 'Batches', es: 'Lotes' },
    batch:    { en: 'Batch', es: 'Lote' },
    batchHint:{ en: 'Untick a batch to leave it off. Available and $/lb start from what’s on hand and the category price; change them for this batch only.', es: 'Desmarque un lote para dejarlo fuera. Disponible y $/lb empiezan con lo disponible y el precio de la categoría; cámbielos solo para este lote.' },
    all:      { en: 'All', es: 'Todos' },
    none:     { en: 'None', es: 'Ninguno' },
    onHand:   { en: 'On hand', es: 'Disponible' },
    avail:    { en: 'Available', es: 'Disponible' },
    perLb:    { en: '$/lb', es: '$/lb' },
    details:  { en: 'Menu text', es: 'Texto del menú' },
    brand:    { en: 'Brand', es: 'Marca' },
    kicker:   { en: 'Line above the title', es: 'Línea sobre el título' },
    title:    { en: 'Title', es: 'Título' },
    place:    { en: 'Location', es: 'Ubicación' },
    blurb:    { en: 'Description', es: 'Descripción' },
    contact:  { en: 'Contact', es: 'Contacto' },
    phone:    { en: 'Phone', es: 'Teléfono' },
    email:    { en: 'Email', es: 'Correo' },
    web:      { en: 'Website', es: 'Sitio web' },
    notes:    { en: 'Fine print', es: 'Letra pequeña' },
    showBatch:{ en: 'Show batch # (end of the UID)', es: 'Mostrar # de lote (final del UID)' },
    showFarm: { en: 'Show farm', es: 'Mostrar rancho' },
    preview:  { en: 'Preview', es: 'Vista previa' },
    saving:   { en: 'Saving…', es: 'Guardando…' },
    saved:    { en: 'Saved — shared with everyone who makes a menu', es: 'Guardado — compartido con todos los que hacen un menú' },
    notSaved: { en: 'Not saved:', es: 'No guardado:' },
    nothing:  { en: 'Pick a section with batches in it.', es: 'Elija una sección con lotes.' },
    pdfFail:  { en: 'PDF failed:', es: 'Falló el PDF:' },
    wet:      { en: 'wet', es: 'húmedo' },
    pkgs:     { en: 'batches', es: 'lotes' }
  };

  // The inventory's tabs as menu sections, in menu order. `menu` and `desc`
  // are what the customer reads, so English only.
  const SECTIONS = [
    { k: 'flower', l: { en: 'Flower', es: 'Flor' }, menu: 'Flower', desc: 'Finished flower, priced per pound' },
    { k: 'smalls', l: { en: 'Smalls', es: 'Smalls' }, menu: 'Smalls', desc: 'Small buds, trimmed' },
    { k: 'trim', l: { en: 'Trim', es: 'Recorte' }, menu: 'Trim & Shake', desc: 'Trim, sugar trim and shake' },
    { k: 'bucked', l: { en: 'Bucked', es: 'Desvarado' }, menu: 'Bucked Flower', desc: 'Bucked off the stem, untrimmed' },
    { k: 'onstem', l: { en: 'On-Stem', es: 'En tallo' }, menu: 'On-Stem', desc: 'Dried on the stem' },
    { k: 'frozen', l: { en: 'Fresh Frozen', es: 'Fresco congelado' }, menu: 'Fresh Frozen', desc: 'Fresh frozen — wet weight' },
    { k: 'drying', l: { en: 'Drying', es: 'Secando' }, menu: 'Drying Now', desc: 'In the dry room now — wet weight' }
  ];
  const SECTION = Object.fromEntries(SECTIONS.map((s) => [s.k, s]));

  // Price categories: a section, except trim, which is priced by kind.
  const GROUPS = {
    'trim:trim': { l: { en: 'Trim — Normal', es: 'Recorte — normal' }, menu: 'Trim' },
    'trim:bucking': { l: { en: 'Bucking trim', es: 'Recorte de desvarado' }, menu: 'Bucking Trim' },
    'trim:trim_a_plus': { l: { en: 'A+ trim', es: 'Recorte A+' }, menu: 'A+ Trim' },
    'trim:sugar_trim': { l: { en: 'Sugar trim', es: 'Recorte azucarado' }, menu: 'Sugar Trim' },
    'trim:shake': { l: { en: 'Shake', es: 'Shake' }, menu: 'Shake' }
  };
  const groupOf = (r) => (r.tab !== 'trim' ? r.tab : r.type === 'tBuck' ? 'trim:bucking' : `trim:${r.cat || 'trim'}`);
  const groupLabel = (g) => (GROUPS[g] ? t(GROUPS[g].l) : SECTION[g] ? t(SECTION[g].l) : g.replace(/^trim:/, '').replace(/_/g, ' '));
  const groupMenu = (g) => (GROUPS[g] ? GROUPS[g].menu : SECTION[g] ? SECTION[g].menu : g.replace(/^trim:/, '').replace(/_/g, ' '));

  const DEFAULTS = {
    brand: 'Soma Rosa Farms', kicker: 'Licensed Cannabis · Wholesale', title: 'Bulk Menu', place: 'Santa Rosa, California',
    blurb: 'Bulk cannabis from our licensed Santa Rosa facility, priced per pound and ready to move.',
    contact: 'Bobby McGowan', phone: '', email: 'bobby@somarosafarms.com', web: 'somarosafarms.com',
    notes: 'Prices per pound. Subject to availability. COAs available on request.',
    showBatch: true, showFarm: false, prices: {}, batches: {}
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const numOrNull = (v) => { const s = String(v == null ? '' : v).trim(); if (!s) return null; const n = Number(s); return Number.isFinite(n) && n >= 0 ? n : null; };
  const lbs = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
  const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const batchNo = (u) => { const s = String(u || '').replace(/\s+/g, ''); return s ? s.slice(-6) : '—'; };

  let ov = null, opts = null, s = null, sel = null, saveTimer = null;

  function injectAssets() {
    if (document.getElementById('bm-style')) return;
    const font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Rubik:wght@500;700;800;900&family=Roboto+Condensed:wght@400;700&display=swap';
    document.head.appendChild(font);
    const st = document.createElement('style');
    st.id = 'bm-style';
    st.textContent = `
    .bm-ov{position:fixed;inset:0;z-index:100;background:var(--bg);display:flex;flex-direction:column}
    .bm-bar{display:flex;align-items:center;gap:10px;padding:10px 16px;padding-top:calc(10px + env(safe-area-inset-top));background:var(--surface);border-bottom:1px solid var(--border);flex-wrap:wrap}
    .bm-bar h2{font-family:'Bebas Neue',sans-serif;font-size:26px;letter-spacing:.04em;font-weight:400;flex:1;min-width:120px}
    .bm-stat{font-family:'DM Mono',monospace;font-size:.68rem;color:var(--muted);width:100%;order:9}
    .bm-stat.err{color:var(--red)}
    .bm-body{flex:1;overflow:auto;display:grid;grid-template-columns:minmax(0,1fr)}
    @media (min-width:1100px){.bm-body{grid-template-columns:minmax(460px,600px) minmax(0,1fr);overflow:hidden}.bm-side,.bm-prev{overflow:auto}}
    .bm-side{padding:16px;display:grid;grid-template-columns:minmax(0,1fr);gap:22px;align-content:start}
    .bm-h{font-family:'DM Mono',monospace;font-size:.66rem;letter-spacing:.14em;text-transform:uppercase;color:var(--subtext);margin-bottom:8px}
    .bm-hint{font-size:.78rem;color:var(--muted);line-height:1.45;margin:-2px 0 10px}
    .bm-chips{display:flex;flex-wrap:wrap;gap:8px}
    .bm-chip{display:flex;align-items:center;gap:8px;border:1px solid var(--border);background:var(--surface);border-radius:10px;padding:8px 12px;cursor:pointer;font-size:.85rem;min-height:44px;user-select:none}
    .bm-chip.on{border-color:var(--green);background:var(--surface2)}
    .bm-chip small{font-family:'DM Mono',monospace;font-size:.66rem;color:var(--muted)}
    .bm-chip.empty{opacity:.45}
    .bm-prices{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}
    .bm-price{display:flex;flex-direction:column;gap:4px;font-size:.78rem;color:var(--subtext)}
    .bm-in{background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:.45rem .6rem;font-size:.9rem;min-height:38px;outline:none;width:100%;font-family:inherit}
    .bm-in:focus{border-color:var(--blue)}
    .bm-money{position:relative}
    .bm-money::before{content:'$';position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:.85rem}
    .bm-money .bm-in{padding-left:20px}
    .bm-sec{margin-bottom:14px;border:1px solid var(--border);border-radius:10px;overflow-x:auto}
    .bm-sech{display:flex;align-items:center;gap:8px;background:var(--surface2);padding:8px 10px;font-size:.85rem}
    .bm-sech b{flex:1}
    .bm-sech .mini{min-height:28px}
    .bm-tbl{width:100%;border-collapse:collapse;font-size:.8rem}
    .bm-tbl th{font-family:'DM Mono',monospace;font-size:.6rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:500;text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)}
    .bm-tbl td{padding:5px 8px;border-bottom:1px solid var(--border);vertical-align:middle}
    .bm-tbl tr:last-child td{border-bottom:none}
    .bm-tbl tr.off td{opacity:.4}
    .bm-tbl tr.off td:first-child{opacity:1}
    .bm-tbl .num{text-align:right;font-family:'DM Mono',monospace;white-space:nowrap}
    .bm-tbl .sm{font-family:'DM Mono',monospace;font-size:.64rem;color:var(--muted);line-height:1.35}
    .bm-tbl .bm-in{min-height:32px;padding:.3rem .45rem;font-size:.82rem;width:84px}
    .bm-tbl .bm-money .bm-in{padding-left:17px;width:92px}
    @media (max-width:520px){.bm-tbl .bm-in{width:62px}.bm-tbl .bm-money .bm-in{width:72px}.bm-tbl td,.bm-tbl th{padding-left:5px;padding-right:5px}.bm-tbl .sm{word-break:break-all}}
    .bm-tbl input[type=checkbox],.bm-chip input,.bm-opt input{width:18px;height:18px;accent-color:var(--green)}
    .bm-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
    .bm-form label{display:flex;flex-direction:column;gap:4px;font-size:.78rem;color:var(--subtext)}
    .bm-form label.wide{grid-column:1/-1}
    .bm-form textarea{resize:vertical;min-height:58px}
    .bm-opt{display:flex;align-items:center;gap:8px;font-size:.85rem;color:var(--subtext);min-height:36px;cursor:pointer}
    .bm-prev{padding:16px;background:#0a0c10;border-left:1px solid var(--border)}
    .bm-prev .bm-h{margin-bottom:10px}
    .bm-fit{overflow:hidden}
    .bm-scale{width:${MENU_W}px;transform-origin:0 0}

    /* The menu itself — the flyer's navy panels, magenta brand, gold and teal. */
    .bm-menu{width:${MENU_W}px;background:#262c4f;padding:14px;font-family:'Roboto Condensed','DM Sans',sans-serif;color:#fff;line-height:1.25}
    .bm-menu *{box-sizing:border-box}
    .bm-frame{border:3px solid #c42c86;background:#141a35;padding:10px;display:grid;gap:10px}
    .bm-pnl{position:relative;background:linear-gradient(180deg,#1c2348 0%,#151b38 100%);border:2px solid #303b69;border-radius:3px;padding:26px 30px}
    .bm-rv{position:absolute;width:9px;height:9px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#c9cfdf 0%,#7b8299 45%,#3a3f55 100%)}
    .bm-rv.a{top:7px;left:7px}.bm-rv.b{top:7px;right:7px}.bm-rv.c{bottom:7px;left:7px}.bm-rv.d{bottom:7px;right:7px}
    .bm-bars{height:6px;background:linear-gradient(90deg,#8a6a2a,#e9bd5c 30%,#f3d488 50%,#e9bd5c 70%,#8a6a2a);border-radius:2px}
    .bm-top{text-align:center;padding:30px 36px 28px}
    .bm-brand{display:flex;align-items:center;justify-content:center;gap:14px}
    .bm-brand span{font-family:'Rubik',sans-serif;font-weight:900;font-size:60px;letter-spacing:.01em;text-transform:uppercase;color:#ec2c9b;line-height:1;
      text-shadow:-2px -2px 0 #fff,2px -2px 0 #fff,-2px 2px 0 #fff,2px 2px 0 #fff,0 6px 0 #5e0f3b}
    .bm-kick{margin-top:22px;font-family:'Rubik',sans-serif;font-weight:800;font-size:34px;letter-spacing:.04em;text-transform:uppercase;color:#eab84f}
    .bm-title{font-family:'Rubik',sans-serif;font-weight:900;font-size:104px;line-height:.95;letter-spacing:.01em;text-transform:uppercase;color:#fff;text-shadow:0 5px 0 #0a0e22}
    .bm-cats{margin-top:8px;font-family:'Rubik',sans-serif;font-weight:800;font-size:34px;letter-spacing:.03em;text-transform:uppercase;color:#fff;text-shadow:0 3px 0 #0a0e22}
    .bm-place{margin-top:12px;font-size:26px;color:#eab84f}
    .bm-blurb{margin:6px auto 0;max-width:780px;font-size:22px;line-height:1.3;color:#eef0f7}
    .bm-secp{padding:24px 26px 22px}
    .bm-sh{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:6px}
    .bm-ban{position:relative;background:linear-gradient(180deg,#63d3e2 0%,#3fb2c6 55%,#2b93a8 100%);border:2px solid #b98f3f;color:#121731;
      font-family:'Rubik',sans-serif;font-weight:900;font-size:34px;letter-spacing:.02em;text-transform:uppercase;padding:8px 34px 6px}
    .bm-ban .bm-rv{width:7px;height:7px;top:50%;margin-top:-3.5px}
    .bm-ban .bm-rv.a{left:9px}.bm-ban .bm-rv.b{right:9px;left:auto}
    .bm-tag{background:linear-gradient(180deg,#f4cf76,#d8a13f);border:2px solid #8a6a2a;color:#1a1d33;font-family:'Rubik',sans-serif;font-weight:800;font-size:17px;
      letter-spacing:.04em;text-transform:uppercase;padding:6px 14px;border-radius:3px}
    .bm-desc{font-size:19px;color:#eab84f;margin:4px 0 10px}
    .bm-t{width:100%;border-collapse:collapse}
    .bm-t th{font-family:'Rubik',sans-serif;font-weight:700;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#eab84f;text-align:left;padding:8px 8px 6px;border-bottom:2px solid #303b69}
    .bm-t td{padding:9px 8px;border-bottom:1px dashed #2c3663;font-size:21px;vertical-align:middle}
    .bm-t tr:last-child td{border-bottom:none}
    .bm-t .r{text-align:right;white-space:nowrap}
    .bm-t .ck{color:#ec3f9e;font-weight:700;width:26px;padding-right:0;font-size:22px}
    .bm-t .st{font-weight:700;color:#fff}
    .bm-t .ty{font-size:17px;color:#cdd3e6}
    .bm-t .bn{font-size:16px;color:#9fb0d8;letter-spacing:.06em}
    .bm-t .fm{font-size:17px;color:#cdd3e6}
    .bm-t .lb{font-weight:700}
    .bm-t .lb small{font-size:14px;color:#9fb0d8;font-weight:400}
    .bm-t .pr{font-family:'Rubik',sans-serif;font-weight:800;color:#eab84f;font-size:22px}
    .bm-t .pr small{font-family:'Roboto Condensed',sans-serif;font-weight:400;font-size:14px;color:#cdb37a}
    .bm-t .pr.call{color:#cdd3e6;font-family:'Roboto Condensed',sans-serif;font-weight:700;font-size:18px;letter-spacing:.06em;text-transform:uppercase}
    .bm-foot{display:grid;grid-template-columns:1.05fr 1.2fr .6fr;gap:10px}
    .bm-foot .bm-pnl{padding:24px 26px;display:flex;flex-direction:column;justify-content:center}
    .bm-quote{display:inline-block;align-self:flex-start;background:linear-gradient(90deg,#d0287f 0%,#ef6f45 55%,#eab84f 100%);border:2px solid #f3d488;color:#151933;
      font-family:'Rubik',sans-serif;font-weight:900;font-size:36px;letter-spacing:.02em;text-transform:uppercase;padding:6px 20px}
    .bm-quote-t{margin-top:12px;font-size:21px;line-height:1.3;color:#eef0f7}
    .bm-ct{display:grid;gap:12px}
    .bm-ci{display:flex;align-items:center;gap:12px}
    .bm-ico{flex:0 0 auto;width:40px;height:40px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#f6d98e,#d29b3a 70%,#8a6a2a);display:flex;align-items:center;justify-content:center;border:2px solid #5e4a1f}
    .bm-ci b{display:block;font-family:'Rubik',sans-serif;font-weight:800;font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:#eab84f}
    .bm-ci span{font-size:20px;color:#fff}
    .bm-emb{align-items:center}
    .bm-fine{text-align:center;font-size:15px;color:#9fb0d8;padding:4px 10px 2px}
    `;
    document.head.appendChild(st);
  }

  // The flyer's eight-petal flower.
  function flower(size, center = '#7a0f4a') {
    const ring = (n, cy, rx, ry, fill, stroke) => Array.from({ length: n }, (_, i) =>
      `<ellipse cx="50" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(${i * (360 / n)} 50 50)" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="3"` : ''}/>`).join('');
    const dots = Array.from({ length: 8 }, (_, i) => {
      const a = (i * 45 + 22.5) * Math.PI / 180;
      return `<circle cx="${(50 + 7 * Math.cos(a)).toFixed(1)}" cy="${(50 + 7 * Math.sin(a)).toFixed(1)}" r="1.6" fill="#ffd1ea"/>`;
    }).join('');
    return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">${ring(8, 25, 13, 22, '#ec2c9b', '#fff')}${
      ring(8, 31, 6, 13, '#ff79c4')}<circle cx="50" cy="50" r="12" fill="${center}" stroke="#fff" stroke-width="2.5"/>${dots}</svg>`;
  }
  const ICON = {
    contact: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7z"/>',
    phone: '<path d="M7 3h3l1.6 4.3-2.1 1.5a11 11 0 0 0 5.7 5.7l1.5-2.1L21 14v3a2.5 2.5 0 0 1-2.6 2.5C10.2 19 5 13.8 4.5 5.6A2.5 2.5 0 0 1 7 3z"/>',
    email: '<rect x="3" y="6" width="18" height="13" rx="2" fill="none" stroke="#1a1d33" stroke-width="2.2"/><path d="M4 7.5l8 6 8-6" fill="none" stroke="#1a1d33" stroke-width="2.2"/>',
    web: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="#1a1d33" stroke-width="2"/><ellipse cx="12" cy="12" rx="3.8" ry="8.5" fill="none" stroke="#1a1d33" stroke-width="2"/><path d="M3.5 12h17M5 7.5h14M5 16.5h14" stroke="#1a1d33" stroke-width="1.8"/>'
  };
  const icon = (k) => `<div class="bm-ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="#1a1d33">${ICON[k]}</svg></div>`;
  const rivets = '<i class="bm-rv a"></i><i class="bm-rv b"></i><i class="bm-rv c"></i><i class="bm-rv d"></i>';

  // ── Shared settings ───────────────────────────────────────────────────────
  async function loadSettings() {
    try {
      const { data, error } = await opts.client.from('operations_forms').select('fields').eq('id', SETTINGS_ID).maybeSingle();
      if (error) throw error;
      const f = (data && data.fields) || {};
      return { ...DEFAULTS, ...f, prices: { ...(f.prices || {}) }, batches: { ...(f.batches || {}) } };
    } catch (ex) {
      console.error('bulk menu settings', ex);
      return { ...DEFAULTS, prices: {}, batches: {} };
    }
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    status(t(L.saving));
    saveTimer = setTimeout(save, 900);
  }
  async function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    // Batches that aren't on hand any more drop out.
    const live = new Set(opts.rows.map((r) => r.key));
    Object.keys(s.batches).forEach((k) => {
      const b = s.batches[k];
      if (!live.has(k) || (!b.off && b.lb == null && b.price == null)) delete s.batches[k];
    });
    const now = new Date().toISOString();
    const { error } = await opts.client.from('operations_forms').upsert({
      id: SETTINGS_ID, station_key: 'raw_inventory_menu', status: 'submitted', owner_user: opts.who || null, updated_by: opts.who || null,
      submitted_at: now, fields: { ...s, updatedBy: opts.who || '', updatedAt: now }
    });
    if (error) status(`${t(L.notSaved)} ${error.message || error}`, true); else status(t(L.saved));
  }
  function status(msg, err) {
    const el = ov && ov.querySelector('.bm-stat');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('err', !!err);
  }

  // ── What goes on the menu ─────────────────────────────────────────────────
  const batch = (k) => s.batches[k] || {};
  const setBatch = (k, x) => { s.batches[k] = { ...batch(k), ...x }; };
  const availOf = (r) => { const b = batch(r.key); return b.lb != null ? b.lb : r.lb; };
  const priceOf = (r) => { const b = batch(r.key); return b.price != null ? b.price : s.prices[groupOf(r)] != null ? s.prices[groupOf(r)] : null; };
  const rowsIn = (k) => opts.rows.filter((r) => r.tab === k)
    .sort((a, b) => groupMenu(groupOf(a)).localeCompare(groupMenu(groupOf(b))) || (a.strain || '').localeCompare(b.strain || '') || a.date.localeCompare(b.date));
  const onMenu = (r) => !batch(r.key).off && availOf(r) > 0.005;

  // ── Builder ───────────────────────────────────────────────────────────────
  async function open(o) {
    opts = o;
    injectAssets();
    // From a tab, that section; from All, every section with stock but Drying.
    const has = (k) => o.rows.some((r) => r.tab === k);
    sel = new Set(SECTION[o.tab] ? [o.tab] : SECTIONS.filter((x) => x.k !== 'drying' && has(x.k)).map((x) => x.k));
    ov = document.createElement('div');
    ov.className = 'bm-ov';
    ov.innerHTML = `<div class="bm-bar"><h2>${esc(t(L.head))}</h2>
        <button type="button" class="btn btn-blue" data-act="pdf">${esc(t(L.pdf))}</button>
        <button type="button" class="btn" data-act="close">${esc(t(L.close))}</button><div class="bm-stat"></div></div>
      <div class="bm-body"><div class="bm-side"><div class="empty">…</div></div>
        <div class="bm-prev"><div class="bm-h">${esc(t(L.preview))}</div><div class="bm-fit"><div class="bm-scale"></div></div></div></div>`;
    document.body.appendChild(ov);
    document.body.style.overflow = 'hidden';
    ov.querySelector('[data-act=close]').onclick = close;
    ov.querySelector('[data-act=pdf]').onclick = (e) => makePdf(e.currentTarget);
    window.addEventListener('resize', fit);
    s = await loadSettings();
    renderSide();
    renderMenu();
  }
  async function close() {
    if (saveTimer) await save();
    window.removeEventListener('resize', fit);
    document.body.style.overflow = '';
    ov.remove();
    ov = null;
  }

  function renderSide() {
    const side = ov.querySelector('.bm-side');
    const chips = SECTIONS.map((x) => {
      const list = opts.rows.filter((r) => r.tab === x.k);
      return `<label class="bm-chip ${sel.has(x.k) ? 'on' : ''} ${list.length ? '' : 'empty'}"><input type="checkbox" data-sec="${x.k}" ${sel.has(x.k) ? 'checked' : ''}>
        ${esc(t(x.l))} <small>${list.length} · ${fmtNum(list.reduce((a, r) => a + r.lb, 0), 0)} lb</small></label>`;
    }).join('');
    const shown = SECTIONS.filter((x) => sel.has(x.k));
    const groups = [...new Set(shown.flatMap((x) => rowsIn(x.k).map(groupOf)))];
    const prices = groups.map((g) => `<label class="bm-price">${esc(groupLabel(g))}
      <span class="bm-money"><input class="bm-in" type="number" inputmode="decimal" min="0" step="any" data-group="${esc(g)}" value="${s.prices[g] != null ? s.prices[g] : ''}"></span></label>`).join('');
    const secs = shown.map((x) => {
      const list = rowsIn(x.k);
      if (!list.length) return '';
      return `<div class="bm-sec"><div class="bm-sech"><b>${esc(t(x.l))}</b>
          <button type="button" class="mini" data-all="${x.k}">${esc(t(L.all))}</button><button type="button" class="mini" data-none="${x.k}">${esc(t(L.none))}</button></div>
        <table class="bm-tbl"><thead><tr><th></th><th>${esc(t(L.batch))}</th><th class="num">${esc(t(L.onHand))}</th><th>${esc(t(L.avail))}</th><th>${esc(t(L.perLb))}</th></tr></thead><tbody>${
        list.map((r) => {
          const b = batch(r.key), gp = s.prices[groupOf(r)];
          return `<tr class="${b.off ? 'off' : ''}" data-row="${esc(r.key)}"><td><input type="checkbox" data-inc="${esc(r.key)}" ${b.off ? '' : 'checked'}></td>
            <td><b>${esc(r.strain || '—')}</b><div class="sm">${esc(r.uid || '—')}</div><div class="sm">${esc([opts.typeLabel(r), r.farm].filter(Boolean).join(' · '))}</div></td>
            <td class="num">${fmtNum(r.lb)}${r.wet ? ` <span class="sm">${esc(t(L.wet))}</span>` : ''}</td>
            <td><input class="bm-in" type="number" inputmode="decimal" min="0" step="any" data-lb="${esc(r.key)}" placeholder="${esc(fmtNum(r.lb))}" value="${b.lb != null ? b.lb : ''}"></td>
            <td><span class="bm-money"><input class="bm-in" type="number" inputmode="decimal" min="0" step="any" data-price="${esc(r.key)}" placeholder="${gp != null ? esc(gp) : ''}" value="${b.price != null ? b.price : ''}"></span></td></tr>`;
        }).join('')}</tbody></table></div>`;
    }).join('');
    const field = (k, wide, area) => `<label class="${wide ? 'wide' : ''}">${esc(t(L[k]))}${area
      ? `<textarea class="bm-in" data-f="${k}">${esc(s[k])}</textarea>` : `<input class="bm-in" data-f="${k}" value="${esc(s[k])}">`}</label>`;
    side.innerHTML = `
      <div><div class="bm-h">${esc(t(L.sections))}</div><div class="bm-chips">${chips}</div></div>
      ${groups.length ? `<div><div class="bm-h">${esc(t(L.prices))}</div><div class="bm-hint">${esc(t(L.pricesHint))}</div><div class="bm-prices">${prices}</div></div>` : ''}
      <div><div class="bm-h">${esc(t(L.batches))}</div>${secs ? `<div class="bm-hint">${esc(t(L.batchHint))}</div>${secs}` : `<div class="bm-hint">${esc(t(L.nothing))}</div>`}</div>
      <div><div class="bm-h">${esc(t(L.details))}</div><div class="bm-form">
        ${field('brand')}${field('title')}${field('kicker', true)}${field('place')}${field('contact')}${field('phone')}${field('email')}${field('web')}
        ${field('blurb', true, true)}${field('notes', true, true)}
        <label class="bm-opt"><input type="checkbox" data-o="showBatch" ${s.showBatch ? 'checked' : ''}> ${esc(t(L.showBatch))}</label>
        <label class="bm-opt"><input type="checkbox" data-o="showFarm" ${s.showFarm ? 'checked' : ''}> ${esc(t(L.showFarm))}</label>
      </div></div>`;

    side.querySelectorAll('[data-sec]').forEach((el) => { el.onchange = () => { if (el.checked) sel.add(el.dataset.sec); else sel.delete(el.dataset.sec); renderSide(); renderMenu(); }; });
    side.querySelectorAll('[data-group]').forEach((el) => {
      el.oninput = () => {
        const g = el.dataset.group, v = numOrNull(el.value);
        if (v == null) delete s.prices[g]; else s.prices[g] = v;
        side.querySelectorAll('[data-price]').forEach((p) => {
          const r = opts.rows.find((x) => x.key === p.dataset.price);
          if (r && groupOf(r) === g) p.placeholder = v == null ? '' : v;
        });
        changed();
      };
    });
    side.querySelectorAll('[data-inc]').forEach((el) => {
      el.onchange = () => { setBatch(el.dataset.inc, { off: !el.checked }); el.closest('tr').classList.toggle('off', !el.checked); changed(); };
    });
    const pick = (k, on) => {
      rowsIn(k).forEach((r) => setBatch(r.key, { off: !on }));
      renderSide(); changed();
    };
    side.querySelectorAll('[data-all]').forEach((el) => { el.onclick = () => pick(el.dataset.all, true); });
    side.querySelectorAll('[data-none]').forEach((el) => { el.onclick = () => pick(el.dataset.none, false); });
    side.querySelectorAll('[data-lb]').forEach((el) => { el.oninput = () => { setBatch(el.dataset.lb, { lb: numOrNull(el.value) }); changed(); }; });
    side.querySelectorAll('[data-price]').forEach((el) => { el.oninput = () => { setBatch(el.dataset.price, { price: numOrNull(el.value) }); changed(); }; });
    side.querySelectorAll('[data-f]').forEach((el) => { el.oninput = () => { s[el.dataset.f] = el.value; changed(); }; });
    side.querySelectorAll('[data-o]').forEach((el) => { el.onchange = () => { s[el.dataset.o] = el.checked; changed(); }; });
  }
  function changed() { renderMenu(); saveSoon(); }

  // ── The menu ──────────────────────────────────────────────────────────────
  function menuHtml() {
    const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const secs = SECTIONS.filter((x) => sel.has(x.k)).map((x) => ({ x, list: rowsIn(x.k).filter(onMenu) })).filter((v) => v.list.length);
    const body = secs.map(({ x, list }) => {
      const multi = new Set(list.map(groupOf)).size > 1 || x.k === 'trim';
      const wet = list.some((r) => r.wet);
      const total = list.reduce((a, r) => a + availOf(r), 0);
      return `<div class="bm-pnl bm-secp">${rivets}
        <div class="bm-sh"><div class="bm-ban"><i class="bm-rv a"></i><i class="bm-rv b"></i>${esc(x.menu)}</div>
          <div class="bm-tag">${lbs(total)} lb${wet ? ' wet' : ''} · ${list.length} ${list.length === 1 ? 'batch' : 'batches'}</div></div>
        <div class="bm-desc">${esc(x.desc)}</div>
        <table class="bm-t"><thead><tr><th></th><th>Strain</th>${multi ? '<th>Type</th>' : ''}${s.showBatch ? '<th>Batch</th>' : ''}${s.showFarm ? '<th>Farm</th>' : ''}
          <th class="r">Available</th><th class="r">Price / lb</th></tr></thead><tbody>${list.map((r) => {
          const p = priceOf(r);
          return `<tr><td class="ck">✓</td><td class="st">${esc(r.strain || '—')}</td>${multi ? `<td class="ty">${esc(groupMenu(groupOf(r)))}</td>` : ''}${
            s.showBatch ? `<td class="bn">${esc(batchNo(r.uid))}</td>` : ''}${s.showFarm ? `<td class="fm">${esc(r.farm || '—')}</td>` : ''}
            <td class="r lb">${lbs(availOf(r))} <small>lb${r.wet ? ' wet' : ''}</small></td>
            <td class="r pr${p == null ? ' call' : ''}">${p == null ? 'Call' : `${money(p)}<small> /lb</small>`}</td></tr>`;
        }).join('')}</tbody></table></div>`;
    }).join('');
    const cats = secs.map((v) => v.x.menu).join(' · ');
    const contact = [['contact', 'Contact', s.contact], ['phone', 'Phone', s.phone], ['email', 'Email', s.email], ['web', 'Web', s.web]]
      .filter(([, , v]) => String(v || '').trim())
      .map(([k, l, v]) => `<div class="bm-ci">${icon(k)}<div><b>${l}</b><span>${esc(v)}</span></div></div>`).join('');
    return `<div class="bm-menu"><div class="bm-frame">
      <div class="bm-pnl bm-top">${rivets}
        <div class="bm-brand">${flower(68)}<span>${esc(s.brand)}</span></div>
        ${s.kicker ? `<div class="bm-kick">${esc(s.kicker)}</div>` : ''}
        <div class="bm-title">${esc(s.title)}</div>
        ${cats ? `<div class="bm-cats" style="font-size:${cats.length > 34 ? 26 : 34}px">${esc(cats)}</div>` : ''}
        <div class="bm-place">${esc([s.place, `Available ${date}`].filter(Boolean).join(' · '))}</div>
        ${s.blurb ? `<div class="bm-blurb">${esc(s.blurb)}</div>` : ''}
      </div>
      <div class="bm-bars"></div>
      ${body || `<div class="bm-pnl" style="text-align:center;color:#9fb0d8;font-size:22px">${rivets}Nothing on the menu yet.</div>`}
      <div class="bm-bars"></div>
      <div class="bm-foot">
        <div class="bm-pnl">${rivets}<div class="bm-quote">To Order</div><div class="bm-quote-t">Send the strains and pounds you want and we’ll confirm and invoice.</div></div>
        <div class="bm-pnl"><div class="bm-ct">${contact}</div>${rivets}</div>
        <div class="bm-pnl bm-emb">${rivets}${flower(130, '#3a0a26')}</div>
      </div>
      ${s.notes ? `<div class="bm-fine">${esc(s.notes)}</div>` : ''}
    </div></div>`;
  }
  function renderMenu() {
    ov.querySelector('.bm-scale').innerHTML = menuHtml();
    fit();
  }
  // Shrinks the preview to the pane's width.
  function fit() {
    if (!ov) return;
    const box = ov.querySelector('.bm-fit'), inner = ov.querySelector('.bm-scale');
    const k = Math.min(1, (box.clientWidth || MENU_W) / MENU_W);
    inner.style.transform = `scale(${k})`;
    box.style.height = `${inner.scrollHeight * k}px`;
  }

  // ── PDF ───────────────────────────────────────────────────────────────────
  let libs = null;
  function loadLibs() {
    const script = (src) => new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src; el.onload = resolve; el.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(el);
    });
    libs = libs || Promise.all([
      window.html2canvas ? null : script('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js'),
      window.jspdf ? null : script('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js')
    ]).catch((ex) => { libs = null; throw ex; });
    return libs;
  }
  async function makePdf(btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = t(L.making);
    // Drawn from an unscaled copy behind the builder.
    const host = document.createElement('div');
    host.style.cssText = `position:absolute;left:0;top:0;width:${MENU_W}px;z-index:-1;pointer-events:none`;
    host.innerHTML = menuHtml();
    document.body.appendChild(host);
    try {
      await loadLibs();
      if (document.fonts) {
        await Promise.all(['900 40px Rubik', '800 40px Rubik', '700 40px Rubik', '400 20px "Roboto Condensed"', '700 20px "Roboto Condensed"']
          .map((f) => document.fonts.load(f).catch(() => null)));
        await document.fonts.ready;
      }
      const el = host.firstElementChild;
      const w = el.offsetWidth, h = el.offsetHeight;
      // Phones cap a canvas at about 16.7 million pixels.
      const scale = Math.min(2, Math.sqrt(16e6 / (w * h)));
      const canvas = await window.html2canvas(el, { scale, useCORS: true, logging: false, backgroundColor: '#262c4f', scrollX: 0, scrollY: 0, windowWidth: Math.max(MENU_W, window.innerWidth) });
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: w >= h ? 'landscape' : 'portrait', unit: 'px', format: [w, h], hotfixes: ['px_scaling'] });
      doc.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, w, h);
      const name = `${(s.brand || 'Bulk').replace(/[^\w]+/g, '-')}-${(s.title || 'Menu').replace(/[^\w]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.pdf`;
      const file = new File([doc.output('blob')], name, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
        await navigator.share({ files: [file], title: `${s.brand} — ${s.title}` });
      } else {
        doc.save(name);
      }
      if (saveTimer) await save();
    } catch (ex) {
      if (ex.name !== 'AbortError') alert(`${t(L.pdfFail)} ${ex.message || ex}`);
    } finally {
      host.remove();
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  window.BulkMenu = { open };
})();
