// "Forgot your PIN?" — emails a reset link, then lets the person pick a new
// PIN from that link (reset_pin.html is the page on both ends).
//
//   POST {action:'request', email}     -> always {ok:true}; emails a link if
//                                         an active user has that address
//   POST {action:'check', token}       -> {ok:true, name} if the link is good
//   POST {action:'reset', token, pin}  -> {ok:true} once the PIN is changed
//
// The link carries a stateless token: base64url({u: user id, e: expiry}) plus
// an HMAC over that payload *and the user's current PIN*. Changing the PIN
// changes what the HMAC should be, so a link stops working the moment it's
// used (or the admin changes the PIN) — no token table needed.
//
// 'request' never says whether the email matched anyone, so the form can't
// be used to find out who has an account. It also skips sending if this
// person was sent a link in the last minute.
//
// Required env vars (Netlify site config), none shared with the browser:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   same as admin.js
//   ADMIN_SIGNING_SECRET                      reused to sign reset tokens
//                                             (domain-separated from admin tokens)
//   RESEND_API_KEY                            from resend.com -> API Keys
//   RESEND_FROM                               e.g. "2CW Productions <noreply@yourdomain.com>"
//                                             — must be on a domain verified in Resend
// URL (the site's own address) is set by Netlify automatically.

const crypto = require('crypto');

const LINK_TTL_MS = 30 * 60 * 1000;   // 30 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // one email a minute per person
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64url = (s) => Buffer.from(s, 'base64url').toString('utf8');

function sign(secret, payload, pin) {
  return crypto.createHmac('sha256', secret).update(`pin-reset:${payload}:${pin}`).digest('base64url');
}

function issueLinkToken(secret, user) {
  const payload = b64url(JSON.stringify({ u: user.id, e: Date.now() + LINK_TTL_MS }));
  return `${payload}.${sign(secret, payload, user.pin)}`;
}

// Returns {userId, payload, sig} if the token is well-formed and unexpired —
// the signature itself can only be checked once the user's current PIN is
// loaded, see verifySig().
function parseLinkToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const { u, e } = JSON.parse(unb64url(parts[0]));
    if (typeof u !== 'string' || !Number.isFinite(e) || e < Date.now()) return null;
    return { userId: u, payload: parts[0], sig: parts[1] };
  } catch { return null; }
}

