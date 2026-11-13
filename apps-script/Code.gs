/**
 * KSC Carpets - Google Sheet backend for the WhatsApp bot
 *
 * SETUP / UPDATE:
 * 1. Open the Google Sheet > Extensions > Apps Script.
 * 2. Replace the whole Code.gs with this file.
 * 3. Deploy > Manage deployments > edit the existing deployment >
 *    Version: "New version" > Deploy.
 *    (Saving the code alone does NOT update the live /exec URL - the bot keeps
 *    hitting the old version until a new version is deployed.)
 *      Execute as: Me
 *      Who has access: Anyone
 * 4. The /exec URL goes in SHEETS_WEBAPP_URL on Render.
 * 5. The secret must match SHEETS_WEBAPP_SECRET on Render. Set it under
 *    Project Settings > Script Properties as SECRET (recommended), or change
 *    SHARED_SECRET below.
 *
 * Tabs (all created automatically if missing):
 *   Leads    - one row per customer. New columns are added automatically.
 *   Messages - every chat message.
 *   Settings - dashboard settings (key | value).
 *   WaAuth   - the WhatsApp login, one row per key. This is what lets a Render
 *              redeploy reconnect without a new QR scan. Never edit it by hand.
 *   Session  - the OLD snapshot-style backup. Only read once, to move an
 *              existing login over to WaAuth. Safe to delete afterwards.
 */

const SHARED_SECRET = 'pass'; // only used when the SECRET script property is not set

function doGet() {
  return jsonOut({ ok: true, message: 'KSC Carpets Sheets backend is running. This endpoint only accepts POST requests from the bot.' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty('SECRET') || SHARED_SECRET;
    if (body.secret !== secret) {
      return jsonOut({ ok: false, error: 'unauthorized' });
    }

    const actions = {
      upsertLead, deleteLead, getAllLeads,
      getSettings, updateSettings,
      logMessage, getAllMessages,
      authLoad, authWrite, authClear, authInfo,
      loadSession, clearSession,
    };
    const fn = actions[body.action];
    if (!fn) return jsonOut({ ok: false, error: 'unknown action: ' + body.action });

    const data = fn(body.payload || {});
    return jsonOut({ ok: true, data: data });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** One writer at a time - the bot can send a lead update and a login update in parallel. */
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Makes sure there is room for `rows` x `cols` starting at `startRow`. */
function ensureSize(sheet, startRow, rows, cols) {
  const neededRows = startRow + rows - 1;
  if (neededRows > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), neededRows - sheet.getMaxRows());
  if (cols > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
}

/* ------------------------------ Leads ------------------------------ */

const LEADS_SHEET_NAME = 'Leads';
const LEAD_HEADERS = [
  'phone', 'name', 'status', 'carpetType', 'room', 'size', 'colour', 'budget',
  'source', 'createdAt', 'lastContacted', 'followupCount', 'reviewSent', 'humanTakeover',
  'jid', 'preferredTime', 'reviewRequestedAt', 'reviewReminderCount',
  'customerAddress', 'postcode', 'contactNumber',
  'interestedNotified', 'bookedNotified', 'priceCallbackNotified',
];

function getLeadsSheet() {
  return getOrCreateSheet(LEADS_SHEET_NAME, LEAD_HEADERS);
}

function leadHeaders(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
}

/** Adds a column for every field the bot sends that the sheet doesn't have yet. */
function ensureLeadHeaders(sheet, fields) {
  const headers = leadHeaders(sheet);
  const missing = ['phone'].concat(Object.keys(fields)).filter(function (k, i, all) {
    return headers.indexOf(k) === -1 && all.indexOf(k) === i;
  });
  if (missing.length) {
    ensureSize(sheet, 1, 1, headers.length + missing.length);
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    return headers.concat(missing);
  }
  return headers;
}

function rowToObject(headers, row) {
  const obj = {};
  headers.forEach(function (key, i) { if (key) obj[key] = row[i]; });
  return obj;
}

function findLeadRow(sheet, phone) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const phones = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < phones.length; i++) {
    if (String(phones[i][0]) === String(phone)) return i + 2;
  }
  return -1;
}

function upsertLead(p) {
  return withLock(function () {
    const sheet = getLeadsSheet();
    const phone = String(p.phone);
    const fields = Object.assign({}, p.fields || {}, { phone: phone });
    const headers = ensureLeadHeaders(sheet, fields);
    const rowIndex = findLeadRow(sheet, phone);

    let current = {};
    if (rowIndex !== -1) current = rowToObject(headers, sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0]);
    const updated = Object.assign({}, current, fields);
    const line = headers.map(function (h) {
      const v = updated[h];
      return v === undefined || v === null ? '' : v;
    });

    const target = rowIndex === -1 ? sheet.getLastRow() + 1 : rowIndex;
    ensureSize(sheet, target, 1, headers.length);
    const range = sheet.getRange(target, 1, 1, headers.length);
    // Plain text, so a customer typing "=..." or "+44..." is stored as typed,
    // never run as a formula. The bot converts true/false/numbers back itself.
    range.setNumberFormat('@');
    range.setValues([line]);
    return {};
  });
}

