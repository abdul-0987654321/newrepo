const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@itsliaaa/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const { getAIResponse } = require('./ai');
const store = require('./store');
const config = require('./config');
const authStore = require('./authStore');
const log = require('./errors');

const logger = pino({ level: 'warn' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ============================================================================
 * SESSION  (the login itself lives in authStore.js -> Google Sheet "WaAuth" tab)
 * ==========================================================================*/

/** Wipes the login everywhere, so a dead session can't be loaded on the next boot. */
async function wipeSession(reason) {
  try {
    await authStore.clear();
  } catch (err) {
    log.logError('session', err, 'Could not clear the saved WhatsApp login in the Sheet');
  }
  log.logWarn('session', `Session cleared - ${reason}. A new QR scan or pairing code is now required.`);
}

/** Dashboard "save now": pushes any queued login changes to the Sheet immediately. */
async function saveSessionNow() {
  return authStore.flush();
}

/* ============================================================================
 * CONNECTION STATE
 * ==========================================================================*/

const conversations = new Map(); // in-memory chat history, keyed by phone
const MAX_HISTORY_TURNS = 10;

let sock = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let latestQrDataUrl = null;
let latestQrAt = null;
let latestPairingCode = null;
let latestPairingCodeAt = null;
let pendingPairingNumber = null;
let pairingRequestedForThisSocket = false;
let needsRelink = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let starting = false;
let lastDisconnectInfo = null;
let stopping = false; // set on shutdown - no more reconnects
let replaced = false; // another copy of the bot holds the session right now
const CONNECT_WATCHDOG_MS = 60000;
const REPLACED_RETRY_MS = 3 * 60 * 1000;

function isConnected() {
  return connectionStatus === 'connected' && Boolean(sock && sock.user && sock.user.id);
}

/**
 * WhatsApp rejects the pairing-code flow when the browser identifier is a
 * made-up name - that produces "Couldn't link device, check the phone number
 * or get a new code" on the phone, even when the number and code are right.
 * A standard identifier is required. QR linking doesn't care, so the custom
 * name is only used when we're not pairing by number.
 */
function browserSignature(usingPairingCode) {
  if (usingPairingCode) {
    if (Browsers && typeof Browsers.ubuntu === 'function') return Browsers.ubuntu('Chrome');
    return ['Ubuntu', 'Chrome', '110.0.5585.95'];
  }
  return ['KSC Carpets Bot', 'Chrome', '120.0.0'];
}

function disconnectReasonName(statusCode) {
  const match = Object.keys(DisconnectReason).find((key) => DisconnectReason[key] === statusCode);
  return match || 'unknown';
}

function scheduleReconnect(ms, reason) {
  if (stopping) return;
  if (reconnectTimer) return; // one pending reconnect at a time - never stack them
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsApp().catch((err) => log.logError('whatsapp', err, 'Reconnect attempt failed'));
  }, ms);
  log.logInfo('whatsapp', `Reconnecting in ${Math.round(ms / 1000)}s (attempt ${reconnectAttempts}) - reason: ${reason}`);
}

function jidToPhone(jid) {
  return jid.split('@')[0];
}

function pushHistory(phone, role, content) {
  const history = conversations.get(phone) || [];
  history.push({ role, content });
  while (history.length > MAX_HISTORY_TURNS) history.shift();
  conversations.set(phone, history);
  return history;
}

/* ============================================================================
 * LEAD STATUS + MESSAGE HANDLING  (unchanged behaviour)
 * ==========================================================================*/

function computeStatus({ intent, currentStatus, hasRequiredInfo }) {
  if (intent === 'not_interested') return 'not_interested';
  if (currentStatus === 'booked' || currentStatus === 'completed') return currentStatus;
  if (hasRequiredInfo) return 'booked';
  if (intent === 'interested') return 'interested';
  return currentStatus || 'new';
}

function buildReplyText(ai) {
  const options = (ai.options || []).filter(Boolean).slice(0, 10);
  if (!options.length) return ai.reply;
  const numbered = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
  return `${ai.reply}\n\n${numbered}`;
}

