'use strict';
/**
 * instagram.js - Instagram Direct Message bot via igramapi (unofficial).
 *
 * This replaces the previous Meta Graph API build. No Meta app, no app review,
 * no 24-hour messaging window - we log in as the account itself, the same way
 * the phone app does.
 *
 * Flow:
 *   login (username/password) -> poll the direct inbox -> AI reply -> send DM
 *
 * What this costs us, compared with the official API:
 *   - Instagram can flag or ban the account. Logging in from a datacentre IP
 *     (Render) is the single biggest trigger, so IG_PROXY exists below.
 *   - There is no webhook. We poll, so replies lag by up to one poll interval.
 *   - The session has to be reused. Logging in fresh on every boot is what
 *     gets accounts checkpointed, so the serialized state is written to disk
 *     and restored before any request is made.
 *
 * Conversation state is kept in store.js exactly like WhatsApp leads, keyed
 * as "ig:<instagram-user-pk>" so one dashboard shows both channels.
 */

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { IgApiClient } = require('igramapi');
const config = require('./config');
const log = require('./errors');
const store = require('./store');

/**
 * How often we ask Instagram for the inbox. Instagram does not publish a
 * limit, but polling hard from one IP is what gets an account rate-limited,
 * so this is deliberately slow and jittered - two bots on the same host do
 * not line up and hit the API in the same second.
 */
const POLL_INTERVAL_MS = Number(process.env.IG_POLL_SECONDS || 60) * 1000;
const POLL_JITTER_MS = 15 * 1000;

/** Never reply to a DM older than this, so a backlog is not answered at once. */
const MAX_REPLY_AGE_MS = 6 * 60 * 60 * 1000;

/** Instagram returns direct-message timestamps in MICROseconds. */
function itemTimeMs(item) {
  const raw = Number(item.timestamp || 0);
  if (!raw) return 0;
  return raw > 1e14 ? Math.round(raw / 1000) : raw;
}

let ig = null;
let selfPk = null;
let pollTimer = null;
let polling = false;

/**
 * Newest message we have already dealt with, per thread. Seeded on the first
 * poll after boot so the bot does not wake up and answer every old DM in the
 * inbox - it only ever replies to messages that arrive while it is running.
 */
const lastSeenByThread = new Map();
let seeded = false;

const stats = {
  loggedIn: false,
  username: null,
  loginAt: null,
  polls: 0,
  lastPollAt: null,
  received: 0,
  replied: 0,
  skippedOld: 0,
  failed: 0,
  lastEventAt: null,
  lastError: null,
  challengeRequired: false,
};

let openaiClient = null;
function ai() {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  return openaiClient;
}

function isConfigured() {
  return Boolean(config.instagram.username && config.instagram.password);
}

/* ------------------------- Session persistence ------------------------- */

function sessionFile() {
  return path.join(config.instagram.sessionDir, 'ig-session.json');
}

/**
 * Written after every request. Instagram ties a session to a device
 * fingerprint, so losing this file means a fresh login - and a string of
 * fresh logins from a server IP is exactly what triggers a checkpoint.
 * On Render this must point at the persistent disk, not the container.
 */
async function saveSession() {
  try {
    const serialized = await ig.state.serialize();
    // The library's own constant set should win on upgrade, not a stale copy.
    delete serialized.constants;
    fs.mkdirSync(config.instagram.sessionDir, { recursive: true });
    fs.writeFileSync(sessionFile(), JSON.stringify(serialized), 'utf8');
  } catch (err) {
    log.logWarn('instagram', `Could not save the Instagram session: ${err.message}`);
  }
}

function loadSession() {
  try {
    if (!fs.existsSync(sessionFile())) return null;
    return JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
  } catch (err) {
    log.logWarn('instagram', `Could not read the saved Instagram session: ${err.message}`);
    return null;
  }
}

function clearSession() {
  try {
    if (fs.existsSync(sessionFile())) fs.unlinkSync(sessionFile());
  } catch (err) {
    log.logWarn('instagram', `Could not clear the Instagram session: ${err.message}`);
  }
}

/* ------------------------- Login ------------------------- */

/**
 * Logs in, reusing the saved session when there is one. Returns false rather
 * than throwing, so a bad Instagram password cannot stop the whole app (and
 * WhatsApp with it) from booting.
 */
