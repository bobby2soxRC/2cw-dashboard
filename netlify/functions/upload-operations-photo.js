// Uploads one operations-form photo to GitHub and returns its URL. Split out
// from the old submit-operations.js because photo storage still lives in
// git (durable, versioned, and it's exactly what the field-forms photos
// already do) while the form records themselves now live in Supabase —
// this is the one place those two storage systems meet.
//
// Requires GITHUB_TOKEN (same fine-grained PAT already used by the other
// operations/field-form functions) in the Netlify site config.

const OWNER = 'bobby2soxRC';
const REPO = '2cw-dashboard';
const BRANCH = 'main';
const API_ROOT = `https://api.github.com/repos/${OWNER}/${REPO}`;

const KNOWN_STATIONS = new Set([
  'cult_batch_log', 'cult_ipm_feed', 'cult_preharvest',
  'harvest', 'intake_wet', 'dry_check', 'buck', 'machine_trim',
  'hand_trim', 'fresh_frozen', 'biomass_request', 'mfg_output'
]);

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': '2cw-dashboard-operations'
  };
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

  const { stationKey, id, fieldKey, dataUrl } = payload;
  if (!KNOWN_STATIONS.has(stationKey) || !id || !fieldKey || typeof dataUrl !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid photo upload' }) };
  }
  // id comes from the client (a draft uuid) and lands in a file path —
  // keep it to the shape we actually generate so it can't walk the path.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id)) || !/^[A-Za-z0-9_]{1,64}$/.test(String(fieldKey))) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid id or field key' }) };
  }

  const match = /^data:(image\/\w+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Bad photo data URL' }) };
  const ext = match[1] === 'image/png' ? 'png' : 'jpg';
  const path = `data/operations/uploads/${stationKey}/${id}-${fieldKey}.${ext}`;

  try {
    const res = await fetch(`${API_ROOT}/contents/${path}`, {
      method: 'PUT',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Operations photo: ${stationKey}/${id}-${fieldKey}`,
        content: match[2],
        branch: BRANCH
      })
    });
    if (!res.ok) throw new Error(`GitHub photo upload failed: ${res.status} ${await res.text()}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, url: `/${path}` }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};
