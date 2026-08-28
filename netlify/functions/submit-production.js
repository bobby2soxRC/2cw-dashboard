// Receives a production-station record and commits it to GitHub, the same way
// submit-form.js handles the field-team forms:
//   - the record is appended to data/production/<stationKey>.json
//   - any photo is committed separately under data/production/uploads/<stationKey>/
//
// Records carry a clientId generated on the tablet. Because the forms queue
// offline and retry, the same record can arrive twice — the clientId is what
// makes the append idempotent.
//
// Requires GITHUB_TOKEN (fine-grained PAT, Contents: read/write on this repo)
// in the Netlify site config.

const OWNER = 'bobby2soxRC';
const REPO = '2cw-dashboard';
const BRANCH = 'main';
const API_ROOT = `https://api.github.com/repos/${OWNER}/${REPO}`;

const KNOWN_STATIONS = new Set([
  'cult_batch_log',
  'cult_ipm_feed',
  'cult_preharvest',
  'harvest',
  'intake_wet',
  'dry_check',
  'buck',
  'machine_trim',
  'hand_trim',
  'fresh_frozen',
  'biomass_request',
  'mfg_output'
]);

// Guards against a runaway tablet filling the repo with junk.
const MAX_FIELDS = 80;
const MAX_STRING = 4000;
const MAX_LINE_ITEMS = 400;

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': '2cw-dashboard-production'
  };
}

async function getFile(token, path) {
  const res = await fetch(`${API_ROOT}/contents/${path}?ref=${BRANCH}`, { headers: ghHeaders(token) });
  if (res.status === 404) return { exists: false, sha: null, json: null };
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    exists: true,
    sha: data.sha,
    json: JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'))
  };
}

async function putFile(token, path, { contentBase64, message, sha }) {
  const body = { message, content: contentBase64, branch: BRANCH };
  if (sha) body.sha = sha;
  return fetch(`${API_ROOT}/contents/${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function uploadPhoto(token, stationKey, id, dataUrl) {
  const match = /^data:(image\/\w+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw new Error('Bad photo data URL');
  const ext = match[1] === 'image/png' ? 'png' : 'jpg';
  const path = `data/production/uploads/${stationKey}/${id}.${ext}`;
  const res = await putFile(token, path, { contentBase64: match[2], message: `Production photo: ${stationKey}/${id}` });
  if (!res.ok) throw new Error(`GitHub photo upload failed: ${res.status} ${await res.text()}`);
  return `/${path}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Several stations submit at once during a shift change, so the read-modify-write
// on the stage file genuinely races. Re-read and retry on a 409 rather than
// dropping a count someone just walked across the floor to hand in.
async function appendRecord(token, stationKey, record) {
  const path = `data/production/${stationKey}.json`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const file = await getFile(token, path);
    const list = file.json || [];
    if (record.clientId && list.some((r) => r.clientId === record.clientId)) {
      return { duplicate: true };   // a queued retry that already landed
    }
    list.push(record);
    const res = await putFile(token, path, {
      contentBase64: Buffer.from(JSON.stringify(list, null, 2), 'utf-8').toString('base64'),
      message: `Production: ${stationKey} — ${record.strain || record.sku || 'record'} (${record.sessionUser || record.teamLead || 'unknown'})`,
      sha: file.sha
    });
    if (res.ok) return { duplicate: false };
    if (res.status === 409 || res.status === 422) {
      await sleep(200 * (attempt + 1) + Math.floor(Math.random() * 200));
      continue;
    }
    throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
  }
  throw new Error('GitHub write failed after retries (write contention)');
}

// Strings get trimmed and capped; everything else is passed through as-is so
// numbers stay numbers and the weighing worksheet stays an array of rows.
function sanitize(value, depth = 0) {
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (Array.isArray(value)) {
    if (depth > 1) return null;
    return value.slice(0, MAX_LINE_ITEMS).map((v) => sanitize(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth > 1) return null;
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, MAX_FIELDS)) out[k] = sanitize(v, depth + 1);
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Server missing GITHUB_TOKEN' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const { stationKey, fields, clientId, clientSubmittedAt } = payload;
  if (!KNOWN_STATIONS.has(stationKey) || !fields || typeof fields !== 'object') {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid production submission' }) };
  }
  if (Object.keys(fields).length > MAX_FIELDS) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Too many fields' }) };
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {};

  try {
    for (const [key, value] of Object.entries(fields)) {
      if (value && typeof value === 'object' && typeof value.dataUrl === 'string') {
        record[key] = await uploadPhoto(token, stationKey, `${id}-${key}`, value.dataUrl);
      } else {
        record[key] = sanitize(value);
      }
    }
    // Set last so a client can't spoof its own identity or timestamps.
    record.id = id;
    record.clientId = typeof clientId === 'string' ? clientId.slice(0, 64) : null;
    record.clientSubmittedAt = typeof clientSubmittedAt === 'string' ? clientSubmittedAt.slice(0, 40) : null;
    record.submittedAt = new Date().toISOString();
    record.stationKey = stationKey;

    const { duplicate } = await appendRecord(token, stationKey, record);
    return { statusCode: 200, body: JSON.stringify({ ok: true, id, duplicate }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};
