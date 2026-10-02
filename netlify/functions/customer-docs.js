// Customer documents — signed MSA, license(s), W-9 per customer — for the
// Information Hub's Customer IDs tab (information_hub.html).
//
// The files are in the PRIVATE Supabase Storage bucket `customer-docs`, and
// the customer_documents table has no anon policy (see supabase/schema.sql):
// a W-9 carries a tax ID, so the browser never gets to list or read either
// directly. Everything goes through here with the service role key, after
// checking the caller:
//   - a hub user sends their login PIN; it's looked up in app_users and their
//     'customer documents' (view) / 'customer documents edit' columns checked
//     — same scheme as canix-facilities.js;
//   - or the admin token from admin.js's login.
//
// Uploads don't pass through this function (Netlify caps request bodies at
// ~6 MB): `upload_url` hands back a one-time signed upload URL for a path
// this function chooses, the browser PUTs the file straight to Storage, then
// `save` records it. Downloads are signed URLs that expire in two minutes.
//
// Env vars: ADMIN_SIGNING_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (already set for admin.js / canix-facilities.js).

const crypto = require('crypto');

const BUCKET = 'customer-docs';
const DOC_TYPES = ['msa', 'license', 'w9'];
const MAX_BYTES = 25 * 1024 * 1024;
const TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function sign(secret, str) {
  return crypto.createHmac('sha256', secret).update(str).digest('hex');
}

function verifyToken(secret, token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = sign(secret, expStr);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function supa(supaUrl, serviceKey, path, opts = {}) {
  return fetch(`${supaUrl}${path}`, {
    ...opts,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {})
    }
  });
}

async function hubUser(supaUrl, serviceKey, pin) {
  const p = String(pin || '').trim();
  if (!p) return null;
  const res = await supa(supaUrl, serviceKey, '/rest/v1/app_users?active=eq.true&select=name,last_name,pin,columns');
  if (!res.ok) return null;
  return (await res.json()).find((x) => String(x.pin).padStart(4, '0') === p.padStart(4, '0')) || null;
}
const granted = (cols, key) => String((cols || {})[key] || '').toUpperCase() === 'TRUE';

