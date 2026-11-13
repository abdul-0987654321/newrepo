'use strict';
/**
 * instagram.js - Instagram Direct Message bot via Meta's official Instagram API.
 *
 * Flow:
 *   Instagram DM -> Meta webhook -> POST /webhook/instagram -> AI reply -> Graph Send API
 *
 * Meta's rules that are enforced here (not optional - breaking them gets the
 * app rejected or the account limited):
 *   - We can only reply INSIDE the 24-hour window that opens when the user
 *     messages us. We never send the first message.
 *   - Every webhook payload is signature-checked against the app secret.
 *   - Echo events (our own sent messages coming back) are ignored.
 *
 * Conversation state is kept in store.js exactly like WhatsApp leads, keyed
 * as "ig:<instagram-scoped-user-id>" so one dashboard shows both channels.
 */

const crypto = require('crypto');
const OpenAI = require('openai');
const config = require('./config');
const log = require('./errors');
const store = require('./store');

const GRAPH_VERSION = 'v23.0';

/**
 * The host has to match the KIND of token, or Meta answers "Cannot parse
 * access token" even though the token is perfectly valid:
 *   - "IGAA..." comes from API setup with Instagram login -> graph.instagram.com
 *   - "EAA..."/"EAG..." comes from Unified login or Facebook login
 *     -> graph.facebook.com
 * Newer Meta apps only offer Unified login, so EAA is the common case.
 */
function graphBase() {
  const token = String(config.instagram.accessToken || '');
  const host = token.startsWith('IGAA') ? 'graph.instagram.com' : 'graph.facebook.com';
  return `https://${host}/${GRAPH_VERSION}`;
}

/** Which login the token came from, for the dashboard's setup checklist. */
function tokenKind() {
  const token = String(config.instagram.accessToken || '');
  if (!token) return 'missing';
  if (token.startsWith('IGAA')) return 'instagram-login';
  if (token.startsWith('EAA') || token.startsWith('EAG')) return 'unified-login';
  return 'unrecognised';
}

// Meta's hard limit: no normal DM outside 24h of the user's last message.
const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

// Meta can retry the same webhook delivery. Replying twice to one DM looks
// broken to the customer, so remember recent message ids.
const SEEN_MESSAGE_IDS = new Map();
const SEEN_TTL_MS = 10 * 60 * 1000;

const stats = {
  posts: 0,          // raw webhook POSTs from Meta, before any filtering
  lastPostAt: null,
  received: 0,
  replied: 0,
  skippedOutsideWindow: 0,
  failed: 0,
  lastEventAt: null,
  lastError: null,
  webhookVerifiedAt: null,
};

let openaiClient = null;
function ai() {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  return openaiClient;
}

function isConfigured() {
  return Boolean(config.instagram.accessToken && config.instagram.accountId);
}

function rememberMessageId(id) {
  const now = Date.now();
  for (const [key, seenAt] of SEEN_MESSAGE_IDS) {
    if (now - seenAt > SEEN_TTL_MS) SEEN_MESSAGE_IDS.delete(key);
  }
  if (SEEN_MESSAGE_IDS.has(id)) return false;
  SEEN_MESSAGE_IDS.set(id, now);
  return true;
}

/* ------------------------- Webhook verification ------------------------- */

/**
 * Meta verifies a callback URL ONCE, when you save it - not on every boot.
 * So this has to outlive the process, or the dashboard would claim the
 * webhook was never set up after each redeploy. It goes in settings, which
 * are mirrored to the Google Sheet and restored on a fresh disk.
 */
function markWebhookSeen() {
  const now = new Date().toISOString();
  stats.webhookVerifiedAt = now;
  try {
    store.updateSettings({ igWebhookVerifiedAt: now });
  } catch (err) {
    log.logWarn('instagram', `Could not record the webhook verification: ${err.message}`);
  }
}

function webhookVerifiedAt() {
  if (stats.webhookVerifiedAt) return stats.webhookVerifiedAt;
  try {
    return store.getSettings().igWebhookVerifiedAt || null;
  } catch (err) {
    return null;
  }
}

/**
 * GET /webhook/instagram
 * Meta calls this once when you save the callback URL. It must echo back
 * hub.challenge as PLAIN TEXT, or the URL is rejected.
 */
function handleVerification(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.instagram.verifyToken) {
    markWebhookSeen();
    log.logInfo('instagram', 'Webhook verified by Meta.');
    return res.status(200).type('text/plain').send(challenge);
  }

  log.logWarn('instagram', 'Webhook verification failed - the verify token did not match IG_VERIFY_TOKEN.');
  return res.sendStatus(403);
}

