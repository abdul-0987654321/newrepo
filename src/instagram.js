'use strict';
/**
 * instagram.js - Instagram Direct Message bot.
 *
 * Flow:
 *   Instagram DM -> webhook -> POST /webhook/instagram -> AI reply -> send
 *
 * Two providers can carry those messages, chosen by IG_PROVIDER:
 *   "meta"      - our own Meta app talking to the Graph API directly. Free,
 *                 but Instagram only forwards real DMs once Meta has
 *                 approved the app, so it is silent until then.
 *   "instantdm" - InstantDM's already-approved app acts as the pipe. No App
 *                 Review, but their API is a paid tier.
 *
 * Only the signature check and the send call differ between them: InstantDM
 * forwards Meta's own payload shape, so everything in between - parsing, the
 * AI reply, the lead store, the dashboard - is shared.
 *
 * Instagram's own rules are enforced here whichever provider is in use,
 * because they come from Meta either way:
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

/** True when IG_PROVIDER names InstantDM rather than our own Meta app. */
function usingInstantDm() {
  return config.instagram.provider === 'instantdm';
}

function isConfigured() {
  if (usingInstantDm()) return Boolean(config.instagram.instantdmApiKey);
  return Boolean(config.instagram.accessToken && config.instagram.accountId);
}

/** What is missing, in the words of the setting the person has to fill in. */
function missingSetting() {
  if (usingInstantDm()) {
    return config.instagram.instantdmApiKey ? null : 'INSTANTDM_API_KEY';
  }
  if (!config.instagram.accessToken) return 'IG_ACCESS_TOKEN';
  if (!config.instagram.accountId) return 'IG_ACCOUNT_ID';
  return null;
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

/** Constant-time compare that tolerates different lengths. */
function sameDigest(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Both providers sign the POST so that nobody who merely learns the URL can
 * feed fake messages into the bot. The algorithm is the same - HMAC-SHA256
 * over the RAW body - but the header and the secret differ:
 *   meta:      x-hub-signature-256, "sha256=<hex>", signed with the app secret
 *   instantdm: x-webhook-signature, bare hex, signed with the webhook secret
 *
 * The raw bytes matter: re-serialising the parsed JSON can reorder keys or
 * change spacing, and then a perfectly valid signature fails.
 */
function verifySignature(req) {
  return usingInstantDm() ? verifyInstantDmSignature(req) : verifyMetaSignature(req);
}

function verifyMetaSignature(req) {
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

  return sameDigest(header, expected);
}

function verifyInstantDmSignature(req) {
  const secret = config.instagram.instantdmWebhookSecret;
  if (!secret) {
    log.logWarn('instagram', 'INSTANTDM_WEBHOOK_SECRET is not set - webhook payloads are NOT signature-checked.');
    return true;
  }

  const header = req.get('x-webhook-signature') || '';
  if (!header) return false;

  // Their docs show a bare hex digest; some of their examples show the
  // "sha256=" prefix Meta uses. Accept either rather than reject a good one.
  const sent = header.startsWith('sha256=') ? header.slice(7) : header;

  // Their own sample signs JSON.stringify(payload) while their docs say the
  // raw body. Those are normally the same bytes, but not if anything on the
  // way re-encodes the request. Accept either, so a genuine message is never
  // thrown away over a formatting detail - both still prove the secret.
  const candidates = [];
  if (req.rawBody) candidates.push(req.rawBody);
  if (req.body) {
    try {
      const restringified = JSON.stringify(req.body);
      if (!req.rawBody || restringified !== req.rawBody.toString('utf8')) {
        candidates.push(restringified);
      }
    } catch (err) { /* unserialisable body - the raw one is all we have */ }
  }

  return candidates.some((payload) =>
    sameDigest(sent, crypto.createHmac('sha256', secret).update(payload).digest('hex'))
  );
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

  const events = extractEvents(body);
  log.logInfo('instagram', `Webhook POST received from Meta with ${events.length} event(s).`);

  // With nothing to act on, record the shape rather than the content: it is
  // the only way to tell a harmless test ping from a payload we failed to
  // understand, and it keeps message text out of the log.
  if (!events.length) {
    log.logInfo('instagram', `No message events in that POST. Shape: ${describeShape(body)}`);
  }

  // An event arriving proves the webhook works, which covers the case where
  // the URL was verified before this build started recording it. Only write
  // when it is not already known, so this does not hit the Sheet per message.
  if (!webhookVerifiedAt()) markWebhookSeen();

  for (const event of events) {
    void processEvent(event).catch((err) => {
      stats.failed += 1;
      stats.lastError = err.message;
      log.logError('instagram', err, 'Processing an Instagram event failed');
    });
  }
}

/**
 * Meta does not deliver Instagram DMs in one single shape. The documented
 * one is entry[].messaging[], but installs have been seen receiving them as
 * entry[].changes[] with field "messages" instead, and the value there is
 * sometimes a Cloud-API style { messages: [...] } array. Accepting all three
 * costs nothing and avoids a silent do-nothing bot if Meta routes a given
 * app the other way.
 */
function extractEvents(body) {
  const events = [];

  for (const entry of body.entry || []) {
    // Shape 1: the documented Messenger-style envelope.
    for (const event of entry.messaging || []) events.push(event);

    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};

      // Shape 2: the same event body, wrapped in a change.
      if (value.sender || value.message) {
        events.push(value);
        continue;
      }

      // Shape 3: Cloud-API style array of messages.
      for (const msg of value.messages || []) {
        events.push({
          sender: { id: msg.from || (value.contacts && value.contacts[0] && value.contacts[0].wa_id) },
          timestamp: msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now(),
          message: {
            mid: msg.id,
            text: msg.text ? msg.text.body : '',
          },
        });
      }
    }
  }

  return events;
}