async function handleIncomingMessage(msg) {
  if (msg.key.fromMe) return;
  if (!msg.message) return; // failed decrypt, reaction, receipt etc.

  const jid = msg.key.remoteJid;
  const isDirectMessage = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
  if (!isDirectMessage) return; // ignore groups, channels, broadcasts, status

  const phone = jidToPhone(jid);

  const unwrapped =
    msg.message.ephemeralMessage?.message ||
    msg.message.viewOnceMessage?.message ||
    msg.message.viewOnceMessageV2?.message ||
    msg.message.viewOnceMessageV2Extension?.message ||
    msg.message;

  const text =
    unwrapped.conversation ||
    unwrapped.extendedTextMessage?.text ||
    unwrapped.buttonsResponseMessage?.selectedDisplayText ||
    unwrapped.listResponseMessage?.title ||
    unwrapped.imageMessage?.caption ||
    unwrapped.videoMessage?.caption ||
    '';

  if (!text) return;

  const pushName = msg.pushName || '';
  console.log(`[whatsapp] Message from ${phone} (${pushName}): ${text}`);

  store.logMessage(phone, 'user', text);
  const settings = store.getSettings();
  const lead = store.getLead(phone);

  if (settings.botEnabled === false) return;
  if (lead?.humanTakeover === true) return;

  // Blue ticks after a short pause, not the instant the message lands.
  // Reading a message in zero milliseconds is one of the clearest automation
  // tells, so wait ~1.5s, then mark as read and start "typing...".
  const sockForRead = sock;
  setTimeout(() => {
    if (!sockForRead) return;
    sockForRead.readMessages([msg.key]).catch(() => {});
    sockForRead.sendPresenceUpdate('composing', jid).catch(() => {});
  }, 1500);

  const history = pushHistory(phone, 'user', text);

  const known = {
    name: lead?.name || '',
    carpetType: lead?.carpetType || '',
    room: lead?.room || '',
    size: lead?.size || '',
    colour: lead?.colour || '',
    budget: lead?.budget || '',
    preferredTime: lead?.preferredTime || '',
    customerAddress: lead?.customerAddress || '',
    postcode: lead?.postcode || '',
    contactNumber: lead?.contactNumber || '',
  };

  let ai;
  try {
    ai = await getAIResponse(history, known);
  } catch (err) {
    log.logError('ai', err, `OpenAI call failed for ${phone} - no reply was sent`);
    return;
  }

  const replyText = buildReplyText(ai);
  pushHistory(phone, 'assistant', replyText);

  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  await sleep(2000 + Math.floor(Math.random() * 3000));

  await sock.sendMessage(jid, { text: replyText });
  store.logMessage(phone, 'assistant', replyText);

  const carpetType = ai.carpetType || lead?.carpetType || '';
  const room = ai.room || lead?.room || '';
  const size = ai.size || lead?.size || '';
  const colour = ai.colour || lead?.colour || '';
  const budget = ai.budget || lead?.budget || '';
  const preferredTime = ai.preferredTime || lead?.preferredTime || '';
  const name = ai.name || lead?.name || pushName;
  const customerAddress = ai.customerAddress || lead?.customerAddress || '';
  const postcode = ai.postcode || lead?.postcode || '';
  const contactNumber = ai.contactNumber || lead?.contactNumber || '';
  const hasRequiredInfo = Boolean(name && room && (budget || preferredTime));
  const status = computeStatus({ intent: ai.intent, currentStatus: lead?.status, hasRequiredInfo });

  const updatedLead = store.upsertLead(phone, {
    jid,
    name,
    status,
    carpetType,
    room,
    size,
    colour,
    budget,
    preferredTime,
    customerAddress,
    postcode,
    contactNumber,
    source: lead?.source || 'whatsapp',
    lastContacted: new Date().toISOString(),
    followupCount: 0,
  });

  if (status === 'booked' && !updatedLead.bookedNotified) {
    notifyAdmin(updatedLead, 'booked');
    await store.upsertLeadAwaitSync(phone, { bookedNotified: true });
  }

  if (ai.wantsPriceCallback && !updatedLead.priceCallbackNotified) {
    notifyAdmin(updatedLead, 'price_callback');
    await store.upsertLeadAwaitSync(phone, { priceCallbackNotified: true });
  }
}

async function notifyAdmin(lead, reason = 'booked') {
  try {
    const settings = store.getSettings();
    const adminNumber = String(settings.adminNotificationNumber || '').replace(/\D/g, '');
    if (!adminNumber || !isConnected()) return;

    const headline = reason === 'price_callback'
      ? `Customer wants a PRICE CALL (declined a visit) - ${lead.name || 'Unknown name'} (${lead.phone})`
      : `Lead ready to book - ${lead.name || 'Unknown name'} (${lead.phone})`;

    const lines = [
      headline,
      lead.carpetType ? `Carpet: ${lead.carpetType}` : null,
      lead.room ? `Room: ${lead.room}` : null,
      lead.size ? `Size: ${lead.size}` : null,
      lead.colour ? `Colour: ${lead.colour}` : null,
      lead.budget ? `Budget: ${lead.budget}` : null,
      lead.customerAddress ? `Address: ${lead.customerAddress}` : null,
      lead.postcode ? `Postcode: ${lead.postcode}` : null,
      lead.contactNumber ? `Contact number given: ${lead.contactNumber}` : null,
      reason === 'price_callback'
        ? 'Call them with a price - they did not want a measure visit.'
        : `Wants to meet: ${lead.preferredTime || 'no time given yet - ask them'}`,
    ].filter(Boolean);

    await sock.sendMessage(`${adminNumber}@s.whatsapp.net`, { text: lines.join('\n') });
  } catch (err) {
    log.logError('whatsapp', err, 'Admin notification failed');
  }
}

