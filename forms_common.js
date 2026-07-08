// Shared plumbing for the field-team form pages (form_*.html).
// Keeps photo compression / submit / rep-store prefill logic in one place
// since all four forms need it identically.

const FORMS_ENDPOINT = '/.netlify/functions/submit-form';

// Downscale + JPEG-compress a photo before it goes into the JSON payload —
// keeps requests well under Netlify's function body limit and the repo lean.
function compressImage(file, maxDim = 1600, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', quality) });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function getRepName() {
  return sessionStorage.getItem('2cw_user_name') || '';
}

async function loadStoreOptions() {
  try {
    const res = await fetch('/data/customers.json');
    const customers = await res.json();
    return [...new Set(customers.map(c => c.CustomerName).filter(Boolean))].sort();
  } catch {
    return [];
  }
}

// Prefills the common Rep Name / Store / Date fields shared by every form.
async function initCommonFields({ repInputId, storeInputId, storeListId, dateInputId }) {
  const repInput = document.getElementById(repInputId);
  const dateInput = document.getElementById(dateInputId);
  const storeList = document.getElementById(storeListId);

  const savedRep = getRepName();
  if (savedRep) {
    repInput.value = savedRep;
    const hint = document.createElement('div');
    hint.className = 'form-hint';
    hint.textContent = `Logged in as ${savedRep} — recorded automatically with each submission.`;
    repInput.insertAdjacentElement('afterend', hint);
  }

  dateInput.value = new Date().toISOString().slice(0, 10);

  if (storeList) {
    const stores = await loadStoreOptions();
    storeList.innerHTML = stores.map(s => `<option value="${s.replace(/"/g, '&quot;')}">`).join('');
  }
}

// Every submission is stamped with whoever is logged into this browser session
// (independent of the editable "Rep Name" field) plus a server-side timestamp,
// so there's always a reliable record of who submitted and when.
async function submitForm(formKey, fields) {
  const stampedFields = { ...fields, sessionUser: getRepName() || null };
  try {
    const res = await fetch(FORMS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formKey, fields: stampedFields })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || `Submit failed (${res.status})` };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: 'Network error — check your connection and try again.' };
  }
}