async function login() {
  if (!isConfigured()) {
    log.logInfo('instagram', 'Instagram is not configured - set IG_USERNAME and IG_PASSWORD to turn the DM bot on.');
    return false;
  }

  ig = new IgApiClient();

  // The device fingerprint is derived from the username, so it stays the
  // same across restarts - a changing device looks like a new phone to
  // Instagram and invites a verification challenge.
  ig.state.generateDevice(config.instagram.username);
  if (config.instagram.proxyUrl) ig.state.proxyUrl = config.instagram.proxyUrl;

  // Persist state after every request, as the library intends.
  ig.request.end$.subscribe(() => {
    void saveSession();
  });

  const saved = loadSession();
  if (saved) {
    try {
      await ig.state.deserialize(saved);
      log.logInfo('instagram', 'Restored the saved Instagram session.');
    } catch (err) {
      log.logWarn('instagram', `The saved session was unusable, logging in fresh: ${err.message}`);
    }
  }

  try {
    // With a restored session this usually resolves without a real login
    // round-trip; currentUser() is the cheapest way to find out whether the
    // session is still good.
    let me = null;
    if (saved) {
      try {
        me = await ig.account.currentUser();
      } catch (err) {
        log.logInfo('instagram', 'The saved session has expired - logging in again.');
      }
    }

    if (!me) {
      await ig.account.login(config.instagram.username, config.instagram.password);
      me = await ig.account.currentUser();
    }

    selfPk = String(me.pk);
    stats.loggedIn = true;
    stats.username = me.username;
    stats.loginAt = new Date().toISOString();
    stats.challengeRequired = false;
    stats.lastError = null;
    log.logInfo('instagram', `Logged in to Instagram as @${me.username}.`);
    return true;
  } catch (err) {
    stats.loggedIn = false;
    stats.lastError = err.message;

    // A checkpoint cannot be cleared from here - it needs the code Instagram
    // emailed or texted, entered in the app. Say so plainly instead of
    // retrying in a loop, which only makes the flag worse.
    const name = (err && err.name) || '';
    if (name.includes('Checkpoint') || name.includes('Challenge')) {
      stats.challengeRequired = true;
      clearSession();
      log.logError('instagram', err, 'Instagram asked for a verification challenge. Open Instagram on the phone or browser for this account, approve the login, then restart the service. A residential IG_PROXY makes this far less likely.');
      return false;
    }

    if (name.includes('BadPassword') || name.includes('LoginRequired')) {
      clearSession();
    }

    log.logError('instagram', err, 'Instagram login failed');
    return false;
  }
}

/* ------------------------- Inbox polling ------------------------- */

/**
 * One pass over the direct inbox. Only the first page is read - a reply that
 * matters is always on the first page, and paging the whole inbox every
 * minute is a reliable way to get rate-limited.
 */
async function pollOnce() {
  if (!stats.loggedIn || polling) return;
  polling = true;
  stats.polls += 1;
  stats.lastPollAt = new Date().toISOString();

  try {
    const inbox = ig.feed.directInbox();
    const threads = await inbox.items();

    // First pass after boot: note where every thread stands and answer
    // nothing. Without this the bot replies to the entire existing inbox the
    // moment it starts.
    if (!seeded) {
      for (const thread of threads) {
        const newest = (thread.items || [])[0];
        lastSeenByThread.set(thread.thread_id, newest ? itemTimeMs(newest) : 0);
      }
      seeded = true;
      log.logInfo('instagram', `Watching ${threads.length} Instagram thread(s). Only new messages from here on will be answered.`);
      return;
    }

    for (const thread of threads) {
      await handleThread(thread).catch((err) => {
        stats.failed += 1;
        stats.lastError = err.message;
        log.logError('instagram', err, `Handling Instagram thread ${thread.thread_id} failed`);
      });
    }
  } catch (err) {
    stats.failed += 1;
    stats.lastError = err.message;

    // A session can die mid-run (password change, Instagram logging us out).
    const name = (err && err.name) || '';
    if (name.includes('LoginRequired') || name.includes('Checkpoint') || name.includes('Challenge')) {
      stats.loggedIn = false;
      log.logError('instagram', err, 'The Instagram session was rejected. Reconnect from the dashboard once the account is clear.');
    } else {
      log.logError('instagram', err, 'Reading the Instagram inbox failed');
    }
  } finally {
    polling = false;
  }
}

