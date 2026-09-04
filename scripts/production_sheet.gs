/**
 * production_sheet.gs
 * ====================
 * Bound Apps Script for the "04-2CW-Production Requests" Google Sheet
 * (Howie Roll / Soma Rosa Farms / Mendo production planning — see the
 * Instructions tab in the Sheet for the full workflow).
 *
 * Install: open the Sheet -> Extensions > Apps Script -> paste this in,
 * replacing the default Code.gs -> Save. No deployment needed; onEdit()
 * runs automatically as a simple trigger.
 *
 * What it does:
 *  - When a Material Request Slots row's Status is set to "Confirmed",
 *    writes that slot's Picked Strain into every linked PR's Output Strain
 *    and advances that PR's Status (Requested -> Slotted -> Sourced).
 *  - Keeps "Linked PRs" and "Linked PR Total" on the Slots tab in sync
 *    with whatever Production Requests rows currently point at each slot
 *    (recalculated after any edit to either tab, not just on Confirm).
 *  - Adds a "Production Requests" menu with "Recalculate All" as a manual
 *    fallback, since onEdit doesn't fire for pasted/imported data.
 *  - doPost(): lets inventory.html's "+ Add PR" button append a new row to
 *    Production Requests directly, with a server-assigned PR# and a
 *    server-side requester check (belt-and-suspenders — inventory.html
 *    already hides the button from anyone but Robert/Yali).
 *
 * Deploying doPost for the "+ Add PR" button: Deploy > New deployment >
 * Web app (Execute as: Me, Who has access: Anyone) -> copy the /exec URL
 * into PRODUCTION_REQUESTS_WEBAPP_URL near the top of inventory.html.
 */

const REQUESTS_SHEET = 'Production Requests';
const SLOTS_SHEET = 'Material Request Slots';

const REQ_COLS = ['PR#', 'Product', 'ASKU', 'BSKU', 'Crew', 'Strain Type',
  'Slot ID', 'Output Strain', 'Batch Size', 'Ready Date', 'Ship Date', 'Status', 'Notes'];
const SLOT_COLS = ['Slot ID', 'Week Requested', 'Strain Type', 'Target Quantity', 'Unit',
  'Linked PRs', 'Linked PR Total', 'Picked Strain', 'Status', 'Confirmed Date'];

// PR Status advances through this order; confirming a slot never moves a PR
// backwards, only forward up to "Sourced".
const REQ_STATUS_ORDER = ['Requested', 'Slotted', 'Sourced', 'Scheduled', 'Complete'];

// Same allowlist as inventory.html's PR_ALLOWED_USERS — case-insensitive
// substring match against the submitted requester name.
const PR_ALLOWED_REQUESTERS = ['robert', 'yali'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Production Requests')
    .addItem('Recalculate All', 'recalculateAll')
    .addToUi();
}

function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const name = sheet.getName();

  if (name === SLOTS_SHEET) {
    handleSlotsEdit_(e, sheet);
    syncLinkedTotals_();
  } else if (name === REQUESTS_SHEET) {
    syncLinkedTotals_();
  }
}

function recalculateAll() {
  syncLinkedTotals_();
  SpreadsheetApp.getActive().toast('Linked PR totals recalculated.', 'Production Requests');
}

// ── Slot confirmation ────────────────────────────────────────────────────

