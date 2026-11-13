'use strict';
/**
 * authStore.js - the WhatsApp login (Baileys auth state), kept in the Google Sheet.
 *
 * Why this exists: Render's free plan wipes the local disk on every deploy or
 * restart. The old approach kept the login on disk and pushed a partial
 * snapshot (creds + pre-keys only) to the Sheet now and then. After a redeploy
 * that snapshot was either stale or missing the per-contact encryption keys,
 * so the bot came back to a QR screen or couldn't read customers' messages.
 *
 * Now EVERY key Baileys uses (creds, pre-keys, per-contact sessions, sender
 * keys, app-state keys, LID mappings...) is one row in the "WaAuth" tab. The
 * whole set is loaded into memory once at startup, and every change is written
 * through to the Sheet within a couple of seconds. A new deploy loads exactly
 * where the last one stopped - no QR scan. Same approach as the coaching bot.
 */

const fs = require('fs');
const path = require('path');
const { initAuthCreds, BufferJSON, proto } = require('@itsliaaa/baileys');
const zlib = require('zlib');
const config = require('./config');
const sheets = require('./sheets');
const log = require('./errors');

const FLUSH_DELAY_MS = 1500; // batch the bursts of key updates into one request
const RETRY_DELAY_MS = 5000;
const MAX_BATCH = 250; // keys per request - keeps each Apps Script call well under its time limit

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cache = new Map(); // key -> JSON string, mirrors the WaAuth tab
const pendingUpsert = new Map(); // key -> JSON string
const pendingRemove = new Set();
let loaded = false;
let frozen = false; // another copy of the bot owns the login - stop writing to the Sheet
let flushTimer = null;
let flushing = null;
let failedFlushes = 0;

const info = {
  loadedFrom: null,
  loadedAt: null,
  lastSavedAt: null,
  lastSaveError: null,
};

/** Same naming as Baileys' useMultiFileAuthState files, so old backups map over 1:1. */
const keyName = (type, id) => `${type}-${id}`.replace(/\//g, '__').replace(/:/g, '-');

function readKey(key) {
  const raw = cache.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw, BufferJSON.reviver);
  } catch (err) {
    log.logWarn('session', `Unreadable login key "${key}" - ignoring it: ${err.message}`);
    return null;
  }
}

function writeKey(key, value) {
  if (frozen) return;
  const raw = JSON.stringify(value, BufferJSON.replacer);
  if (cache.get(key) === raw && !pendingRemove.has(key)) return; // unchanged
  cache.set(key, raw);
  pendingUpsert.set(key, raw);
  pendingRemove.delete(key);
  scheduleFlush();
}

function removeKey(key) {
  if (frozen) return;
  if (!cache.has(key)) return; // never reached the Sheet either
  cache.delete(key);
  pendingUpsert.delete(key);
  pendingRemove.add(key);
  scheduleFlush();
}

function pendingCount() {
  return pendingUpsert.size + pendingRemove.size;
}

function scheduleFlush(delay = FLUSH_DELAY_MS) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => {});
  }, delay);
}

/**
 * Sends every queued change to the Sheet. One request at a time, so writes
 * always land in order. Resolves true when everything queued so far is saved.
 */
async function flush() {
  while (flushing) await flushing;
  if (frozen || !pendingCount()) return pendingCount() === 0;

  flushing = (async () => {
    while (pendingCount() && !frozen) {
      const upserts = [];
      const removes = [];
      for (const [key, value] of pendingUpsert) {
        if (upserts.length >= MAX_BATCH) break;
        upserts.push({ key, value });
      }
      for (const key of pendingRemove) {
        if (upserts.length + removes.length >= MAX_BATCH) break;
        removes.push(key);
      }
      upserts.forEach((u) => pendingUpsert.delete(u.key));
      removes.forEach((k) => pendingRemove.delete(k));

      try {
        await sheets.authWrite(upserts, removes);
        info.lastSavedAt = new Date().toISOString();
        info.lastSaveError = null;
        failedFlushes = 0;
      } catch (err) {
        info.lastSaveError = err.message;
        failedFlushes += 1;
        // Put back whatever hasn't changed again in the meantime.
        for (const u of upserts) {
          if (!pendingUpsert.has(u.key) && !pendingRemove.has(u.key)) pendingUpsert.set(u.key, u.value);
        }
        for (const k of removes) {
          if (!pendingUpsert.has(k) && !pendingRemove.has(k)) pendingRemove.add(k);
        }
        if (failedFlushes === 1 || failedFlushes % 20 === 0) {
          log.logError('session', err, `Saving the WhatsApp login to the Sheet failed (${failedFlushes}x) - retrying every ${RETRY_DELAY_MS / 1000}s`);
        }
        scheduleFlush(RETRY_DELAY_MS);
        return false;
      }
    }
    return pendingCount() === 0;
  })();

  try {
    return await flushing;
  } finally {
    flushing = null;
  }
}

/* ------------------------------ One-time move from the old backup ------------------------------ */

/** The old snapshot format from whatsapp.js: "#"-prefixed chunks of "GZ1:" + gzip/base64 JSON. */
function unpackLegacyChunks(chunks) {
  const joined = chunks.map((c) => (typeof c === 'string' && c.startsWith('#') ? c.slice(1) : String(c))).join('');
  if (joined.startsWith('GZ1:')) {
    return JSON.parse(zlib.gunzipSync(Buffer.from(joined.slice(4), 'base64')).toString('utf8'));
  }
  return JSON.parse(joined);
}

