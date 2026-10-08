// session.js — chatId -> claude session_id mapping, in-memory only
// Sessions live for the lifetime of a single bridge run.
// When the bridge restarts, all sessions are fresh — no history carry-over.
import { config } from '../config.js';
import { logger } from '../logger.js';

// In-memory only: no disk persistence, no load on startup.
// Each bridge run is a clean slate.
let sessions = new Map();

export function getSessionId(chatId) {
  const entry = sessions.get(chatId);
  if (!entry) return null;
  return typeof entry === 'object' ? entry.sessionId : entry;
}

export function setSessionId(chatId, sessionId) {
  sessions.set(chatId, { sessionId, updatedAt: Date.now() });
}

export function clearSession(chatId) {
  sessions.delete(chatId);
}

logger.info('sessions ready', { count: 0 });

export default { getSessionId, setSessionId, clearSession };