function handleSlotsEdit_(e, sheet) {
  const headerRow = 1;
  const editedRow = e.range.getRow();
  if (editedRow <= headerRow) return;

  const headers = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getValues()[0];
  const statusCol = headers.indexOf('Status') + 1;
  if (statusCol === 0) return;

  // Only act when the edit touched the Status column (or a multi-cell paste
  // that includes it) and the new value is "Confirmed".
  const editedStatusCol = e.range.getColumn() <= statusCol &&
    e.range.getColumn() + e.range.getNumColumns() - 1 >= statusCol;
  if (!editedStatusCol) return;

  const status = sheet.getRange(editedRow, statusCol).getValue().toString().trim();
  if (status.toLowerCase() !== 'confirmed') return;

  const slotIdCol = headers.indexOf('Slot ID') + 1;
  const pickedStrainCol = headers.indexOf('Picked Strain') + 1;
  const confirmedDateCol = headers.indexOf('Confirmed Date') + 1;

  const slotId = sheet.getRange(editedRow, slotIdCol).getValue().toString().trim();
  const pickedStrain = sheet.getRange(editedRow, pickedStrainCol).getValue().toString().trim();
  if (!slotId) return;

  if (!pickedStrain) {
    SpreadsheetApp.getUi().alert(
      'Slot ' + slotId + ' was marked Confirmed but has no Picked Strain — fill that in first.');
    return;
  }

  if (confirmedDateCol && !sheet.getRange(editedRow, confirmedDateCol).getValue()) {
    sheet.getRange(editedRow, confirmedDateCol).setValue(new Date());
  }

  applyPickedStrainToLinkedPRs_(slotId, pickedStrain);
}

function applyPickedStrainToLinkedPRs_(slotId, pickedStrain) {
  const reqSheet = SpreadsheetApp.getActive().getSheetByName(REQUESTS_SHEET);
  if (!reqSheet || reqSheet.getLastRow() < 2) return;

  const headers = reqSheet.getRange(1, 1, 1, reqSheet.getLastColumn()).getValues()[0];
  const slotIdCol = headers.indexOf('Slot ID') + 1;
  const outputStrainCol = headers.indexOf('Output Strain') + 1;
  const statusCol = headers.indexOf('Status') + 1;
  if (!slotIdCol || !outputStrainCol || !statusCol) return;

  const numRows = reqSheet.getLastRow() - 1;
  const slotIds = reqSheet.getRange(2, slotIdCol, numRows, 1).getValues();
  const statuses = reqSheet.getRange(2, statusCol, numRows, 1).getValues();

  for (let i = 0; i < numRows; i++) {
    const rowSlotId = slotIds[i][0].toString().trim();
    if (rowSlotId !== slotId) continue;

    const row = i + 2;
    reqSheet.getRange(row, outputStrainCol).setValue(pickedStrain);

    const currentStatus = statuses[i][0].toString().trim();
    const currentIdx = REQ_STATUS_ORDER.indexOf(currentStatus);
    const sourcedIdx = REQ_STATUS_ORDER.indexOf('Sourced');
    if (currentIdx < sourcedIdx) {
      reqSheet.getRange(row, statusCol).setValue('Sourced');
    }
  }
}

// ── Linked PR totals ─────────────────────────────────────────────────────

function syncLinkedTotals_() {
  const ss = SpreadsheetApp.getActive();
  const reqSheet = ss.getSheetByName(REQUESTS_SHEET);
  const slotSheet = ss.getSheetByName(SLOTS_SHEET);
  if (!reqSheet || !slotSheet) return;

  const reqHeaders = reqSheet.getRange(1, 1, 1, reqSheet.getLastColumn()).getValues()[0];
  const reqSlotIdCol = reqHeaders.indexOf('Slot ID') + 1;
  const reqPrNumCol = reqHeaders.indexOf('PR#') + 1;
  const reqBatchSizeCol = reqHeaders.indexOf('Batch Size') + 1;
  if (!reqSlotIdCol || !reqPrNumCol || !reqBatchSizeCol) return;

  // Group linked PRs by Slot ID.
  const bySlot = {}; // slotId -> {prNums: [], total: number}
  const reqRows = reqSheet.getLastRow() - 1;
  if (reqRows > 0) {
    const data = reqSheet.getRange(2, 1, reqRows, reqSheet.getLastColumn()).getValues();
    data.forEach(row => {
      const slotId = row[reqSlotIdCol - 1].toString().trim();
      if (!slotId) return;
      const prNum = row[reqPrNumCol - 1].toString().trim();
      const batchSize = Number(row[reqBatchSizeCol - 1]) || 0;
      if (!bySlot[slotId]) bySlot[slotId] = { prNums: [], total: 0 };
      if (prNum) bySlot[slotId].prNums.push(prNum);
      bySlot[slotId].total += batchSize;
    });
  }

  const slotHeaders = slotSheet.getRange(1, 1, 1, slotSheet.getLastColumn()).getValues()[0];
  const slotIdCol = slotHeaders.indexOf('Slot ID') + 1;
  const linkedPrsCol = slotHeaders.indexOf('Linked PRs') + 1;
  const linkedTotalCol = slotHeaders.indexOf('Linked PR Total') + 1;
  if (!slotIdCol || !linkedPrsCol || !linkedTotalCol) return;

  const slotRows = slotSheet.getLastRow() - 1;
  if (slotRows <= 0) return;

  const slotIds = slotSheet.getRange(2, slotIdCol, slotRows, 1).getValues();
  for (let i = 0; i < slotRows; i++) {
    const slotId = slotIds[i][0].toString().trim();
    if (!slotId) continue;
    const row = i + 2;
    const info = bySlot[slotId] || { prNums: [], total: 0 };
    slotSheet.getRange(row, linkedPrsCol).setValue(info.prNums.join(', '));
    slotSheet.getRange(row, linkedTotalCol).setValue(info.total);
  }
}