/** { "creds.json": "...", "pre-key-1.json": "..." } -> rows in the new store. */
function importFiles(files) {
  let count = 0;
  for (const [file, content] of Object.entries(files)) {
    if (!file.endsWith('.json') || typeof content !== 'string' || !content) continue;
    const key = file.slice(0, -'.json'.length);
    cache.set(key, content);
    pendingUpsert.set(key, content);
    count += 1;
  }
  return count;
}

async function migrateLegacyLogin() {
  // 1. A login left on local disk (a persistent disk, or running locally).
  const credsPath = path.join(config.authDir, 'creds.json');
  if (fs.existsSync(credsPath)) {
    const files = {};
    for (const file of fs.readdirSync(config.authDir)) {
      try {
        files[file] = fs.readFileSync(path.join(config.authDir, file), 'utf8');
      } catch (err) { /* skip unreadable file */ }
    }
    const count = importFiles(files);
    if (count) return `local folder ${config.authDir} (${count} keys)`;
  }

  // 2. The old snapshot in the "Session" tab.
  try {
    const chunks = await sheets.loadLegacySessionChunks();
    if (chunks.length) {
      const bundle = unpackLegacyChunks(chunks);
      if (bundle && bundle['creds.json']) {
        const count = importFiles(bundle);
        return `old Session-tab backup (${count} keys)`;
      }
    }
  } catch (err) {
    log.logWarn('session', `Could not read the old Session-tab backup (${err.message}) - a QR scan may be needed.`);
  }
  return null;
}

/* ------------------------------ Public API ------------------------------ */

/**
 * Loads the login from the Sheet. Keeps retrying until the Sheet answers:
 * starting with an empty login would create brand-new credentials and save
 * them over the real ones - exactly the "redeploy logged us out" problem.
 */
async function load() {
  frozen = false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const rows = await sheets.authLoad();
      cache.clear();
      pendingUpsert.clear();
      pendingRemove.clear();
      for (const row of rows) {
        if (row && row.key) cache.set(String(row.key), String(row.value));
      }

      let source = cache.size ? `google sheet (${cache.size} keys)` : null;
      if (!source) {
        const migrated = await migrateLegacyLogin();
        if (migrated) {
          source = `moved over from the ${migrated}`;
          await flush();
        }
      }

      loaded = true;
      info.loadedFrom = source || 'nothing saved yet - QR scan / pairing code needed';
      info.loadedAt = new Date().toISOString();
      log.logInfo('session', `WhatsApp login loaded: ${info.loadedFrom}.`);
      return;
    } catch (err) {
      const oldScript = /unknown action/i.test(err.message);
      const waitMs = oldScript ? 30000 : Math.min(30000, 3000 * attempt);
      log.logError(
        'session',
        err,
        oldScript
          ? 'The Google Apps Script is still the OLD version. Paste apps-script/Code.gs into the Sheet\'s Apps Script and deploy a NEW version. Retrying every 30s.'
          : `Could not load the WhatsApp login from the Sheet (attempt ${attempt}) - retrying in ${waitMs / 1000}s. The bot will not start with an empty login.`
      );
      await sleep(waitMs);
    }
  }
}

/** Baileys auth state backed by the in-memory copy of the WaAuth tab. */
function useSheetAuthState() {
  if (!loaded) throw new Error('The WhatsApp login has not been loaded from the Sheet yet.');
  const creds = readKey('creds') || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = readKey(keyName(type, id));
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              if (value) writeKey(keyName(type, id), value);
              else removeKey(keyName(type, id));
            }
          }
        },
      },
    },
    // Creds changes (pairing, new pre-keys) are the critical ones - save straight away.
    saveCreds: async () => {
      writeKey('creds', creds);
      await flush();
    },
  };
}

function hasLogin() {
  const creds = readKey('creds');
  return Boolean(creds && creds.me && creds.me.id);
}

/**
 * Another copy of the bot took the WhatsApp session over (normally the new
 * Render deploy). From now on this copy must not touch the Sheet, or it would
 * overwrite the newer copy's keys with its own older ones.
 */
function freeze() {
  frozen = true;
  pendingUpsert.clear();
  pendingRemove.clear();
}

/** Logout / relink: wipes the login in memory, in the Sheet (both tabs) and on disk. */
async function clear() {
  clearTimeout(flushTimer);
  flushTimer = null;
  while (flushing) await flushing;
  cache.clear();
  pendingUpsert.clear();
  pendingRemove.clear();
  frozen = false;
  loaded = true;
  try {
    fs.rmSync(config.authDir, { recursive: true, force: true });
  } catch (err) { /* best effort - only matters when running with a local folder */ }
  await sheets.authClear();
  info.loadedFrom = 'cleared - QR scan / pairing code needed';
  info.lastSavedAt = null;
}

function getInfo() {
  return {
    ...info,
    keys: cache.size,
    pending: pendingCount(),
    paired: hasLogin(),
    frozen,
  };
}

module.exports = { load, useSheetAuthState, hasLogin, flush, freeze, clear, getInfo };