/* ============================================================================
 * SOCKET LIFECYCLE
 * ==========================================================================*/

function detachSocket() {
  const old = sock;
  sock = null;
  if (!old) return;
  try { old.ev.removeAllListeners(); } catch (err) { /* best effort */ }
  try { old.end(undefined); } catch (err) { /* best effort */ }
}

async function startWhatsApp() {
  if (starting) return sock;
  if (stopping) return null;
  starting = true;

  try {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // Tear the old socket down completely before building a new one, so two
    // sockets can never hold the same session at once (that produced the
    // "conflict: replaced" disconnects in the logs).
    detachSocket();

    // After being replaced by another copy, that copy may have changed keys
    // since we last loaded - start again from what is in the Sheet now.
    if (replaced) {
      replaced = false;
      await authStore.load();
    }

    const { state, saveCreds } = authStore.useSheetAuthState();
    const alreadyPaired = authStore.hasLogin();
    needsRelink = !alreadyPaired;

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (err) {
      log.logWarn('whatsapp', `Could not fetch the latest Baileys version (${err.message}) - using the pinned fallback.`);
      version = [2, 3000, 1015901307];
    }

    const usingPairingCode = Boolean(!alreadyPaired && pendingPairingNumber);

    connectionStatus = 'connecting';
    const thisSock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: browserSignature(usingPairingCode),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
    });
    sock = thisSock;
    let sawQrOrOpen = false;

    pairingRequestedForThisSocket = false;
    if (usingPairingCode) {
      log.logInfo('whatsapp', `Pairing-code mode for +${pendingPairingNumber} (browser id: ${JSON.stringify(browserSignature(true))}).`);
    }

    // Baileys can hang silently when the WebSocket never opens (no QR, no
    // error, no close). If nothing has happened after a minute, start over.
    setTimeout(() => {
      if (sock === thisSock && !sawQrOrOpen && connectionStatus === 'connecting') {
        log.logWarn('whatsapp', 'Connecting hung for 60s with no QR and no connection - retrying.');
        detachSocket();
        connectionStatus = 'disconnected';
        reconnectAttempts += 1;
        scheduleReconnect(5000, 'connect timeout');
      }
    }, CONNECT_WATCHDOG_MS);

    thisSock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (err) {
        log.logError('session', err, 'Saving the WhatsApp login failed');
      }
    });

    thisSock.ev.on('connection.update', async (update) => {
      if (sock !== thisSock) return; // late event from a socket we already dropped
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sawQrOrOpen = true;
        connectionStatus = 'connecting';
        latestQrAt = new Date().toISOString();

        // The arrival of a QR is the reliable signal that the socket is up and
        // ready to accept a pairing-code request. Asking on a fixed timer (the
        // old behaviour) could fire before the socket was ready, which
        // produced a code the phone then refused.
        if (pendingPairingNumber && !pairingRequestedForThisSocket) {
          pairingRequestedForThisSocket = true;
          const numberForPairing = pendingPairingNumber;
          try {
            if (typeof thisSock.requestPairingCode !== 'function') {
              throw new Error('This Baileys build does not expose requestPairingCode - use the QR code instead.');
            }
            const raw = await thisSock.requestPairingCode(numberForPairing);
            if (sock === thisSock) {
              const formatted = String(raw).replace(/[\s-]/g, '').match(/.{1,4}/g).join('-');
              latestPairingCode = formatted;
              latestPairingCodeAt = new Date().toISOString();
              log.logInfo('whatsapp', `Pairing code ready for +${numberForPairing}: ${formatted} (valid for a couple of minutes).`);
            }
          } catch (err) {
            latestPairingCode = null;
            log.logError('whatsapp', err, `Requesting a pairing code for +${numberForPairing} failed`);
          }
        }

        try {
          console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
          console.log('Scan the QR above with the KSC Carpets WhatsApp number (or use the pairing code on the dashboard).');
          latestQrDataUrl = await QRCode.toDataURL(qr);
        } catch (err) {
          log.logError('whatsapp', err, 'Could not render the QR code');
        }
      }

      if (connection === 'close') {
        connectionStatus = 'disconnected';
        latestQrDataUrl = null;
        const err = lastDisconnect && lastDisconnect.error;
        const statusCode = err && err.output ? err.output.statusCode : null;
        const reasonName = disconnectReasonName(statusCode);
        const message = err && err.message ? err.message : 'unknown';

        lastDisconnectInfo = { at: new Date().toISOString(), statusCode, reason: reasonName, message };
        detachSocket();
        if (stopping) return;
        log.logWarn('whatsapp', `Connection closed - code ${statusCode} (${reasonName}): ${message}`);

        // 401 / loggedOut: the phone side removed this device. The saved login
        // is dead, so keeping it would just loop forever. This is the ONLY
        // case where the saved login is wiped automatically.
        if (statusCode === DisconnectReason.loggedOut) {
          needsRelink = true;
          latestPairingCode = null;
          log.logWarn('whatsapp', 'WhatsApp logged this device out (someone removed it in Linked Devices, or WhatsApp removed it). Clearing the saved session and starting a fresh pairing.');
          await wipeSession('logged out by WhatsApp / the phone (401)');
          reconnectAttempts = 0;
          scheduleReconnect(5000, 'fresh pairing after logout');
          return;
        }

        // 440 / connectionReplaced: another copy now holds the session -
        // normally the NEW Render deploy taking over from this old one. Stop
        // writing to the Sheet (the new copy owns the login now) and don't
        // fight it. If no other copy is really running, we take it back
        // after a few minutes, starting from the latest login in the Sheet.
        if (statusCode === DisconnectReason.connectionReplaced) {
          replaced = true;
          authStore.freeze();
          log.logWarn('whatsapp', `Another copy of this bot took the session over (usually the new deploy). This copy stopped saving the login and will only retry in ${REPLACED_RETRY_MS / 60000} minutes. Make sure the bot runs in ONE place only (not also on a local PC).`);
          reconnectAttempts += 1;
          scheduleReconnect(REPLACED_RETRY_MS, 'connection replaced by another instance');
          return;
        }

        // 515 / restartRequired: normal right after a QR scan or pairing.
        if (statusCode === DisconnectReason.restartRequired) {
          scheduleReconnect(1000, 'restart required after pairing');
          return;
        }

        // Everything else (including 500 badSession, which WhatsApp also
        // sends for passing server trouble): keep the login and retry. The
        // old code wiped the login on 500, which forced a needless re-scan.
        reconnectAttempts += 1;
        if (reconnectAttempts % 10 === 0) {
          log.logWarn('whatsapp', `Still not connected after ${reconnectAttempts} attempts. If this keeps happening, use "Unlink & start over" in Settings.`);
        }
        const backoffMs = Math.min(60000, 5000 * reconnectAttempts);
        scheduleReconnect(backoffMs, reasonName);
        return;
      }

      if (connection === 'open') {
        sawQrOrOpen = true;
        connectionStatus = 'connected';
        latestQrDataUrl = null;
        latestQrAt = null;
        latestPairingCode = null;
        pendingPairingNumber = null;
        needsRelink = false;
        reconnectAttempts = 0;
        lastDisconnectInfo = null;
        log.logInfo('whatsapp', `WhatsApp connected as ${thisSock.user ? thisSock.user.id : 'unknown'}.`);
        authStore.flush().catch(() => {});
      }
    });

    thisSock.ev.on('messages.upsert', async (upsert) => {
      if (upsert.type !== 'notify') return;
      for (const msg of upsert.messages || []) {
        try {
          await handleIncomingMessage(msg);
        } catch (err) {
          log.logError('whatsapp', err, `Handling an incoming message from ${msg?.key?.remoteJid || 'unknown'} failed`);
        }
      }
    });

    return thisSock;
  } catch (err) {
    log.logError('whatsapp', err, 'Starting the WhatsApp socket failed');
    reconnectAttempts += 1;
    scheduleReconnect(Math.min(60000, 5000 * reconnectAttempts), 'startup failure');
    return null;
  } finally {
    starting = false;
  }
}

