// inbound.js — normalize received event into an InboundMessage, dedupe, authorize
import { config } from '../config.js';
import { logger } from '../logger.js';
import { BridgeError } from '../errors.js';
import { parseMessageContent } from './rich-text.js';

// Strip @mention tokens like @_user_1, @_all, and leading @ mention placeholders
// NOTE: no /g flag — used in authorize() via test(), which mutates lastIndex on /g regex.
const MENTION_RE = /@_user_\d+/;

export function stripMentions(text) {
  return text.replace(/@_user_\d+/g, '').trim();
}

export function parseTextContent(content) {
  return parseMessageContent(content);
}

// 从消息 content 提取文件/图片资源信息。飞书文件消息 content 形如
//   {"file_key":"...","file_name":"xxx.md"}
// 图片消息 content 形如 {"image_key":"..."}
export function parseResource(content) {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.file_key) return { type: 'file', key: parsed.file_key, name: parsed.file_name ?? '' };
    if (parsed?.image_key) return { type: 'image', key: parsed.image_key, name: parsed.image_name ?? '' };
    return null;
  } catch {
    return null;
  }
}

export function normalizeEvent(data) {
  const msg = data?.message ?? {};
  const sender = data?.sender ?? {};

  const text = parseTextContent(msg.content);
  const resource = parseResource(msg.content);

  return {
    eventId: data?.header?.event_id ?? data?.event_id ?? '',
    messageId: msg.message_id ?? '',
    chatId: msg.chat_id ?? '',
    chatType: msg.chat_type ?? '',       // 'p2p' | 'group'
    messageType: msg.message_type ?? '',
    parentId: msg.parent_id ?? '',       // 回复目标消息的 id
    rootId: msg.root_id ?? '',           // 话题根消息 id
    senderOpenId: sender?.sender_id?.open_id ?? '',
    senderType: sender?.sender_type ?? '',
    rawText: text,
    text: stripMentions(text),
    resource,                              // { type:'file'|'image', key, name } | null
    raw: data,
  };
}

// Authorize a sender. Fail closed — return null if unauthorized.
export function authorize(inbound) {
  // 锁定交互逻辑：桥接器只在配置的默认 chat（FEISHU_CHAT_ID）里收发。
  // 其它 chat 来的消息直接忽略（静默，不向无关会话泄露机器人存在）。
  if (inbound.chatId !== config.defaultChatId) {
    logger.info('ignored message from non-default chat', {
      chatId: inbound.chatId,
      defaultChatId: config.defaultChatId,
      messageId: inbound.messageId,
    });
    return false;
  }

  // Only real users (not the bot itself or system senders)
  if (inbound.senderType !== 'user') {
    logger.info('ignored non-user sender', { senderType: inbound.senderType, messageId: inbound.messageId });
    return false;
  }

  if (inbound.chatType === 'group') {
    // In groups, require the bot to be @-mentioned.
    // For text messages, rawText still carries @_user_N tokens → check with regex.
    // For post messages, @ tags are parsed to human-readable @name → check
    // the message.mentions[] array from the raw event instead.
    const mentions = inbound.raw?.message?.mentions;
    const wasMentioned =
      (Array.isArray(mentions) && mentions.length > 0) ||
      MENTION_RE.test(inbound.rawText);
    if (!wasMentioned) {
      logger.info('ignored group msg without mention', { chatId: inbound.chatId, messageId: inbound.messageId });
      return false;
    }
  }

  if (!inbound.senderOpenId) {
    logger.warn('message with no sender open_id', { messageId: inbound.messageId });
    return false;
  }

  // 不设黑白名单：只要消息来自配置的默认 chat（FEISHU_CHAT_ID），任何人都可交互。
  // 访问控制仅靠「锁定聊天场景」实现，不做用户级白名单。
  logger.info('auth decision', {
    messageId: inbound.messageId,
    senderOpenId: inbound.senderOpenId.slice(0, 8) + '...',
    allowed: true,
  });
  return true;
}

// In-memory dedupe: drop recently-seen message_ids to survive Feishu re-delivery
// Backed by on-disk persistence: survives bridge restarts (e.g. after Claude timeout).
// On restart, stale messages replayed by Feishu's long-connection are skipped.
// Write-backs are throttled to 30s intervals to avoid excessive disk I/O.
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
// config and logger already imported at top of file

const seen = new Map(); // messageId -> timestamp
const DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 min
const DEDUPE_MAX = 500;

// On-disk persistence so dedupe state survives bridge restart.
// Feishu reconnects replay stale events; without this, all replayed messages
// appear new and get re-queued to Claude.
const DISK_SEEN_PATH = join(config.stateDir, 'seen.json');

function loadSeenFromDisk() {
  try {
    if (!existsSync(DISK_SEEN_PATH)) return;
    const raw = readFileSync(DISK_SEEN_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      const now = Date.now();
      for (const entry of data) {
        if (entry && entry.id && typeof entry.ts === 'number') {
          if (now - entry.ts < DEDUPE_TTL_MS) {
            seen.set(entry.id, entry.ts);
          }
        }
      }
      logger.info('loaded seen set from disk', { count: seen.size });
    }
  } catch (err) {
    logger.warn('failed to load seen set from disk', { error: err.message });
  }
}

// Debounced disk write: at most once every 30 seconds
let _flushPending = false;
let _flushTimer = null;
const SEEN_FLUSH_INTERVAL_MS = 30_000;

function saveSeenToDisk() {
  try {
    const data = Array.from(seen.entries()).map(([id, ts]) => ({ id, ts }));
    writeFileSync(DISK_SEEN_PATH, JSON.stringify(data), 'utf8');
  } catch (err) {
    logger.warn('failed to save seen set to disk', { error: err.message });
  }
}

function flushSeen() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  if (_flushPending) {
    _flushPending = false;
    saveSeenToDisk();
  }
}

function scheduleSeenFlush() {
  if (_flushPending) return; // already scheduled
  _flushPending = true;
  _flushTimer = setTimeout(flushSeen, SEEN_FLUSH_INTERVAL_MS);
}

// Register final flush on process exit
process.on('beforeExit', flushSeen);
process.on('SIGINT', () => { flushSeen(); });
process.on('SIGTERM', () => { flushSeen(); });

// Load at import time
loadSeenFromDisk();

// Prune stale entries + trim oldest half when over capacity
function pruneSeen() {
  const now = Date.now();
  // 1) Remove expired entries
  for (const [id, ts] of seen) {
    if (now - ts > DEDUPE_TTL_MS) seen.delete(id);
  }
  // 2) If still over max, drop the oldest half
  if (seen.size > DEDUPE_MAX) {
    const sorted = Array.from(seen.entries()).sort((a, b) => a[1] - b[1]);
    const dropCount = Math.floor(seen.size / 2);
    for (let i = 0; i < dropCount; i++) {
      seen.delete(sorted[i][0]);
    }
    logger.info('pruned seen set', { before: seen.size + dropCount, after: seen.size });
  }
}

export function isDuplicate(messageId) {
  if (!messageId) return false;

  const now = Date.now();
  if (seen.size > DEDUPE_MAX) pruneSeen();

  if (seen.has(messageId)) {
    logger.info('dedupe hit', { messageId });
    return true;
  }
  seen.set(messageId, now);
  scheduleSeenFlush();
  return false;
}