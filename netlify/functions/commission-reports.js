// Saves, lists, and deletes generated commission reports by committing
// straight to data/commission_reports.json on GitHub — same pattern as
// submit-form.js. Requires a GITHUB_TOKEN env var set in Netlify site config.

const OWNER = 'bobby2soxRC';
const REPO = '2cw-dashboard';
const BRANCH = 'main';
const API_ROOT = `https://api.github.com/repos/${OWNER}/${REPO}`;
const REPORTS_PATH = 'data/commission_reports.json';
const ADMIN_REP = 'niki';

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': '2cw-dashboard-commission-reports'
  };
}

async function getFile(token) {
  const res = await fetch(`${API_ROOT}/contents/${REPORTS_PATH}?ref=${BRANCH}`, {
    headers: ghHeaders(token)
  });
  if (res.status === 404) return { exists: false, sha: null, json: [] };
  if (!res.ok) throw new Error(`GitHub GET ${REPORTS_PATH} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { exists: true, sha: data.sha, json: JSON.parse(content || '[]') };
}

async function putFile(token, list, { message, sha }) {
  const contentBase64 = Buffer.from(JSON.stringify(list, null, 2), 'utf-8').toString('base64');
  const body = { message, content: contentBase64, branch: BRANCH };
  if (sha) body.sha = sha;
  return fetch(`${API_ROOT}/contents/${REPORTS_PATH}`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

// Mutates the current list via `mutate(list) => newList` and retries once on a sha race.
async function withRetry(token, message, mutate) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = await getFile(token);
    const newList = mutate(file.json || []);
    const res = await putFile(token, newList, { message, sha: file.sha });
    if (res.ok) return newList;
    if (res.status === 409 && attempt === 0) continue; // sha race — retry once
    throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
  }
}

exports.handler = async (event) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Server missing GITHUB_TOKEN' }) };
  }

  if (event.httpMethod === 'GET') {
    try {
      const file = await getFile(token);
      return { statusCode: 200, body: JSON.stringify({ ok: true, reports: file.json }) };
    } catch (err) {
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
    }
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const { action, rep } = payload;
  if (!rep || typeof rep !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing rep' }) };
  }

  if (action === 'save') {
    const { report } = payload;
    if (!report || typeof report !== 'object') {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing report' }) };
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = { ...report, id, rep, savedAt: new Date().toISOString() };
    try {
      await withRetry(token, `Save commission report: ${rep} (${record.periodLabel || record.periodId || ''})`, list => {
        list.push(record);
        return list;
      });
    } catch (err) {
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, id }) };
  }

  if (action === 'delete') {
    const { id } = payload;
    if (!id) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing id' }) };
    try {
      let found = false, allowed = true;
      await withRetry(token, `Delete commission report: ${id}`, list => {
        const target = list.find(r => r.id === id);
        found = !!target;
        if (!target) return list;
        allowed = target.rep === rep || rep === ADMIN_REP;
        if (!allowed) return list;
        return list.filter(r => r.id !== id);
      });
      if (!found) return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Report not found' }) };
      if (!allowed) return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not your report' }) };
    } catch (err) {
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
};