/**
 * Shutdown (Render redeploy): close the socket WITHOUT logging out, so the
 * login stays valid for the new deploy, then save anything still queued.
 */
async function stopWhatsApp() {
  stopping = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  detachSocket();
  connectionStatus = 'disconnected';
  await authStore.flush();
}

/* ============================================================================
 * SENDING
 * ==========================================================================*/

function assertConnected() {
  if (!isConnected()) {
    const detail = lastDisconnectInfo
      ? ` Last disconnect: code ${lastDisconnectInfo.statusCode} (${lastDisconnectInfo.reason}).`
      : '';
    throw new Error(`WhatsApp is not connected - the message was not sent.${detail}`);
  }
}

/** Used by followups.js to send a nudge without going through the AI. */
async function sendWhatsAppMessage(phone, text) {
  assertConnected();
  const lead = store.getLead(phone);
  const jid = lead?.jid || `${phone}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
  pushHistory(phone, 'assistant', text);
}

/** Used by the dashboard when a human takes over and types a manual reply. */
async function sendManualMessage(phone, text) {
  assertConnected();
  const lead = store.getLead(phone);
  const jid = lead?.jid || `${phone}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
  pushHistory(phone, 'assistant', text);
  store.logMessage(phone, 'human', text);
}

/* ============================================================================
 * STATUS + RELINK CONTROLS (used by the dashboard)
 * ==========================================================================*/