function verifySig(secret, parsed, pin) {
  const a = Buffer.from(parsed.sig, 'utf8');
  const b = Buffer.from(sign(secret, parsed.payload, pin), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function supaFetch(supaUrl, serviceKey, path, opts = {}) {
  return fetch(`${supaUrl}/rest/v1/${path}`, {
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

async function userFromToken(env, token) {
  const parsed = parseLinkToken(token);
  if (!parsed) return null;
  const res = await supaFetch(env.supaUrl, env.serviceKey,
    `app_users?id=eq.${encodeURIComponent(parsed.userId)}&active=eq.true&select=id,name,pin`);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const [user] = await res.json();
  if (!user || !verifySig(env.secret, parsed, user.pin)) return null;
  return user;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendResetEmail(env, to, user, link) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.resendFrom,
      to: [to],
      subject: 'Reset your 2CW Productions PIN',
      text: `Hi ${user.name},\n\nUse this link to choose a new PIN for the 2CW Productions dashboard. It works once and expires in 30 minutes:\n\n${link}\n\nIf you didn't ask for this, you can ignore this email — your PIN hasn't changed.`,
      html: `<p>Hi ${escapeHtml(user.name)},</p>
<p>Use the button below to choose a new PIN for the 2CW Productions dashboard. The link works once and expires in 30 minutes.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#3db87a;color:#0c0d0f;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Choose a new PIN</a></p>
<p style="color:#666;font-size:13px">Or paste this into your browser: ${escapeHtml(link)}</p>
<p style="color:#666;font-size:13px">If you didn't ask for this, you can ignore this email — your PIN hasn't changed.</p>`
    })
  });
  if (!res.ok) throw new Error(`Resend ${res.status} ${await res.text()}`);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const env = {
    supaUrl: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    secret: process.env.ADMIN_SIGNING_SECRET,
    resendKey: process.env.RESEND_API_KEY,
    resendFrom: process.env.RESEND_FROM,
    siteUrl: (process.env.URL || '').replace(/\/$/, '')
  };
  if (!env.supaUrl || !env.serviceKey || !env.secret) {
    return json(500, { ok: false, error: 'PIN reset is not set up yet (server is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ADMIN_SIGNING_SECRET)' });
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }
  const { action } = payload;

  try {
    if (action === 'request') {
      if (!env.resendKey || !env.resendFrom) {
        return json(500, { ok: false, error: 'PIN reset emails are not set up yet — ask an admin to reset your PIN.' });
      }
      const email = String(payload.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return json(400, { ok: false, error: 'Enter a valid email address' });

      const res = await supaFetch(env.supaUrl, env.serviceKey,
        `app_users?email=eq.${encodeURIComponent(email)}&active=eq.true&select=id,name,pin,pin_reset_sent_at`);
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const [user] = await res.json();

      const recentlySent = user && user.pin_reset_sent_at &&
        Date.now() - new Date(user.pin_reset_sent_at).getTime() < RESEND_COOLDOWN_MS;
      if (user && !recentlySent) {
        const origin = env.siteUrl || `https://${event.headers.host}`;
        const link = `${origin}/reset_pin.html?token=${encodeURIComponent(issueLinkToken(env.secret, user))}`;
        await sendResetEmail(env, email, user, link);
        await supaFetch(env.supaUrl, env.serviceKey, `app_users?id=eq.${encodeURIComponent(user.id)}`, {
          method: 'PATCH', body: JSON.stringify({ pin_reset_sent_at: new Date().toISOString() })
        });
      }
      return json(200, { ok: true });
    }

    if (action === 'check') {
      const user = await userFromToken(env, payload.token);
      if (!user) return json(400, { ok: false, error: 'This link has expired or was already used. Request a new one.' });
      return json(200, { ok: true, name: user.name });
    }

    if (action === 'reset') {
      const pin = String(payload.pin || '').trim();
      if (!/^\d{4}$/.test(pin)) return json(400, { ok: false, error: 'Your PIN must be exactly 4 digits' });
      const user = await userFromToken(env, payload.token);
      if (!user) return json(400, { ok: false, error: 'This link has expired or was already used. Request a new one.' });
      if (pin === String(user.pin)) return json(400, { ok: false, error: 'That\'s your current PIN — choose a different one' });

      // PINs double as usernames (login is PIN-only), so they must be unique.
      const taken = await supaFetch(env.supaUrl, env.serviceKey,
        `app_users?pin=eq.${encodeURIComponent(pin)}&active=eq.true&id=neq.${encodeURIComponent(user.id)}&select=id`);
      if (!taken.ok) throw new Error(`${taken.status} ${await taken.text()}`);
      if ((await taken.json()).length) return json(409, { ok: false, error: 'That PIN isn\'t available — choose a different one' });

      const res = await supaFetch(env.supaUrl, env.serviceKey, `app_users?id=eq.${encodeURIComponent(user.id)}`, {
        method: 'PATCH', body: JSON.stringify({ pin, pin_reset_sent_at: null })
      });
      if (!res.ok) {
        const text = await res.text();
        if (text.includes('23505')) return json(409, { ok: false, error: 'That PIN isn\'t available — choose a different one' });
        throw new Error(`${res.status} ${text}`);
      }
      return json(200, { ok: true });
    }

    return json(400, { ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('pin-reset', err);
    return json(502, { ok: false, error: 'Something went wrong — try again, or ask an admin to reset your PIN.' });
  }
};
