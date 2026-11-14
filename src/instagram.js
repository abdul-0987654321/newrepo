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
  posts: 0,          // raw webhook POSTs from the provider, before filtering
  lastPostAt: null,
  received: 0,
  replied: 0,
  markedRead: 0,
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

/** True when Zernio is carrying the messages. */
function usingZernio() {
  return config.instagram.provider === 'zernio';
}

/** A provider other than our own Meta app is in front of Instagram. */
function usingRelay() {
  return usingInstantDm() || usingZernio();
}

function isConfigured() {
  if (usingInstantDm()) return Boolean(config.instagram.instantdmApiKey);
  if (usingZernio()) {
    return Boolean(config.instagram.zernioApiKey && config.instagram.zernioAccountId);
  }
  return Boolean(config.instagram.accessToken && config.instagram.accountId);
}

/** What is missing, in the words of the setting the person has to fill in. */
function missingSetting() {
  if (usingInstantDm()) {
    return config.instagram.instantdmApiKey ? null : 'INSTANTDM_API_KEY';
  }
  if (usingZernio()) {
    if (!config.instagram.zernioApiKey) return 'ZERNIO_API_KEY';
    if (!config.instagram.zernioAccountId) return 'ZERNIO_ACCOUNT_ID';
    return null;
  }
  if (!config.instagram.accessToken) return 'IG_ACCESS_TOKEN';
  if (!config.instagram.accountId) return 'IG_ACCOUNT_ID';
  return null;
}

/** The provider's name, for log lines and the dashboard. */
function providerName() {
  if (usingInstantDm()) return 'InstantDM';
  if (usingZernio()) return 'Zernio';
  return 'Meta';
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
  if (usingInstantDm()) return verifyInstantDmSignature(req);
  if (usingZernio()) return verifyZernioSignature(req);
  return verifyMetaSignature(req);
}

/**
 * Zernio signs the raw body with HMAC-SHA256, lowercase hex, in
 * X-Zernio-Signature (X-Late-Signature is their legacy alias for the same
 * value). The secret is one we chose and gave them when registering the
 * endpoint - they only sign deliveries for endpoints that have one, so an
 * unsigned delivery means the secret was never registered.
 */
