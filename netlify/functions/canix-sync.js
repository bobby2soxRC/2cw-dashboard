// "Run Canix Sync now" — admin panel backend (admin.html's "Data Syncs" tab).
//
// The Canix sync runs as a GitHub Actions workflow
// (.github/workflows/canix_sync.yml, every 3 hours). This starts that same
// workflow on demand through GitHub's workflow_dispatch API, and lists its
// recent runs so the admin can see whether it finished. Nothing runs here:
// the sync itself still happens on GitHub, with GitHub's secrets.
//
// Gated by the same admin token as admin.js (ADMIN_SIGNING_SECRET).
//
// Required env vars (Netlify site config):
//   ADMIN_SIGNING_SECRET  same as admin.js — verifies the admin token
//   GITHUB_TOKEN          fine-grained personal access token for the
//                         2cw-dashboard repo with "Actions: Read and write"
//   GITHUB_REPO           optional, defaults to bobby2soxRC/2cw-dashboard

const crypto = require('crypto');

const WORKFLOW = 'canix_sync.yml';
const BRANCH = 'main';

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

async function gh(ghToken, path, opts = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${ghToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': '2cw-dashboard',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {})
    }
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  const signingSecret = process.env.ADMIN_SIGNING_SECRET;
  const ghToken = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || 'bobby2soxRC/2cw-dashboard';
  if (!signingSecret) return json(500, { ok: false, error: 'Server missing ADMIN_SIGNING_SECRET' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  if (!verifyToken(signingSecret, payload.token)) {
    return json(401, { ok: false, error: 'Session expired — please sign in again' });
  }
  if (!ghToken) {
    return json(500, { ok: false, error: 'GITHUB_TOKEN is not set in Netlify — see "Data Syncs" in docs/USER_ADMIN.md' });
  }

  const base = `/repos/${repo}/actions/workflows/${WORKFLOW}`;
  try {
    if (payload.action === 'run') {
      const res = await gh(ghToken, `${base}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: BRANCH }) });
      if (res.status !== 204) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
      return json(200, { ok: true });
    }

    if (payload.action === 'status') {
      const res = await gh(ghToken, `${base}/runs?per_page=5`);
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
      const runs = ((await res.json()).workflow_runs || []).map((r) => ({
        id: r.id,
        event: r.event,              // schedule | workflow_dispatch
        status: r.status,            // queued | in_progress | completed
        conclusion: r.conclusion,    // success | failure | cancelled | null
        started: r.run_started_at || r.created_at,
        updated: r.updated_at,
        url: r.html_url
      }));
      return json(200, { ok: true, runs });
    }

    return json(400, { ok: false, error: 'Unknown action' });
  } catch (e) {
    return json(502, { ok: false, error: String(e.message || e) });
  }
};
