/**
 * production_requests.gs
 * =======================
 * Apps Script bound to the "2CW Production Requests" Google Sheet.
 * This file does NOT run in the 2cw-dashboard repo/CI — it lives in the
 * Sheet itself (Extensions > Apps Script > paste this in > Save > Deploy >
 * New deployment > Web app, Execute as "Me", Who has access "Anyone").
 *
 * Sheet must have one tab named exactly "Requests" with these column
 * headers (any order — lookup is by header name, not position):
 *
 *   PR#, Requested Date, Requested By, Brand, BSKU, TSKU, Category,
 *   Subcategory, Weight/Unit, Type, Flavor, Batch Size, Status, Notes
 *
 * inventory.html's "Add PR" button POSTs here with a plain-text body
 * (deliberately no Content-Type: application/json — that would trigger a
 * CORS preflight OPTIONS request, which Apps Script Web Apps don't handle).
 * doPost() parses e.postData.contents as JSON regardless of declared type.
 *
 * Payload shape: {brand, bsku, tsku, category, subcategory, weightUnit,
 *   type, batchSize, requestedBy}
 */

const REQUESTS_TAB = 'Requests';
const ALLOWED_REQUESTERS = ['robert', 'yali']; // case-insensitive substring match

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function headerMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h, i) => { if (h) map[h.toString().trim()] = i; });
  return map;
}

function nextPrNumber_(sheet, map) {
  const lastRow = sheet.getLastRow();
  let max = 0;
  if (lastRow >= 2) {
    const prCol = map['PR#'];
    const vals = sheet.getRange(2, prCol + 1, lastRow - 1, 1).getValues();
    vals.forEach(([v]) => {
      const m = /^PR-(\d+)$/.exec((v || '').toString().trim());
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
  }
  const next = max + 1;
  return 'PR-' + String(next).padStart(4, '0');
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (err) {
      return jsonResponse({ ok: false, error: 'Invalid JSON body' });
    }

    const requestedBy = (payload.requestedBy || '').toString().trim();
    const isAllowed = ALLOWED_REQUESTERS.some(n => requestedBy.toLowerCase().includes(n));
    if (!isAllowed) {
      return jsonResponse({ ok: false, error: 'Not authorized to submit production requests.' });
    }

    const batchSize = parseInt(payload.batchSize, 10);
    if (!payload.bsku || !payload.tsku || !batchSize || batchSize <= 0) {
      return jsonResponse({ ok: false, error: 'Missing bsku/tsku or invalid batchSize.' });
    }

    const sheet = SpreadsheetApp.getActive().getSheetByName(REQUESTS_TAB);
    if (!sheet) return jsonResponse({ ok: false, error: `Sheet tab "${REQUESTS_TAB}" not found.` });

    const map = headerMap_(sheet);
    const prNumber = nextPrNumber_(sheet, map);

    const row = new Array(sheet.getLastColumn()).fill('');
    const set = (header, value) => { if (map[header] !== undefined) row[map[header]] = value; };
    set('PR#', prNumber);
    set('Requested Date', new Date());
    set('Requested By', requestedBy);
    set('Brand', payload.brand || '');
    set('BSKU', payload.bsku || '');
    set('TSKU', payload.tsku || '');
    set('Category', payload.category || '');
    set('Subcategory', payload.subcategory || '');
    set('Weight/Unit', payload.weightUnit || '');
    set('Type', payload.type || '');
    set('Batch Size', batchSize);
    set('Status', 'Requested');

    sheet.appendRow(row);

    return jsonResponse({ ok: true, prNumber });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
}
