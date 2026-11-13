const cron = require('node-cron');
const config = require('./config');
const store = require('./store');
const { sendWhatsAppMessage, isConnected } = require('./whatsapp');
const log = require('./errors');

// Set FOLLOWUP_DEBUG=1 in Render's env vars to get the per-lead timing dump
// back. Off by default so the logs stay readable.
const DEBUG = process.env.FOLLOWUP_DEBUG === '1';

function followupText(template, name) {
  const fallback = "Hi {name}, just checking back about your free measure with KSC Carpets - would you like to go ahead? Reply STOP if you'd rather we didn't contact you again.";
  const text = template || fallback;
  return text.replaceAll('{name}', name || 'there');
}

function reviewRequestText(name) {
  const { name: businessName, googleReviewLink } = config.business;
  const greeting = name ? `Hi ${name}, ` : 'Hi, ';
  return `${greeting}thanks for choosing ${businessName}! If you're happy with your new carpet, we'd really appreciate a quick Google review: ${googleReviewLink}`;
}

function reviewReminderText(template, name) {
  const { googleReviewLink } = config.business;
  const fallback = "Hi {name}, just a quick reminder - we'd really appreciate a Google review when you get a moment: {reviewLink}";
  const text = template || fallback;
  return text.replaceAll('{name}', name || 'there').replaceAll('{reviewLink}', googleReviewLink);
}

/**
 * Nothing in this file may run while WhatsApp is disconnected.
 *
 * Previously it tried anyway: sendMessage then blew up with
 * "Cannot read properties of undefined (reading 'id')" once per lead, per
 * minute, filling the logs while the real problem (no session) was buried.
 */
function guard(taskName) {
  if (!isConnected()) {
    log.logWarn('followups', `WhatsApp is not connected - skipping ${taskName}. Nothing was sent and no lead was marked as contacted.`);
    return false;
  }
  return true;
}

async function runFollowups() {
  const settings = store.getSettings();

  if (settings.followupEnabled === false) {
    if (DEBUG) log.logInfo('followups', 'Follow-ups are paused from the dashboard - skipping this run.');
    return;
  }
  if (!guard('follow-ups')) return;

  if (DEBUG) {
    const cutoffMs = (settings.followupDelayHours || 0) * 60 * 60 * 1000;
    const leads = store.getAllLeads().filter((l) => l.status === 'interested');
    log.logInfo('followups', `tick | enabled=${settings.followupEnabled} delayHours=${settings.followupDelayHours} maxAttempts=${settings.followupMaxAttempts} interestedLeads=${leads.length}`);
    for (const l of leads) {
      const last = l.lastContacted ? new Date(l.lastContacted).getTime() : 0;
      const elapsedMs = Date.now() - last;
      log.logInfo('followups', `lead ${l.phone}: count=${l.followupCount || 0} last=${l.lastContacted || 'never'} elapsedMs=${elapsedMs} eligible=${(l.followupCount || 0) < settings.followupMaxAttempts && elapsedMs >= cutoffMs}`);
    }
  }

  const leads = store.getLeadsNeedingFollowup();

  for (const lead of leads) {
    try {
      await sendWhatsAppMessage(lead.phone, followupText(settings.followupMessage, lead.name));
      // Awaited sync: followupCount is an anti-spam gate - if a restart's
      // Sheet-restore rolled it back to a stale value, this customer would
      // get the same follow-up sent again.
      await store.upsertLeadAwaitSync(lead.phone, {
        lastContacted: new Date().toISOString(),
        followupCount: Number(lead.followupCount || 0) + 1,
      });
      log.logInfo('followups', `Follow-up sent to ${lead.phone}.`);
    } catch (err) {
      log.logError('followups', err, `Follow-up failed for ${lead.phone} - it was NOT counted, so it will be retried`);
    }
  }
}

async function runReviewRequests() {
  if (!guard('review requests')) return;

  const leads = store.getLeadsAwaitingReview();

  for (const lead of leads) {
    try {
      await sendWhatsAppMessage(lead.phone, reviewRequestText(lead.name));
      await store.upsertLeadAwaitSync(lead.phone, {
        reviewSent: true,
        reviewRequestedAt: new Date().toISOString(),
        reviewReminderCount: 0,
      });
      log.logInfo('followups', `Review request sent to ${lead.phone}.`);
    } catch (err) {
      log.logError('followups', err, `Review request failed for ${lead.phone}`);
    }
  }
}

async function runReviewReminders() {
  const settings = store.getSettings();
  if (settings.reviewReminderEnabled === false) return;
  if (!guard('review reminders')) return;

  const leads = store.getLeadsNeedingReviewReminder();

  for (const lead of leads) {
    try {
      await sendWhatsAppMessage(lead.phone, reviewReminderText(settings.reviewReminderMessage, lead.name));
      await store.upsertLeadAwaitSync(lead.phone, {
        reviewRequestedAt: new Date().toISOString(),
        reviewReminderCount: Number(lead.reviewReminderCount || 0) + 1,
      });
      log.logInfo('followups', `Review reminder sent to ${lead.phone}.`);
    } catch (err) {
      log.logError('followups', err, `Review reminder failed for ${lead.phone}`);
    }
  }
}

function startFollowupScheduler() {
  // Every 10 minutes. The actual delay/attempt limits are enforced in the
  // store queries, so this only decides how often we *check*. The old
  // '* * * * *' (every minute) just multiplied the noise when something was
  // wrong; ten minutes is still far finer than a 24-hour follow-up window.
  cron.schedule('*/10 * * * *', () => {
    runFollowups().catch((err) => log.logError('followups', err, 'runFollowups crashed'));
    runReviewRequests().catch((err) => log.logError('followups', err, 'runReviewRequests crashed'));
    runReviewReminders().catch((err) => log.logError('followups', err, 'runReviewReminders crashed'));
  });
  log.logInfo('followups', 'Follow-up scheduler started (checks every 10 minutes).');
}

module.exports = { startFollowupScheduler, runFollowups, runReviewRequests, runReviewReminders };