function verifyZernioSignature(req) {
  const secret = config.instagram.zernioWebhookSecret;
  if (!secret) {
    log.logWarn('instagram', 'ZERNIO_WEBHOOK_SECRET is not set - webhook payloads are NOT signature-checked.');
    return true;
  }

  const header = req.get('x-zernio-signature') || req.get('x-late-signature') || '';
  if (!header || !req.rawBody) return false;

  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  return sameDigest(header.toLowerCase(), expected);
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

  // Meta and InstantDM both send Meta's envelope, which names its product.
  // Zernio sends its own, named by the event instead.
  if (!usingZernio() && body.object !== 'instagram') {
    log.logInfo('instagram', `Webhook POST received, but for "${body.object || 'nothing'}" rather than instagram - ignored.`);
    return;
  }

  const events = extractEvents(body);
  // Name the provider the message actually came through: reading "from Meta"
  // while running on another provider makes the log useless for working out
  // which half of the chain is at fault.
  const via = usingZernio() && body.event ? `${providerName()} (${body.event})` : providerName();
  log.logInfo('instagram', `Webhook POST received from ${via} with ${events.length} event(s).`);

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
/**
 * Finds the first usable string under any of these key names, anywhere in
 * the payload. Zernio does not publish the message.received schema, so
 * rather than guess one shape and answer nothing when it differs, we look
 * for the handful of names it could reasonably use. The first real delivery
 * then tells us the truth, logged as a shape with no message content.
 */
function findValue(node, keys, options = {}, depth = 0) {
  const { allowId = false } = options;
  if (!node || typeof node !== 'object' || depth > 6) return null;

  for (const key of keys) {
    const value = node[key];
    if (typeof value === 'string' && value.trim()) return value;

    // "sender": { "id": ... } and "message": { "text": ... } both occur.
    // Falling back to .id is right when looking for an identifier and
    // actively wrong when looking for message text - that is how an id ends
    // up displayed as what the customer said.
    if (value && typeof value === 'object') {
      const nested = allowId ? (value.id || value.text || value.body) : (value.text || value.body);
      if (typeof nested === 'string' && nested.trim()) return nested;
    }
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = findValue(value, keys, options, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Guards against the same mistake from the other end: a value that parsed as
 * "text" but is plainly an identifier. Showing an id as the customer's
 * message is worse than showing nothing, because it looks like they sent it.
 */
function looksLikeAnId(value, ids) {
  if (!value) return true;
  const text = String(value).trim();
  if (ids.some((id) => id && String(id) === text)) return true;
  // A long unbroken run of hex or a UUID is an id, not something anyone typed.
  if (/^[0-9a-f]{16,}$/i.test(text)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return true;
  return false;
}

const ZERNIO_FIELDS = {
  conversation: ['conversationId', 'conversation_id', 'conversation', 'threadId'],
  sender: ['senderId', 'sender', 'contactId', 'contact', 'from', 'participantId'],
  text: ['text', 'body', 'message', 'content'],
  messageId: ['messageId', 'message_id', 'externalMessageId', 'mid'],
};

/**
 * Turns one Zernio webhook into the same event shape the Meta path uses, so
 * everything downstream is shared. Replies go to a conversation rather than
 * a user, so the conversation id is carried along and stored on the lead.
 */
function extractZernioEvents(body) {
  if (typeof body.event !== 'string') return [];
  // Only inbound messages. Reactions, echoes, posts and the test ping all
  // arrive here too, and answering any of them would be wrong.
  if (body.event !== 'message.received') return [];

  // Their own sends come back flagged rather than as a separate event.
  const meta = body.metadata || (body.data && body.data.metadata) || {};
  if (meta.isEcho === true || meta.echo === true) return [];

  const conversationId = findValue(body, ZERNIO_FIELDS.conversation, { allowId: true });
  const senderId = findValue(body, ZERNIO_FIELDS.sender, { allowId: true });
  const messageId = findValue(body, ZERNIO_FIELDS.messageId, { allowId: true });

  const text = findValue(body, ZERNIO_FIELDS.text);
  if (!conversationId) return [];

  if (looksLikeAnId(text, [conversationId, senderId, messageId, config.instagram.zernioAccountId])) {
    log.logWarn('instagram', `A message.received payload had no readable text - the field names must differ from the ones expected. Shape: ${describeShape(body)}`);
    return [];
  }

  return [{
    // Without a sender we still have a conversation, which is enough both to
    // reply and to keep the history together.
    sender: { id: senderId || conversationId },
    conversationId,
    timestamp: body.timestamp ? new Date(body.timestamp).getTime() : Date.now(),
    message: {
      mid: messageId || `${body.id || 'zernio'}:${conversationId}`,
      text,
    },
  }];
}

function extractEvents(body) {
  if (usingZernio()) return extractZernioEvents(body);

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
  // Zernio's schema is not published, so when nothing could be extracted the
  // key layout is exactly what is needed to fix it - and it must carry no
  // message text with it.
  if (usingZernio()) {
    const outline = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 2) return '';
      return Object.entries(node)
        .map(([k, v]) => {
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const inner = outline(v, depth + 1);
            return inner ? `${k}{${inner}}` : k;
          }
          if (Array.isArray(v)) return `${k}[${v.length}]`;
          return k;
        })
        .join(',');
    };
    return `event=${body.event || 'none'} ${outline(body)}`;
  }

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

  const patch = { source: 'instagram', lastContacted: new Date().toISOString() };
  // Zernio replies to a conversation, not to a person, so the id has to be
  // kept - without it a reply typed later from the dashboard has nowhere to
  // go, even though the conversation is sitting right there.
  if (event.conversationId) patch.conversationId = event.conversationId;
  store.upsertLead(leadKey, patch);
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

  // Mark it seen BEFORE writing the reply. Generating an answer takes a few
  // seconds, and in that gap the person is looking at an unread conversation
  // wondering whether anyone is there. The receipt costs nothing and never
  // blocks the reply.
  void markConversationRead(event.conversationId);

  const reply = await generateReply(leadKey, text);
  if (!reply) return;

  await sendMessage(senderId, reply, { conversationId: event.conversationId });
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
async function sendMessage(recipientId, text, options = {}) {
  const missing = missingSetting();
  if (missing) {
    throw new Error(`Instagram is not configured - set ${missing}.`);
  }
  const body = String(text).slice(0, 1000);

  if (usingZernio()) {
    const conversationId = options.conversationId
      || (store.getLead(`ig:${recipientId}`) || {}).conversationId;
    if (!conversationId) {
      throw new Error('No Zernio conversation id for this person - a reply can only be sent inside a conversation they started.');
    }
    return sendViaZernio(conversationId, body);
  }

  return usingInstantDm()
    ? sendViaInstantDm(recipientId, body)
    : sendViaMeta(recipientId, body);
}

const ZERNIO_API_BASE = 'https://zernio.com/api/v1';

/**
 * Sends a real mark_seen read receipt, so the person sees the conversation
 * as read rather than being left with a lit notification the bot already
 * dealt with. Only Zernio offers this - InstantDM has no endpoint for it and
 * Meta's needs an approved app.
 *
 * Best-effort by design: Meta can drop the receipt without failing the call,
 * and a receipt is never worth losing a reply over, so this never throws.
 */
async function markConversationRead(conversationId, { quiet = false } = {}) {
  if (!usingZernio() || !conversationId || !isConfigured()) return false;

  try {
    const url = `${ZERNIO_API_BASE}/inbox/conversations/${encodeURIComponent(conversationId)}/read`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.instagram.zernioApiKey}`,
      },
      body: JSON.stringify({ accountId: config.instagram.zernioAccountId }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const reason = payload.error || payload.message || `HTTP ${response.status}`;
      if (!quiet) {
        log.logWarn('instagram', `Could not mark the conversation as seen: ${reason}`);
      }
      return false;
    }
    stats.markedRead += 1;
    return true;
  } catch (err) {
    if (!quiet) {
      log.logWarn('instagram', `Could not mark the conversation as seen: ${err.message}`);
    }
    return false;
  }
}

/**
 * Zernio addresses the conversation, not the person, and the account id goes
 * in the body because one API key can hold several connected accounts.
 */
async function sendViaZernio(conversationId, text) {
  const url = `${ZERNIO_API_BASE}/inbox/conversations/${encodeURIComponent(conversationId)}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.instagram.zernioApiKey}`,
    },
    body: JSON.stringify({
      accountId: config.instagram.zernioAccountId,
      message: text,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = payload.error || payload.message || `HTTP ${response.status}`;
    stats.failed += 1;
    stats.lastError = String(reason);
    throw new Error(
      `Zernio send failed (${response.status}): ${reason}` +
        (payload.code ? ` [${payload.code}]` : '')
    );
  }
  return payload;
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
  if (usingRelay()) {
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
  const lead = store.getLead(`ig:${senderId}`) || {};
  // Typing a reply by hand means it has certainly been read.
  void markConversationRead(lead.conversationId);
  await sendMessage(senderId, text, { conversationId: lead.conversationId });
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

  // Zernio charges for sends, not reads, so listing one conversation is a
  // free way to prove the key actually works rather than merely existing.
  if (usingZernio()) {
    try {
      const url = `${ZERNIO_API_BASE}/inbox/conversations?accountId=${encodeURIComponent(config.instagram.zernioAccountId)}&limit=1`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${config.instagram.zernioApiKey}` },
      });
      if (response.status === 401 || response.status === 403) {
        const payload = await response.json().catch(() => ({}));
        return {
          connected: false,
          provider: 'zernio',
          reason: payload.error || payload.message || 'Zernio rejected the API key.',
        };
      }
      // Any other status means the key authenticated, even if the query
      // itself was not to their liking.
      return { connected: true, provider: 'zernio' };
    } catch (err) {
      return { connected: false, provider: 'zernio', reason: err.message };
    }
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
    provider: config.instagram.provider,
    providerName: providerName(),
    missingSetting: missingSetting(),
    accountId: usingZernio()
      ? config.instagram.zernioAccountId || null
      : config.instagram.accountId || null,
    tokenKind: tokenKind(),
    graphHost: usingInstantDm()
      ? 'openapi.instantdm.com'
      : (usingZernio() ? 'zernio.com' : graphBase().replace('https://', '').split('/')[0]),
    signatureChecked: usingInstantDm()
      ? Boolean(config.instagram.instantdmWebhookSecret)
      : (usingZernio()
        ? Boolean(config.instagram.zernioWebhookSecret)
        : Boolean(config.instagram.appSecret)),
    ...stats,
    webhookVerifiedAt: webhookVerifiedAt(),
  };
}

module.exports = {
  handleVerification,
  handleWebhook,
  sendMessage,
  sendManualMessage,
  markConversationRead,
  checkConnection,
  checkSubscription,
  getStatusPayload,
  isConfigured,
  DEFAULT_PROMPT,
};