async function handleThread(thread) {
  const items = thread.items || [];
  if (!items.length) return;

  const since = lastSeenByThread.get(thread.thread_id) || 0;

  // Oldest first, so a burst of messages is logged in the order it was sent.
  const fresh = items
    .filter((item) => itemTimeMs(item) > since)
    .filter((item) => String(item.user_id) !== selfPk)
    .sort((a, b) => itemTimeMs(a) - itemTimeMs(b));

  // Move the marker even when nothing is answerable, or an unsupported item
  // (a reel share, a reaction) would be re-examined on every single poll.
  const newest = items.reduce((max, item) => Math.max(max, itemTimeMs(item)), since);
  lastSeenByThread.set(thread.thread_id, newest);

  if (!fresh.length) return;

  // A thread can hold several people; a group DM is not a lead.
  const users = thread.users || [];
  if (users.length !== 1) return;

  const senderPk = String(users[0].pk);
  const leadKey = `ig:${senderPk}`;

  let latestText = null;
  for (const item of fresh) {
    stats.received += 1;
    stats.lastEventAt = new Date().toISOString();

    if (item.item_type === 'text' && item.text) {
      latestText = item.text.trim();
      store.upsertLead(leadKey, {
        source: 'instagram',
        name: users[0].full_name || users[0].username || undefined,
        lastContacted: new Date().toISOString(),
      });
      store.logMessage(leadKey, 'user', latestText);
    } else {
      // Photos, reels, voice notes, likes: recorded so the inbox reads
      // correctly, but there is nothing for the model to answer.
      store.logMessage(leadKey, 'user', `[${item.item_type || 'attachment'}]`);
    }
  }

  if (!latestText) return;

  const settings = store.getSettings();
  if (settings.igBotEnabled === false) return;

  const lead = store.getLead(leadKey);
  if (lead && lead.humanTakeover === true) return;

  // Guard against a poll that catches up after a long outage.
  const age = Date.now() - itemTimeMs(fresh[fresh.length - 1]);
  if (age > MAX_REPLY_AGE_MS) {
    stats.skippedOld += 1;
    log.logWarn('instagram', `Skipped a reply to ${senderPk} - the message is ${Math.round(age / 3600000)}h old.`);
    return;
  }

  const reply = await generateReply(leadKey, latestText);
  if (!reply) return;

  await sendToThread(thread.thread_id, reply);
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

/** Sends into an existing thread, which is the normal case for a reply. */
async function sendToThread(threadId, text) {
  if (!stats.loggedIn) throw new Error('Instagram is not logged in.');
  return ig.entity.directThread(String(threadId)).broadcastText(String(text).slice(0, 1000));
}

/** Sends to a user by their numeric id, opening a thread if there is none. */
async function sendMessage(userPk, text) {
  if (!stats.loggedIn) throw new Error('Instagram is not logged in.');
  return ig.entity.directThread([String(userPk)]).broadcastText(String(text).slice(0, 1000));
}

/** Used by the dashboard's manual-reply box. */
async function sendManualMessage(leadKey, text) {
  const userPk = String(leadKey).replace(/^ig:/, '');
  await sendMessage(userPk, text);
  store.logMessage(`ig:${userPk}`, 'human', text);
  return { ok: true };
}

/* ------------------------- Lifecycle ------------------------- */

function scheduleNextPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const wait = POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS);
  pollTimer = setTimeout(() => {
    void pollOnce().finally(scheduleNextPoll);
  }, wait);
  // Do not hold the process open purely for the poll timer.
  if (pollTimer.unref) pollTimer.unref();
}

/** Called once at boot. Never throws - Instagram being down must not stop WhatsApp. */
async function start() {
  if (!isConfigured()) return false;
  const ok = await login();
  if (!ok) return false;
  await pollOnce();          // seeds the thread markers
  scheduleNextPoll();
  log.logInfo('instagram', `Polling Instagram DMs every ${Math.round(POLL_INTERVAL_MS / 1000)}s.`);
  return true;
}

function stop() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

/** Dashboard "Reconnect" - forces a fresh login and re-seeds the markers. */
async function reconnect() {
  stop();
  seeded = false;
  lastSeenByThread.clear();
  const ok = await start();
  return { ok, reason: ok ? null : stats.lastError };
}

/** Wipes the stored session so the next login starts clean. */
function logout() {
  stop();
  clearSession();
  stats.loggedIn = false;
  stats.username = null;
  seeded = false;
  lastSeenByThread.clear();
  return { ok: true };
}

/* ------------------------- Status ------------------------- */

/** Confirms the session actually works, so the dashboard shows a real state. */
async function checkConnection() {
  if (!isConfigured()) {
    return { connected: false, reason: 'Not configured - IG_USERNAME or IG_PASSWORD is missing.' };
  }
  if (!stats.loggedIn) {
    return {
      connected: false,
      reason: stats.challengeRequired
        ? 'Instagram asked for a verification challenge. Approve the login in the Instagram app, then reconnect.'
        : (stats.lastError || 'Not logged in.'),
    };
  }
  try {
    const me = await ig.account.currentUser();
    return { connected: true, username: me.username, id: String(me.pk) };
  } catch (err) {
    stats.loggedIn = false;
    stats.lastError = err.message;
    return { connected: false, reason: err.message };
  }
}

function getStatusPayload() {
  return {
    configured: isConfigured(),
    mode: 'unofficial',
    library: 'igramapi',
    pollSeconds: Math.round(POLL_INTERVAL_MS / 1000),
    proxied: Boolean(config.instagram.proxyUrl),
    threadsWatched: lastSeenByThread.size,
    ...stats,
  };
}

module.exports = {
  start,
  stop,
  reconnect,
  logout,
  sendMessage,
  sendManualMessage,
  checkConnection,
  getStatusPayload,
  isConfigured,
  DEFAULT_PROMPT,
};