// ── Add PR from inventory.html ───────────────────────────────────────────

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonResponse_({ ok: false, error: 'Invalid request body.' });
  }

  const requester = (body.requester || '').toString().trim();
  const requesterOk = requester && PR_ALLOWED_REQUESTERS.some(u =>
    requester.toLowerCase().indexOf(u) !== -1);
  if (!requesterOk) {
    return jsonResponse_({ ok: false, error: 'Not authorized to submit a production request.' });
  }

  const bsku = (body.bsku || '').toString().trim();
  const strainType = (body.strainType || '').toString().trim();
  const batchSize = Number(body.batchSize);
  if (!bsku || !strainType || !batchSize || batchSize <= 0) {
    return jsonResponse_({ ok: false, error: 'Missing bsku, strainType, or a positive batchSize.' });
  }

  const reqSheet = SpreadsheetApp.getActive().getSheetByName(REQUESTS_SHEET);
  if (!reqSheet) {
    return jsonResponse_({ ok: false, error: 'Production Requests tab not found.' });
  }

  const headers = reqSheet.getRange(1, 1, 1, reqSheet.getLastColumn()).getValues()[0];
  const colIndex = {};
  REQ_COLS.forEach(c => { colIndex[c] = headers.indexOf(c) + 1; });
  if (!colIndex['PR#']) {
    return jsonResponse_({ ok: false, error: 'Production Requests tab is missing expected columns.' });
  }

  const prNum = nextPrNumber_(reqSheet, colIndex['PR#']);

  const row = new Array(headers.length).fill('');
  const set = (col, val) => { if (colIndex[col]) row[colIndex[col] - 1] = val; };
  set('PR#', prNum);
  set('Product', (body.product || '').toString().trim());
  set('BSKU', bsku);
  set('Crew', (body.crew || '').toString().trim());
  set('Strain Type', strainType);
  set('Batch Size', batchSize);
  set('Ready Date', (body.readyDate || '').toString().trim());
  set('Ship Date', (body.shipDate || '').toString().trim());
  set('Status', 'Requested');
  set('Notes', (body.notes || '').toString().trim());

  reqSheet.appendRow(row);
  syncLinkedTotals_();

  return jsonResponse_({ ok: true, pr_num: prNum });
}

// Next PR# as PR-<n+1>, based on the highest existing PR-#### in the sheet.
function nextPrNumber_(reqSheet, prNumCol) {
  const rows = reqSheet.getLastRow() - 1;
  let max = 1000;
  if (rows > 0) {
    const values = reqSheet.getRange(2, prNumCol, rows, 1).getValues();
    values.forEach(([v]) => {
      const m = /^PR-(\d+)$/.exec((v || '').toString().trim());
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
  }
  return 'PR-' + (max + 1);
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