/**
 * Meta signs every POST with the app secret. Without this check anyone who
 * learns the URL could feed fake messages into the bot.
 */
function verifySignature(req) {
  if (!config.instagram.appSecret) {
    log.logWarn('instagram', 'IG_APP_SECRET is not set - webhook payloads are NOT signature-checked.');
    return true;
  }
  const header = req.get('x-hub-signature-256') || '';
  if (!header.startsWith('sha256=') || !req.rawBody) return false;

  const expected = `sha256=${crypto
    .createHmac('sha256', config.instagram.appSecret)
    .update(req.rawBody)
    .digest('hex')}`;

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------- Incoming messages ------------------------- */

/**
 * POST /webhook/instagram
 * Answer 200 immediately - Meta retries (and eventually disables the
 * webhook) if we take too long - then process in the background.
 */
function handleWebhook(req, res) {
  // Log the arrival BEFORE anything can reject it. Without this, a webhook
  // that was received but then dropped (wrong signature, unexpected shape)
  // looks identical to one that never arrived, which makes setup
  // impossible to debug from the dashboard alone.
  stats.lastPostAt = new Date().toISOString();
  stats.posts += 1;

  if (!verifySignature(req)) {
    log.logWarn('instagram', 'A webhook POST arrived but its signature did not match IG_APP_SECRET - it was rejected. Check that IG_APP_SECRET is the app secret from App settings > Basic.');
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  const body = req.body || {};
  if (body.object !== 'instagram') {
    log.logInfo('instagram', `Webhook POST received, but for "${body.object || 'nothing'}" rather than instagram - ignored.`);
    return;
  }

  const count = (body.entry || []).reduce((n, e) => n + ((e.messaging || []).length), 0);
  log.logInfo('instagram', `Webhook POST received from Meta with ${count} event(s).`);

  // An event arriving proves the webhook works, which covers the case where
  // the URL was verified before this build started recording it. Only write
  // when it is not already known, so this does not hit the Sheet per message.
  if (!webhookVerifiedAt()) markWebhookSeen();

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      void processEvent(event).catch((err) => {
        stats.failed += 1;
        stats.lastError = err.message;
        log.logError('instagram', err, 'Processing an Instagram event failed');
      });
    }
  }
}

async function processEvent(event) {
  const senderId = event.sender && event.sender.id;
  const message = event.message;
  if (!senderId || !message) return;

  // Our own outgoing messages are echoed back to us - never reply to those.
  if (message.is_echo) return;

  // The account itself appearing as sender means an echo we did not tag.
  if (String(senderId) === String(config.instagram.accountId)) return;

  const messageId = message.mid;
  if (messageId && !rememberMessageId(messageId)) return;

  const text = (message.text || '').trim();
  stats.received += 1;
  stats.lastEventAt = new Date().toISOString();

  const leadKey = `ig:${senderId}`;

  // Attachments (photo, reel share, voice note) arrive with no text.
  if (!text) {
    store.logMessage(leadKey, 'user', '[attachment]');
    return;
  }

  store.upsertLead(leadKey, { source: 'instagram', lastContacted: new Date().toISOString() });
  store.logMessage(leadKey, 'user', text);

  const settings = store.getSettings();
  if (settings.igBotEnabled === false) return;

  const lead = store.getLead(leadKey);
  if (lead && lead.humanTakeover === true) return;

  // 24-hour window: the event we just received reopened it, so a reply to
  // THIS message is always allowed. The guard matters for queued/retried
  // deliveries that reach us late.
  const eventTime = event.timestamp ? Number(event.timestamp) : Date.now();
  if (Date.now() - eventTime > MESSAGING_WINDOW_MS) {
    stats.skippedOutsideWindow += 1;
    log.logWarn('instagram', `Skipped a reply to ${senderId} - the 24-hour messaging window had closed.`);
    return;
  }

  const reply = await generateReply(leadKey, text);
  if (!reply) return;

  await sendMessage(senderId, reply);
  store.logMessage(leadKey, 'assistant', reply);
  stats.replied += 1;
}

/* ------------------------- AI reply ------------------------- */

const DEFAULT_PROMPT = `You are the Instagram assistant for {business}. You are replying to a real person in Instagram DMs.

How to write:
- Short, friendly, DM-style. One or two sentences, never a wall of text.
- Sound like a helpful member of staff, not a script or a form.
- Never invent prices, stock, or availability. If you do not know something, offer to have someone from the team get back to them.

Your job is to understand what the person needs and collect their name and the best way to contact them, so the team can follow up.

Reply with ONLY a JSON object in this exact shape:
{
  "reply": "the message to send",
  "intent": "interested" | "not_interested" | "neutral",
  "name": "their name, or null if not mentioned",
  "contactNumber": "a phone number or email they gave, or null"
}`;

