// queue.js — serialize per chat, cap global concurrency
import pLimit from 'p-limit';
import { config } from './config.js';
import { logger } from './logger.js';

// Per-chat promise chains (serial within a chat)
const chatQueues = new Map(); // chatId -> Promise

// Global concurrency limit across all chats
const globalLimit = pLimit(config.maxConcurrentClaude);

export function enqueue(chatId, task) {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(() => globalLimit(task), () => globalLimit(task));
  // Keep the chain alive even if a task rejects
  chatQueues.set(chatId, next.catch(() => {}));
  return next;
}

// Query whether a chat currently has a running task (for UX hints)
export function isBusy(chatId) {
  return chatQueues.has(chatId);
}

export { globalLimit };

export default { enqueue, isBusy, globalLimit };