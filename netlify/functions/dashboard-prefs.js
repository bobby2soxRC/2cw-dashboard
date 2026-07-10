// Saves and fetches each user's hub card customization (hidden cards + custom
// order) by committing straight to data/dashboard_prefs.json on GitHub — same
// pattern as submit-form.js / commission-reports.js.
// Requires a GITHUB_TOKEN env var set in Netlify site config.
//
// Prefs never contain card keys — a client can only ever hide/reorder cards
// it already knows about (it built the request from cards the directory sheet
// already granted it), and the server does no authorization filtering of its
// own. This endpoint is purely "remember what this user arranged," not a
// source of access control.

const OWNER = 'bobby2soxRC';
const REPO = '2cw-dashboard';
const BRANCH = 'main';
const API_ROOT = `https://api.github.com/repos/${OWNER}/${REPO}`;
const PREFS_PATH = 'data/dashboard_prefs.json';

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': '2cw-dashboard-prefs'
  };
}

async function getFile(token) {
  const res = await fetch(`${API_ROOT}/contents/${PREFS_PATH}?ref=${BRANCH}`, {
    headers: ghHeaders(token)
  });
  if (res.status === 404) return { exists: false, sha: null, json: {} };
  if (!res.ok) throw new Error(`GitHub GET ${PREFS_PATH} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { exists: true, sha: data.sha, json: JSON.parse(content || '{}') };
}

async function putFile(token, map, { message, sha }) {
  const contentBase64 = Buffer.from(JSON.stringify(map, null, 2), 'utf-8').toString('base64');
  const body = { message, content: contentBase64, branch: BRANCH };
  if (sha) body.sha = sha;
  return fetch(`${API_ROOT}/contents/${PREFS_PATH}`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function userKey(name) {
  return String(name || '').trim().toLowerCase();
}

exports.handler = async (event) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Server missing GITHUB_TOKEN' }) };
  }

  if (event.httpMethod === 'GET') {
    const user = (event.queryStringParameters || {}).user;
    if (!user) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing user' }) };
    try {
      const file = await getFile(token);
      const prefs = file.json[userKey(user)] || { hidden: [], order: [] };
      return { statusCode: 200, body: JSON.stringify({ ok: true, prefs }) };
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

  const { user, hidden, order } = payload;
  const key = userKey(user);
  if (!key) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing user' }) };
  if (!Array.isArray(hidden) || !Array.isArray(order) || !hidden.every(x => typeof x === 'string') || !order.every(x => typeof x === 'string')) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'hidden/order must be string arrays' }) };
  }

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const file = await getFile(token);
      const map = file.json || {};
      map[key] = { hidden, order, updatedAt: new Date().toISOString() };
      const res = await putFile(token, map, {
        message: `Dashboard prefs: ${key}`,
        sha: file.sha
      });
      if (res.ok) return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      if (res.status === 409 && attempt === 0) continue; // sha race — retry once
      throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};