function deleteLead(p) {
  return withLock(function () {
    const sheet = getLeadsSheet();
    const rowIndex = findLeadRow(sheet, p.phone);
    if (rowIndex !== -1) sheet.deleteRow(rowIndex);

    // The chat history goes too, same as on the bot side.
    const messages = getMessagesSheet();
    const lastRow = messages.getLastRow();
    if (lastRow >= 2) {
      const phones = messages.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = phones.length - 1; i >= 0; i--) {
        if (String(phones[i][0]) === String(p.phone)) messages.deleteRow(i + 2);
      }
    }
    return {};
  });
}

function getAllLeads() {
  const sheet = getLeadsSheet();
  const lastRow = sheet.getLastRow();
  const headers = leadHeaders(sheet);
  if (lastRow < 2 || !headers.length) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const results = [];
  values.forEach(function (row) {
    if (row[0] !== '' && row[0] !== null) results.push(rowToObject(headers, row));
  });
  return results;
}

/* ---------------------------- Settings ---------------------------- */

const SETTINGS_SHEET_NAME = 'Settings';

function getSettingsSheet() {
  return getOrCreateSheet(SETTINGS_SHEET_NAME, ['key', 'value']);
}

function getSettings() {
  const values = getSettingsSheet().getDataRange().getValues();
  const settings = {};
  for (let i = 1; i < values.length; i++) {
    const key = values[i][0];
    const value = values[i][1];
    if (!key) continue;
    if (value === 'TRUE' || value === true) settings[key] = true;
    else if (value === 'FALSE' || value === false) settings[key] = false;
    else settings[key] = value;
  }
  return settings;
}

function updateSettings(p) {
  return withLock(function () {
    const fields = p.fields || {};
    const sheet = getSettingsSheet();
    const values = sheet.getDataRange().getValues();
    const keyRow = {};
    for (let i = 1; i < values.length; i++) keyRow[values[i][0]] = i + 1;

    Object.keys(fields).forEach(function (key) {
      let value = fields[key];
      if (Array.isArray(value) || (value && typeof value === 'object')) value = JSON.stringify(value);
      if (keyRow[key]) sheet.getRange(keyRow[key], 2).setValue(value);
      else sheet.appendRow([key, value]);
    });
    return {};
  });
}

/* ---------------------------- Messages ---------------------------- */

const MESSAGES_SHEET_NAME = 'Messages';

function getMessagesSheet() {
  return getOrCreateSheet(MESSAGES_SHEET_NAME, ['phone', 'role', 'text', 'timestamp']);
}

function logMessage(p) {
  return withLock(function () {
    const sheet = getMessagesSheet();
    const target = sheet.getLastRow() + 1;
    ensureSize(sheet, target, 1, 4);
    const range = sheet.getRange(target, 1, 1, 4);
    range.setNumberFormat('@'); // customer text stays text, never a formula
    range.setValues([[String(p.phone), String(p.role || ''), String(p.text || ''), new Date().toISOString()]]);
    return {};
  });
}

function getAllMessages() {
  const sheet = getMessagesSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  const results = [];
  values.forEach(function (r) {
    if (!r[0]) return;
    const ts = r[3] instanceof Date ? r[3].toISOString() : String(r[3]);
    results.push({ phone: String(r[0]), role: r[1], text: String(r[2]), timestamp: ts });
  });
  return results;
}

/* ---------------------------------------------------------------------------
 * WhatsApp login (Baileys auth state) - one row per key in the WaAuth tab.
 *
 * Render's free plan wipes the disk on every deploy/restart. The bot keeps
 * EVERY login key here (creds, pre-keys, per-contact sessions, sender keys,
 * app-state keys...) and writes each change through within a couple of
 * seconds, so a new deploy loads the exact same login and reconnects without
 * a QR scan.
 *
 * Layout: A = key, B = value. A value longer than one cell allows carries on
 * in C, D, ... Deleted keys leave a blank row that the next new key reuses.
 * ------------------------------------------------------------------------ */