/** Keys only - never values, so no message text reaches the log. */
function describeShape(body) {
  const entries = body.entry || [];
  if (!entries.length) return 'entry: []';
  return entries
    .map((e) => {
      const parts = Object.keys(e).filter((k) => k !== 'id' && k !== 'time');
      const changes = (e.changes || []).map((c) => `field=${c.field}`).join(',');
      return parts.length ? `entry{${parts.join(',')}}${changes ? ` [${changes}]` : ''}` : 'entry{id,time only}';
    })
    .join(' | ');
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
    // Meta's "Test" button in the webhook table sends a canned payload with
    // a years-old timestamp, which lands here and reads like a real problem.
    // Say which it is, or setup looks broken when it is working.
    const ageDays = Math.round((Date.now() - eventTime) / 86400000);
    if (ageDays > 7) {
      log.logInfo('instagram', `Ignored a sample payload (sender ${senderId}, dated ${ageDays} days ago). This is Meta's Test button, not a real DM - send an actual message to test properly.`);
    } else {
      log.logWarn('instagram', `Skipped a reply to ${senderId} - the 24-hour messaging window had closed.`);
    }
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

const INSTANTDM_ACTION_URL = 'https://openapi.instantdm.com/action';

/**
 * Sends a DM. Only valid inside the 24-hour window whichever provider is
 * used, because the limit is Meta's: the Graph API answers with error code
 * 10 / subcode 2534022 once it has closed, and InstantDM passes that on.
 */
async function sendMessage(recipientId, text) {
  const missing = missingSetting();
  if (missing) {
    throw new Error(`Instagram is not configured - set ${missing}.`);
  }
  const body = String(text).slice(0, 1000);
  return usingInstantDm()
    ? sendViaInstantDm(recipientId, body)
    : sendViaMeta(recipientId, body);
}

async function sendViaMeta(recipientId, text) {
  const url = `${graphBase()}/${config.instagram.accountId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.instagram.accessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: String(recipientId) },
      message: { text },
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

/**
 * InstantDM exposes one endpoint that takes an "action". Every sent message
 * costs one credit of their plan, so a failure here is worth logging
 * precisely rather than retrying blindly.
 */
async function sendViaInstantDm(recipientId, text) {
  const response = await fetch(INSTANTDM_ACTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.instagram.instantdmApiKey}`,
    },
    body: JSON.stringify({
      action: 'send_message',
      type: 'text',
      recipient_id: String(recipientId),
      message: text,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const reason =
      (payload.error && (payload.error.message || payload.error)) ||
      payload.message ||
      `HTTP ${response.status}`;
    stats.failed += 1;
    stats.lastError = String(reason);
    throw new Error(`InstantDM send failed (${response.status}): ${reason}`);
  }
  return payload;
}

/**
 * Asks Meta which webhook fields IT thinks this app is subscribed to for
 * this account. The toggles in Meta's console are easy to misread and a
 * subscription can go stale, so this is the only way to know for certain
 * whether a real DM would ever be forwarded. An empty list is the answer
 * to "Meta reaches my server for Test payloads but never for real DMs".
 */
async function checkSubscription() {
  // Only meaningful for our own Meta app. With InstantDM the subscription is
  // theirs, and what matters instead is whether their webhook points here.
  if (usingInstantDm()) {
    return { ok: true, notApplicable: true, hasMessages: true, fields: [] };
  }
  if (!isConfigured()) {
    return { ok: false, reason: 'Instagram is not configured yet.' };
  }
  try {
    const url = `${graphBase()}/${config.instagram.accountId}/subscribed_apps`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.instagram.accessToken}` },
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        ok: false,
        reason: (payload.error && payload.error.message) || `HTTP ${response.status}`,
      };
    }

    const apps = payload.data || [];
    const fields = apps.flatMap((a) => a.subscribed_fields || []);
    return {
      ok: true,
      apps: apps.length,
      fields,
      hasMessages: fields.includes('messages'),
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Used by the dashboard's manual-reply box. */
async function sendManualMessage(leadKey, text) {
  const senderId = String(leadKey).replace(/^ig:/, '');
  await sendMessage(senderId, text);
  store.logMessage(`ig:${senderId}`, 'human', text);
  return { ok: true };
}

/* ------------------------- Status ------------------------- */

/** Confirms the credentials actually work, so the dashboard shows a real state. */
async function checkConnection() {
  const missing = missingSetting();
  if (missing) {
    return { connected: false, reason: `Not configured - ${missing} is missing.` };
  }

  // InstantDM's API has no free "who am I" call, and every send costs a
  // credit, so we do not burn one to draw a green dot. The key is reported
  // as present, and the first real reply proves the rest.
  if (usingInstantDm()) {
    return {
      connected: true,
      provider: 'instantdm',
      unverified: true,
      reason: 'API key is set. InstantDM has no free status call, so this is confirmed by the first reply it sends.',
    };
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
    provider: usingInstantDm() ? 'instantdm' : 'meta',
    missingSetting: missingSetting(),
    accountId: config.instagram.accountId || null,
    tokenKind: tokenKind(),
    graphHost: usingInstantDm()
      ? 'openapi.instantdm.com'
      : graphBase().replace('https://', '').split('/')[0],
    signatureChecked: usingInstantDm()
      ? Boolean(config.instagram.instantdmWebhookSecret)
      : Boolean(config.instagram.appSecret),
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
  checkSubscription,
  getStatusPayload,
  isConfigured,
  DEFAULT_PROMPT,
};