async function generateReply(leadKey, text) {
  const settings = store.getSettings();
  const lead = store.getLead(leadKey) || {};

  const prompt = (settings.igSystemPrompt || DEFAULT_PROMPT)
    .replace(/\{business\}/g, config.business.name);

  // Last 20 turns is plenty of context and keeps the token cost predictable.
  const history = store
    .getMessages(leadKey)
    .slice(-20)
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.text,
    }));

  const known = `Already on file for this person - never ask again for anything with a value here:
- Name: ${lead.name || 'not given yet'}
- Contact: ${lead.contactNumber || 'not given yet'}`;

  try {
    const completion = await ai().chat.completions.create({
      model: config.openai.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${prompt}\n\n${known}` },
        ...history,
      ],
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const patch = {};
    if (parsed.name) patch.name = parsed.name;
    if (parsed.contactNumber) patch.contactNumber = parsed.contactNumber;
    if (parsed.intent === 'interested' || parsed.intent === 'not_interested') {
      patch.status = parsed.intent;
    }
    if (Object.keys(patch).length) store.upsertLead(leadKey, patch);

    return String(parsed.reply || '').trim() || null;
  } catch (err) {
    log.logError('instagram', err, `Generating a reply for ${leadKey} failed`);
    stats.lastError = err.message;
    return null;
  }
}

/* ------------------------- Sending ------------------------- */

/**
 * Sends a DM through the Instagram Send API. Only valid inside the 24-hour
 * window - Meta returns error code 10 / subcode 2534022 once it has closed.
 */
async function sendMessage(recipientId, text) {
  if (!isConfigured()) {
    throw new Error('Instagram is not configured - set IG_ACCESS_TOKEN and IG_ACCOUNT_ID.');
  }

  const url = `${graphBase()}/${config.instagram.accountId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.instagram.accessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: String(recipientId) },
      message: { text: String(text).slice(0, 1000) },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.error || {};
    stats.failed += 1;
    stats.lastError = error.message || `HTTP ${response.status}`;
    throw new Error(
      `Instagram send failed (${response.status}): ${error.message || 'unknown error'}` +
        (error.code ? ` [code ${error.code}${error.error_subcode ? `/${error.error_subcode}` : ''}]` : '')
    );
  }
  return payload;
}

/** Used by the dashboard's manual-reply box. */
async function sendManualMessage(leadKey, text) {
  const senderId = String(leadKey).replace(/^ig:/, '');
  await sendMessage(senderId, text);
  store.logMessage(`ig:${senderId}`, 'human', text);
  return { ok: true };
}

/* ------------------------- Status ------------------------- */

/** Confirms the token actually works, so the dashboard can show a real state. */
async function checkConnection() {
  if (!isConfigured()) {
    return { connected: false, reason: 'Not configured - IG_ACCESS_TOKEN or IG_ACCOUNT_ID is missing.' };
  }
  try {
    // graph.facebook.com/me on a Unified-login token resolves to the user,
    // not the Instagram account, so ask for the account by its id instead.
    const path = tokenKind() === 'instagram-login' ? 'me' : String(config.instagram.accountId);
    const url = `${graphBase()}/${path}?fields=id,username`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.instagram.accessToken}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      let reason = (payload.error && payload.error.message) || `HTTP ${response.status}`;
      if (tokenKind() === 'unrecognised') {
        reason += ' - the token does not start with IGAA, EAA or EAG, so it looks truncated or is not an access token.';
      }
      return { connected: false, reason, tokenKind: tokenKind() };
    }
    return { connected: true, username: payload.username, id: payload.id, tokenKind: tokenKind() };
  } catch (err) {
    return { connected: false, reason: err.message };
  }
}

function getStatusPayload() {
  return {
    configured: isConfigured(),
    accountId: config.instagram.accountId || null,
    tokenKind: tokenKind(),
    graphHost: graphBase().replace('https://', '').split('/')[0],
    ...stats,
    webhookVerifiedAt: webhookVerifiedAt(),
  };
}

module.exports = {
  handleVerification,
  handleWebhook,
  sendMessage,
  sendManualMessage,
  checkConnection,
  getStatusPayload,
  isConfigured,
  DEFAULT_PROMPT,
};
