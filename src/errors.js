'use strict';
/**
 * errors.js - one central place where every error/warning/event is recorded.
 *
 * Two outputs:
 *   1. console  -> shows up in Render's "Logs" tab (searchable, kept ~7 days)
 *   2. memory ring buffer -> shown live on the dashboard at /api/errors, so
 *      the client (and you) can see what went wrong without opening Render.
 *
 * Nothing in here throws. Logging must never be able to break the bot.
 */

const MAX_ENTRIES = 300;
const entries = []; // newest first
let counter = 0;

function truncate(value, max) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.length > max ? `${text.slice(0, max)}... [truncated]` : text;
}

function push(level, scope, message, detail) {
  const entry = {
    id: ++counter,
    time: new Date().toISOString(),
    level, // 'error' | 'warn' | 'info'
    scope, // 'whatsapp' | 'session' | 'followups' | 'sheets' | 'ai' | 'dashboard' | 'process'
    message: truncate(message, 1500),
    detail: truncate(detail, 4000),
  };
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  return entry;
}

function logError(scope, err, context = '') {
  const message = err && err.message ? err.message : String(err);
  const statusCode = err && err.output && err.output.statusCode ? ` [status ${err.output.statusCode}]` : '';
  const stack = err && err.stack ? err.stack : '';
  const detail = [context, stack].filter(Boolean).join('\n');
  console.error(`[${scope}] ERROR${statusCode}: ${message}${context ? ` (${context})` : ''}`);
  if (stack) console.error(stack);
  return push('error', scope, `${message}${statusCode}`, detail);
}

function logWarn(scope, message, detail = '') {
  console.warn(`[${scope}] WARN: ${message}`);
  return push('warn', scope, message, detail);
}

function logInfo(scope, message, detail = '') {
  console.log(`[${scope}] ${message}`);
  return push('info', scope, message, detail);
}

function getEntries(limit = 100, level = null) {
  const list = level ? entries.filter((e) => e.level === level) : entries;
  return list.slice(0, limit);
}

function getCounts() {
  return {
    total: entries.length,
    errors: entries.filter((e) => e.level === 'error').length,
    warnings: entries.filter((e) => e.level === 'warn').length,
  };
}

function clear() {
  entries.length = 0;
  return { ok: true };
}

/**
 * Catches anything that escaped a try/catch anywhere in the app, records it,
 * and keeps the process alive - a crash here would also drop the live
 * WhatsApp connection and force a re-pair for no good reason.
 */
function installProcessHandlers() {
  process.on('unhandledRejection', (err) => {
    logError('process', err, 'Unhandled promise rejection (process kept alive)');
  });
  process.on('uncaughtException', (err) => {
    logError('process', err, 'Uncaught exception (process kept alive)');
  });
  // SIGTERM is handled in index.js, which saves everything before exiting.
}

module.exports = {
  logError,
  logWarn,
  logInfo,
  getEntries,
  getCounts,
  clear,
  installProcessHandlers,
};