// Storage keys: <customer uuid>/<type>/<random>-<cleaned file name>.
const cleanName = (n) => String(n || 'file').normalize('NFKD').replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(-80) || 'file';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const signingSecret = process.env.ADMIN_SIGNING_SECRET;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!signingSecret || !supaUrl || !serviceKey) {
    return json(500, { ok: false, error: 'Server missing ADMIN_SIGNING_SECRET / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }
  const action = String(payload.action || '');

  // Who's asking, and may they?
  let who = 'admin', canEdit = true;
  if (!verifyToken(signingSecret, payload.token)) {
    const u = await hubUser(supaUrl, serviceKey, payload.pin);
    canEdit = !!u && granted(u.columns, 'customer documents edit');
    const canView = canEdit || (!!u && granted(u.columns, 'customer documents'));
    if (!canView) return json(403, { ok: false, error: 'You don’t have access to customer documents.' });
    who = [u.name, u.last_name].filter(Boolean).join(' ');
  }
  const writes = ['upload_url', 'save', 'delete'];
  if (writes.includes(action) && !canEdit) return json(403, { ok: false, error: 'You don’t have edit access to customer documents.' });

  try {
    if (action === 'list') {
      const res = await supa(supaUrl, serviceKey, '/rest/v1/customer_documents?select=*&order=doc_type.asc,created_at.desc');
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true, docs: await res.json(), canEdit });
    }

    if (action === 'upload_url') {
      const { ref_code_id, doc_type, file_name, content_type, size_bytes } = payload;
      if (!UUID_RE.test(String(ref_code_id || ''))) return json(400, { ok: false, error: 'Missing customer' });
      if (!DOC_TYPES.includes(doc_type)) return json(400, { ok: false, error: 'Unknown document type' });
      if (!TYPES.includes(content_type)) return json(400, { ok: false, error: 'Upload a PDF or a photo (JPG, PNG, HEIC, WebP).' });
      if (!(Number(size_bytes) > 0) || Number(size_bytes) > MAX_BYTES) return json(400, { ok: false, error: 'Files must be under 25 MB.' });
      const cust = await supa(supaUrl, serviceKey, `/rest/v1/ref_codes?id=eq.${ref_code_id}&kind=eq.cid&select=id`);
      if (!cust.ok) throw new Error(`Customer lookup failed: ${cust.status} ${await cust.text()}`);
      if (!(await cust.json()).length) return json(404, { ok: false, error: 'No customer with that id' });
      const path = `${ref_code_id}/${doc_type}/${crypto.randomUUID()}-${cleanName(file_name)}`;
      const res = await supa(supaUrl, serviceKey, `/storage/v1/object/upload/sign/${BUCKET}/${path}`, { method: 'POST', body: '{}' });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const { url } = await res.json();
      const token = new URL(url, 'http://x').searchParams.get('token');
      if (!token) throw new Error('Storage did not return an upload token');
      return json(200, { ok: true, bucket: BUCKET, path, token });
    }

    if (action === 'save') {
      const d = payload.doc || {};
      // Only a path upload_url could have issued, and only once the file is there.
      const m = String(d.storage_path || '').match(/^([0-9a-f-]{36})\/(msa|license|w9)\/[0-9a-f-]{36}-[\w.\-]+$/i);
      if (!m || m[1] !== d.ref_code_id || m[2] !== d.doc_type) return json(400, { ok: false, error: 'Bad storage path' });
      const head = await supa(supaUrl, serviceKey, `/storage/v1/object/info/${BUCKET}/${d.storage_path}`);
      if (!head.ok) return json(400, { ok: false, error: 'The file didn’t finish uploading — try again.' });
      const body = {
        ref_code_id: d.ref_code_id,
        doc_type: d.doc_type,
        label: String(d.label || '').trim() || null,
        doc_date: DATE_RE.test(d.doc_date || '') ? d.doc_date : null,
        expires_on: DATE_RE.test(d.expires_on || '') ? d.expires_on : null,
        file_name: String(d.file_name || '').slice(0, 200) || 'file',
        storage_path: d.storage_path,
        content_type: d.content_type || null,
        size_bytes: Number(d.size_bytes) || null,
        uploaded_by: who
      };
      const res = await supa(supaUrl, serviceKey, '/rest/v1/customer_documents', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true, doc: (await res.json())[0] });
    }

    if (action === 'download_url') {
      if (!UUID_RE.test(String(payload.id || ''))) return json(400, { ok: false, error: 'Missing id' });
      const r = await supa(supaUrl, serviceKey, `/rest/v1/customer_documents?id=eq.${payload.id}&select=storage_path,file_name`);
      const doc = r.ok ? (await r.json())[0] : null;
      if (!doc) return json(404, { ok: false, error: 'Document not found' });
      const res = await supa(supaUrl, serviceKey, `/storage/v1/object/sign/${BUCKET}/${doc.storage_path}`, {
        method: 'POST', body: JSON.stringify({ expiresIn: 120 })
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const { signedURL } = await res.json();
      const dl = payload.download ? `&download=${encodeURIComponent(doc.file_name)}` : '';
      return json(200, { ok: true, url: `${supaUrl}/storage/v1${signedURL}${dl}` });
    }

    // The cultivation license / W-9 a client attached on the public drying
    // request form (drying_request.html -> drying-request.js), shown on the
    // Drying Schedule. Read-only here; same view permission as above.
    if (action === 'request_docs') {
      if (!UUID_RE.test(String(payload.intake_id || ''))) return json(400, { ok: false, error: 'Missing request' });
      const res = await supa(supaUrl, serviceKey, `/rest/v1/drying_request_docs?intake_id=eq.${payload.intake_id}&select=id,doc_type,file_name,size_bytes,created_at&order=doc_type.asc,created_at.desc`);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true, docs: await res.json() });
    }

    if (action === 'request_doc_url') {
      if (!UUID_RE.test(String(payload.id || ''))) return json(400, { ok: false, error: 'Missing id' });
      const r = await supa(supaUrl, serviceKey, `/rest/v1/drying_request_docs?id=eq.${payload.id}&select=storage_path,file_name`);
      const doc = r.ok ? (await r.json())[0] : null;
      if (!doc) return json(404, { ok: false, error: 'Document not found' });
      const res = await supa(supaUrl, serviceKey, `/storage/v1/object/sign/${BUCKET}/${doc.storage_path}`, {
        method: 'POST', body: JSON.stringify({ expiresIn: 120 })
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const { signedURL } = await res.json();
      return json(200, { ok: true, url: `${supaUrl}/storage/v1${signedURL}` });
    }

    if (action === 'delete') {
      if (!UUID_RE.test(String(payload.id || ''))) return json(400, { ok: false, error: 'Missing id' });
      const r = await supa(supaUrl, serviceKey, `/rest/v1/customer_documents?id=eq.${payload.id}&select=storage_path`);
      const doc = r.ok ? (await r.json())[0] : null;
      if (!doc) return json(404, { ok: false, error: 'Document not found' });
      const del = await supa(supaUrl, serviceKey, `/storage/v1/object/${BUCKET}`, {
        method: 'DELETE', body: JSON.stringify({ prefixes: [doc.storage_path] })
      });
      if (!del.ok) throw new Error(`${del.status} ${await del.text()}`);
      const res = await supa(supaUrl, serviceKey, `/rest/v1/customer_documents?id=eq.${payload.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return json(200, { ok: true });
    }

    return json(400, { ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    return json(502, { ok: false, error: String(err.message || err) });
  }
};
