// Proxies short text translation requests to DeepL so the API key never
// reaches the browser. Used by my_tasks.html and task_oversight.html to
// translate task titles/descriptions/notes between English and Spanish
// (per-task "Translate" buttons and the CSV export language picker).
//
// No admin gate — same open posture as the personal_tasks table itself
// this only ever forwards short free-text task fields, never credentials.
//
// Required env var: DEEPL_API_KEY — a DeepL API key (Project Settings in
// your DeepL account). Sign up for the free "DeepL API Free" plan at
// deepl.com/pro-api (500,000 characters/month free) if you don't have one.
// Free-plan keys end in ":fx" and must hit api-free.deepl.com; a paid Pro
// key hits api.deepl.com — detected automatically from the key itself, so
// upgrading plans later needs a new key, not a code change.

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function hostForKey(key) {
  return key.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
}

// DeepL wants a region-specific code for English ('EN' alone is rejected as
// a target_lang); only one Spanish variant exists so 'ES' is unambiguous.
const TARGET_LANGS = { en: 'EN-US', es: 'ES' };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  const apiKey = process.env.DEEPL_API_KEY;
  if (!apiKey) {
    return json(500, { ok: false, error: 'Translation is not set up yet — ask an admin to add DEEPL_API_KEY in Netlify.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const rawTexts = Array.isArray(payload.texts) ? payload.texts : null;
  const targetLang = TARGET_LANGS[String(payload.target || '').toLowerCase()];
  if (!rawTexts || !rawTexts.length) return json(400, { ok: false, error: 'texts must be a non-empty array of strings' });
  if (rawTexts.length > 50) return json(400, { ok: false, error: 'Too many strings in one request (max 50)' });
  if (!targetLang) return json(400, { ok: false, error: "target must be 'en' or 'es'" });

  // Skip blank entries rather than sending them to DeepL (avoids wasted
  // characters and keeps empty description/notes fields empty), but keep
  // the response array the same length/order as the request so callers can
  // zip it back against their original list by index.
  const nonEmpty = [];
  const indices = [];
  rawTexts.forEach((t, i) => {
    const s = typeof t === 'string' ? t.trim() : '';
    if (s) { nonEmpty.push(s); indices.push(i); }
  });
  if (!nonEmpty.length) {
    return json(200, { ok: true, translations: rawTexts.map(() => '') });
  }

  try {
    const res = await fetch(`${hostForKey(apiKey)}/v2/translate`, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: nonEmpty, target_lang: targetLang })
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = await res.json();
    const result = rawTexts.map(() => '');
    (data.translations || []).forEach((t, k) => { result[indices[k]] = t.text; });
    return json(200, { ok: true, translations: result });
  } catch (err) {
    return json(502, { ok: false, error: String(err.message || err) });
  }
};
