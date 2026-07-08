// Receives a field-team form submission and commits it straight to GitHub:
//   - text fields get appended as a record in data/form_submissions/<formKey>.json
//   - any photo fields get committed as separate image files under data/form_uploads/<formKey>/
// Requires a GITHUB_TOKEN env var (fine-grained PAT, Contents: read/write on this repo only)
// set in Netlify site config — this function does nothing without it.

const OWNER = 'bobby2soxRC';
const REPO = '2cw-dashboard';
const BRANCH = 'main';
const API_ROOT = `https://api.github.com/repos/${OWNER}/${REPO}`;

const KNOWN_FORMS = new Set([
  'budtender_training',
  'buyer_meeting',
  'staff_sample',
  'store_visit'
]);

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': '2cw-dashboard-forms'
  };
}

async function getFile(token, path) {
  const res = await fetch(`${API_ROOT}/contents/${path}?ref=${BRANCH}`, {
    headers: ghHeaders(token)
  });
  if (res.status === 404) return { exists: false, sha: null, json: null };
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { exists: true, sha: data.sha, json: JSON.parse(content) };
}

async function putFile(token, path, { contentBase64, message, sha }) {
  const body = { message, content: contentBase64, branch: BRANCH };
  if (sha) body.sha = sha;
  const res = await fetch(`${API_ROOT}/contents/${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res;
}

async function uploadPhoto(token, formKey, id, fieldKey, dataUrl) {
  const match = /^data:(image\/\w+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw new Error(`Bad photo data URL for field "${fieldKey}"`);
  const ext = match[1] === 'image/png' ? 'png' : 'jpg';
  const path = `data/form_uploads/${formKey}/${id}-${fieldKey}.${ext}`;
  const res = await putFile(token, path, {
    contentBase64: match[2],
    message: `Field form photo: ${formKey}/${id}-${fieldKey}`
  });
  if (!res.ok) throw new Error(`GitHub photo upload failed: ${res.status} ${await res.text()}`);
  return `/${path}`;
}

async function appendSubmission(token, formKey, record) {
  const path = `data/form_submissions/${formKey}.json`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = await getFile(token, path);
    const list = file.json || [];
    list.push(record);
    const contentBase64 = Buffer.from(JSON.stringify(list, null, 2), 'utf-8').toString('base64');
    const res = await putFile(token, path, {
      contentBase64,
      message: `Field form submission: ${formKey} (${record.repName || 'unknown rep'})`,
      sha: file.sha
    });
    if (res.ok) return;
    if (res.status === 409 && attempt === 0) continue; // sha race — retry once
    throw new Error(`GitHub submission write failed: ${res.status} ${await res.text()}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

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

  const { formKey, fields } = payload;
  if (!KNOWN_FORMS.has(formKey) || !fields || typeof fields !== 'object') {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid form submission' }) };
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record = { id, submittedAt: new Date().toISOString() };

  try {
    for (const [key, value] of Object.entries(fields)) {
      if (value && typeof value === 'object' && typeof value.dataUrl === 'string') {
        record[key] = await uploadPhoto(token, formKey, id, key, value.dataUrl);
      } else {
        record[key] = value;
      }
    }
    // Re-assert after the fields loop so a client can't spoof its own id/timestamp.
    record.id = id;
    record.submittedAt = new Date().toISOString();
    await appendSubmission(token, formKey, record);
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, id }) };
};
