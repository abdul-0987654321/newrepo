'use strict';
/**
 * store.js - KSC Carpets local-first data layer.
 *
 * Leads, messages, and settings live in local JSON files under DATA_DIR.
 * All reads used by the bot and dashboard come from here - instant, no
 * network dependency. The Google Sheet (via sheets.js) is a background
 * mirror only: every write here also queues a best-effort sync to the
 * Sheet, but a slow or unreachable Sheet NEVER blocks a WhatsApp reply
 * or a dashboard page load.
 */

const fs = require('fs');
const path = require('path');
const sheets = require('./sheets');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const PATHS = {
  leads: path.join(DATA_DIR, 'leads.json'),
  messages: path.join(DATA_DIR, 'messages.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
};

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[store] could not read ${path.basename(file)}: ${err.message}`);
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic-ish, avoids a half-written file on crash
}

/* ---------------- Settings ---------------- */

const DEFAULT_SETTINGS = {
  botEnabled: true,
  followupEnabled: true,
  followupMessage: "Hi {name}, just checking back about your free measure with KSC Carpets - would you like to go ahead? Reply STOP if you'd rather we didn't contact you again.",
  followupDelayHours: 24,
  followupMaxAttempts: 3,
  reviewReminderEnabled: true,
  reviewReminderDelayHours: 48,
  reviewReminderMaxAttempts: 2,
  reviewReminderMessage: "Hi {name}, just a quick reminder - we'd really appreciate a Google review when you get a moment: {reviewLink}",
  adminNotificationNumber: '', // WhatsApp number to ping when a new lead completes their enquiry
};

let settingsCache = null;

function getSettings() {
  if (!settingsCache) settingsCache = { ...DEFAULT_SETTINGS, ...readJson(PATHS.settings, {}) };
  return settingsCache;
}

function updateSettings(patch) {
  settingsCache = { ...getSettings(), ...patch };
  writeJson(PATHS.settings, settingsCache);
  sheets.syncSettings(settingsCache); // fire-and-forget background mirror
  return settingsCache;
}

/**
 * Same as updateSettings, but waits for the Sheet mirror to actually
 * complete before returning. Settings changes are rare (dashboard/admin
 * action, not a hot chat-reply path) so a couple of seconds' wait here is
 * fine - and it means a redeploy right after saving won't restore a stale
 * value from the Sheet on the next restart. Use this from the dashboard's
 * "save settings" route; use plain updateSettings anywhere on a path that
 * must stay instant.
 */
async function updateSettingsAwaitSync(patch) {
  settingsCache = { ...getSettings(), ...patch };
  writeJson(PATHS.settings, settingsCache);
  await sheets.syncSettingsAwait(settingsCache);
  return settingsCache;
}

/* ---------------- Leads ---------------- */

let leadsCache = null;

function newLead(phone) {
  return {
    phone,
    name: '',
    status: 'new',
    carpetType: '',
    room: '',
    size: '',
    colour: '',
    budget: '',
    preferredTime: '',
    customerAddress: '',
    postcode: '',
    contactNumber: '',
    source: 'whatsapp',
    createdAt: new Date().toISOString(),
    lastContacted: '',
    followupCount: 0,
    reviewSent: false,
    humanTakeover: false,
    interestedNotified: false,
    bookedNotified: false,
    priceCallbackNotified: false,
  };
}

/*
 * The Sheet stores everything as text, so a restored lead comes back with
 * "TRUE"/"3" instead of true/3. These flags are anti-spam gates - a string
 * "TRUE" fails `=== true` and the customer would get the review request or
 * admin alert all over again - so convert them back on restore.
 */
const BOOLEAN_FIELDS = ['reviewSent', 'humanTakeover', 'interestedNotified', 'bookedNotified', 'priceCallbackNotified'];
const NUMBER_FIELDS = ['followupCount', 'reviewReminderCount'];
const DATE_FIELDS = ['createdAt', 'lastContacted', 'reviewRequestedAt'];

function toBool(value) {
  return value === true || String(value).trim().toLowerCase() === 'true';
}

function normalizeLead(raw) {
  const lead = { ...newLead(String(raw.phone)), ...raw, phone: String(raw.phone) };
  for (const f of BOOLEAN_FIELDS) lead[f] = toBool(lead[f]);
  for (const f of NUMBER_FIELDS) lead[f] = Number(lead[f]) || 0;
  for (const f of DATE_FIELDS) {
    if (lead[f] && Number.isNaN(new Date(lead[f]).getTime())) lead[f] = '';
  }
  for (const [k, v] of Object.entries(lead)) {
    if (v === null || v === undefined) lead[k] = '';
  }
  return lead;
}

function loadLeads() {
  if (!leadsCache) leadsCache = readJson(PATHS.leads, {}); // { [phone]: leadObject }
  return leadsCache;
}

function saveLeads() {
  writeJson(PATHS.leads, leadsCache);
}

function getLead(phone) {
  return loadLeads()[phone] || null;
}

function upsertLead(phone, fields) {
  const leads = loadLeads();
  const existing = leads[phone] || newLead(phone);
  const updated = { ...existing, ...fields };
  leads[phone] = updated;
  saveLeads();
  sheets.syncLead(updated); // fire-and-forget background mirror
  return updated;
}

/**
 * Same as upsertLead, but waits for the Sheet mirror to complete before
 * returning. Use this ONLY for the anti-spam gate flags (reviewSent,
 * priceCallbackNotified, followupCount, reviewReminderCount, etc.) - if a
 * restart's Sheet-restore rolled one of these back to a stale value, the
 * customer would get a duplicate message. Not for routine chat-field
 * updates (name, carpetType, etc.) - those stay on the fast fire-and-forget
 * path so a WhatsApp reply is never delayed by the Sheet.
 */
async function upsertLeadAwaitSync(phone, fields) {
  const leads = loadLeads();
  const existing = leads[phone] || newLead(phone);
  const updated = { ...existing, ...fields };
  leads[phone] = updated;
  saveLeads();
  await sheets.syncLeadAwait(updated);
  return updated;
}

function getAllLeads() {
  return Object.values(loadLeads()).sort(
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  );
}

function getLeadsNeedingFollowup() {
  const { followupDelayHours, followupMaxAttempts } = getSettings();
  const cutoffMs = followupDelayHours * 60 * 60 * 1000;
  const now = Date.now();
  return getAllLeads().filter((lead) => {
    if (lead.status !== 'interested') return false;
    if ((lead.followupCount || 0) >= followupMaxAttempts) return false;
    const last = lead.lastContacted ? new Date(lead.lastContacted).getTime() : 0;
    return now - last >= cutoffMs;
  });
}

function getLeadsAwaitingReview() {
  return getAllLeads().filter((lead) => lead.status === 'completed' && lead.reviewSent !== true);
}

/** Leads already asked for a review, but no reminder sent yet (or due for another one). */
function getLeadsNeedingReviewReminder() {
  const { reviewReminderDelayHours, reviewReminderMaxAttempts } = getSettings();
  const cutoffMs = reviewReminderDelayHours * 60 * 60 * 1000;
  const now = Date.now();
  return getAllLeads().filter((lead) => {
    if (!lead.reviewSent) return false;
    if ((lead.reviewReminderCount || 0) >= reviewReminderMaxAttempts) return false;
    const last = lead.reviewRequestedAt ? new Date(lead.reviewRequestedAt).getTime() : 0;
    return now - last >= cutoffMs;
  });
}

function setTakeover(phone, humanTakeover) {
  return upsertLead(phone, { humanTakeover: Boolean(humanTakeover) });
}

/** Permanently removes a lead and its full chat history, locally and from the Sheet backup. */
function deleteLead(phone) {
  const leads = loadLeads();
  delete leads[phone];
  saveLeads();

  const messages = loadMessages();
  delete messages[phone];
  saveMessages();

  sheets.syncDeleteLead(phone); // fire-and-forget background mirror
}

/* ---------------- Messages (chat transcripts) ---------------- */

let messagesCache = null;

function loadMessages() {
  if (!messagesCache) messagesCache = readJson(PATHS.messages, {}); // { [phone]: [{role,text,timestamp}] }
  return messagesCache;
}

function saveMessages() {
  writeJson(PATHS.messages, messagesCache);
}

function logMessage(phone, role, text) {
  const messages = loadMessages();
  if (!messages[phone]) messages[phone] = [];
  const entry = { role, text, timestamp: new Date().toISOString() };
  messages[phone].push(entry);
  // Cap history per lead so the file doesn't grow unbounded on a long-running bot
  if (messages[phone].length > 500) messages[phone] = messages[phone].slice(-500);
  saveMessages();
  sheets.syncMessage(phone, entry); // fire-and-forget background mirror
  return entry;
}

function getMessages(phone) {
  return loadMessages()[phone] || [];
}

/** Leads plus their last message - powers the dashboard chat list. */
function getChats() {
  const messages = loadMessages();
  return getAllLeads().map((lead) => {
    const thread = messages[lead.phone] || [];
    const last = thread[thread.length - 1];
    return { ...lead, lastMessage: last?.text || '', lastMessageAt: last?.timestamp || lead.lastContacted };
  });
}

/* ---------------- Restore from Sheet on startup ----------------
 * Render's free-tier disk is wiped on every redeploy/restart, same as
 * AUTH_DIR would be without a persistent disk. If the local leads file is
 * empty (fresh disk), pull everything back from the Google Sheet backup
 * before the bot/dashboard start serving - mirrors the WhatsApp session
 * restore pattern in whatsapp.js. Non-fatal if it fails: the app just
 * starts empty and rebuilds locally, same as before this existed.
 */
async function restoreFromSheetIfNeeded() {
  const hasLocalLeads = Object.keys(readJson(PATHS.leads, {})).length > 0;
  if (hasLocalLeads) return { restored: false, reason: 'local data already present' };

  console.log('[store] No local leads found - attempting to restore from Google Sheet backup...');
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const [sheetLeads, sheetMessages, sheetSettings] = await Promise.all([
        sheets.loadAllLeadsFromSheet(),
        sheets.loadAllMessagesFromSheet(),
        sheets.loadSettingsFromSheet(),
      ]);

      if (Array.isArray(sheetLeads) && sheetLeads.length) {
        leadsCache = {};
        for (const lead of sheetLeads) {
          if (!lead || !lead.phone) continue;
          leadsCache[String(lead.phone)] = normalizeLead(lead);
        }
        saveLeads();
        console.log(`[store] Restored ${Object.keys(leadsCache).length} lead(s) from Sheet.`);
      }

      if (Array.isArray(sheetMessages) && sheetMessages.length) {
        messagesCache = {};
        for (const msg of sheetMessages) {
          if (!msg || !msg.phone) continue;
          const phone = String(msg.phone);
          if (!messagesCache[phone]) messagesCache[phone] = [];
          messagesCache[phone].push({ role: msg.role, text: msg.text, timestamp: msg.timestamp });
        }
        for (const phone of Object.keys(messagesCache)) {
          if (messagesCache[phone].length > 500) messagesCache[phone] = messagesCache[phone].slice(-500);
        }
        saveMessages();
        console.log(`[store] Restored messages for ${Object.keys(messagesCache).length} lead(s) from Sheet.`);
      }

      if (sheetSettings && typeof sheetSettings === 'object') {
        settingsCache = { ...DEFAULT_SETTINGS, ...sheetSettings };
        writeJson(PATHS.settings, settingsCache);
        console.log('[store] Restored settings from Sheet.');
      }

      return { restored: true };
    } catch (err) {
      lastError = err;
      console.error(`[store] Restore from Sheet failed (attempt ${attempt}/3): ${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  console.error('[store] Restore from Sheet gave up - starting empty, non-fatal.');
  return { restored: false, error: lastError && lastError.message };
}

module.exports = {
  DATA_DIR,
  restoreFromSheetIfNeeded,
  getSettings,
  updateSettings,
  updateSettingsAwaitSync,
  getLead,
  upsertLead,
  upsertLeadAwaitSync,
  getAllLeads,
  getLeadsNeedingFollowup,
  getLeadsAwaitingReview,
  getLeadsNeedingReviewReminder,
  setTakeover,
  deleteLead,
  logMessage,
  getMessages,
  getChats,
};