function getConnectionStatus() {
  return connectionStatus;
}

function getLatestQr() {
  return latestQrDataUrl;
}

function getPairingCode() {
  return latestPairingCode;
}

function getStatusPayload() {
  return {
    whatsapp: connectionStatus,
    connected: isConnected(),
    me: sock && sock.user ? sock.user.id : null,
    needsRelink,
    qr: latestQrDataUrl,
    qrAt: latestQrAt,
    pairingCode: latestPairingCode,
    pairingCodeAt: latestPairingCodeAt,
    pairingNumber: pendingPairingNumber,
    reconnectAttempts,
    lastDisconnect: lastDisconnectInfo,
    replaced,
    session: authStore.getInfo(),
  };
}

/** Full relink: clears the session everywhere and comes back on the QR flow. */
async function resetConnection() {
  try {
    if (sock && isConnected()) await sock.logout();
  } catch (err) {
    log.logWarn('whatsapp', `Logout call failed (continuing anyway): ${err.message}`);
  }
  pendingPairingNumber = null;
  latestPairingCode = null;
  latestQrDataUrl = null;
  connectionStatus = 'disconnected';
  reconnectAttempts = 0;
  needsRelink = true;
  replaced = false;
  detachSocket();
  await wipeSession('manual relink from the dashboard');
  return startWhatsApp();
}

/**
 * Phone-number pairing: WhatsApp shows an 8-character code that the client
 * types into their phone, instead of scanning a QR off a screenshot.
 * Phone: WhatsApp > Linked Devices > Link a device > "Link with phone number instead".
 */
async function startPairingWithNumber(rawNumber) {
  const number = String(rawNumber || '').replace(/\D/g, '');
  if (number.length < 8) {
    throw new Error('Enter the full WhatsApp number with country code and digits only, e.g. 447911123456.');
  }

  log.logInfo('whatsapp', `Starting phone-number pairing for +${number}.`);
  pendingPairingNumber = number;
  latestPairingCode = null;
  latestQrDataUrl = null;
  needsRelink = true;

  try {
    if (sock && isConnected()) await sock.logout();
  } catch (err) {
    log.logWarn('whatsapp', `Logout before pairing failed (continuing anyway): ${err.message}`);
  }

  replaced = false;
  detachSocket();
  await wipeSession('starting phone-number pairing');
  await startWhatsApp();

  const deadline = Date.now() + 25000;
  while (!latestPairingCode && Date.now() < deadline) {
    await sleep(500);
  }
  if (!latestPairingCode) {
    throw new Error('WhatsApp did not return a pairing code in time. Try again, or scan the QR code instead.');
  }
  return latestPairingCode;
}

/** Drops pairing-code mode and goes back to showing a QR. */
async function switchToQrMode() {
  pendingPairingNumber = null;
  latestPairingCode = null;
  log.logInfo('whatsapp', 'Switched back to QR code mode.');
  return startWhatsApp();
}

/** Dashboard "Reconnect now": e.g. after this copy was replaced and the other copy is gone. */
async function reconnectNow() {
  reconnectAttempts = 0;
  log.logInfo('whatsapp', 'Reconnect requested from the dashboard.');
  return startWhatsApp();
}

module.exports = {
  startWhatsApp,
  sendWhatsAppMessage,
  sendManualMessage,
  getConnectionStatus,
  getLatestQr,
  getPairingCode,
  getStatusPayload,
  resetConnection,
  startPairingWithNumber,
  switchToQrMode,
  isConnected,
  saveSessionNow,
  stopWhatsApp,
  reconnectNow,
};