const AUTH_SHEET_NAME = 'WaAuth';
const AUTH_CHUNK = 45000; // a cell holds 50,000 characters

function getAuthSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(AUTH_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(AUTH_SHEET_NAME);
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).setNumberFormat('@');
    sheet.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function authLoad() {
  const sheet = getAuthSheet();
  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(2, sheet.getLastColumn());
  if (lastRow < 2) return { rows: [] };
  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const rows = [];
  values.forEach(function (r) {
    const key = String(r[0] || '');
    if (!key) return;
    let value = '';
    for (let c = 1; c < r.length; c++) {
      if (r[c] === '' || r[c] === null) break;
      value += String(r[c]);
    }
    rows.push({ key: key, value: value });
  });
  return { rows: rows };
}

function authWrite(p) {
  return withLock(function () {
    const sheet = getAuthSheet();
    const upserts = (p.upserts || []).map(function (u) {
      const value = String(u.value);
      const cells = [];
      for (let i = 0; i < value.length; i += AUTH_CHUNK) cells.push(value.slice(i, i + AUTH_CHUNK));
      return { key: String(u.key), cells: cells.length ? cells : [''] };
    });
    const removes = (p.removes || []).map(String);

    let width = Math.max(2, sheet.getLastColumn());
    upserts.forEach(function (u) { width = Math.max(width, 1 + u.cells.length); });
    ensureSize(sheet, 1, 1, width);
    const line = function (key, cells) {
      const row = [key].concat(cells);
      while (row.length < width) row.push('');
      return row;
    };

    const index = {};
    const free = [];
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < keys.length; i++) {
        const k = String(keys[i][0] || '');
        if (k) index[k] = i + 2;
        else free.push(i + 2);
      }
    }

    const blank = line('', []);
    removes.forEach(function (k) {
      const r = index[k];
      if (!r) return;
      sheet.getRange(r, 1, 1, width).setValues([blank]);
      delete index[k];
      free.push(r);
    });

    const toAppend = [];
    upserts.forEach(function (u) {
      let r = index[u.key];
      if (!r && free.length) {
        r = free.shift();
        index[u.key] = r;
      }
      if (r) sheet.getRange(r, 1, 1, width).setValues([line(u.key, u.cells)]);
      else toAppend.push(line(u.key, u.cells));
    });

    if (toAppend.length) {
      const start = sheet.getLastRow() + 1;
      ensureSize(sheet, start, toAppend.length, width);
      const range = sheet.getRange(start, 1, toAppend.length, width);
      range.setNumberFormat('@');
      range.setValues(toAppend);
    }
    SpreadsheetApp.flush();
    return { upserted: upserts.length, removed: removes.length };
  });
}

/** Logout / relink: wipes the login here AND the old snapshot, so neither can be restored. */
function authClear() {
  return withLock(function () {
    const sheet = getAuthSheet();
    sheet.clearContents();
    sheet.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
    clearSession();
    SpreadsheetApp.flush();
    return {};
  });
}

/** Lets the dashboard prove the login is really in the Sheet, without downloading it. */
function authInfo() {
  const rows = authLoad().rows;
  let me = null;
  rows.forEach(function (r) {
    if (r.key !== 'creds') return;
    try {
      const creds = JSON.parse(r.value);
      me = creds && creds.me ? creds.me.id : null;
    } catch (err) { /* unreadable creds - reported as not paired */ }
  });
  return { keys: rows.length, paired: Boolean(me), me: me };
}

/* ---------------- OLD snapshot backup (read-only, for the one-time move) ---------------- */

const SESSION_SHEET_NAME = 'Session';

function loadSession() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSION_SHEET_NAME);
  if (!sheet) return { chunks: [], meta: null };
  const values = sheet.getDataRange().getValues();
  let meta = null;
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const idx = values[i][0];
    if (idx === 'meta') {
      try { meta = JSON.parse(values[i][1]); } catch (err) { meta = null; }
      continue;
    }
    if (idx === '' || idx === null || idx === undefined) continue;
    rows.push([Number(idx), String(values[i][1])]);
  }
  rows.sort(function (a, b) { return a[0] - b[0]; });
  return { chunks: rows.map(function (r) { return r[1]; }), meta: meta };
}

function clearSession() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSION_SHEET_NAME);
  if (!sheet) return {};
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 2).setValues([['chunkIndex', 'data']]);
  return {};
}
