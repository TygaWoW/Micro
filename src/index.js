// index.js — entry point: health check, single-instance lock, wiring, lifecycle
import { unlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { logger, pruneLogs } from './logger.js';
import { startEventStream, downloadResource, fetchMessage, fetchMergeForwardItems } from './feishu/client.js';
import { normalizeEvent, authorize, isDuplicate, parseTextContent } from './feishu/inbound.js';
import { renderMergeForward } from './feishu/merge-forward.js';
import { replyText, replyLongText } from './feishu/outbound.js';
import { runClaude } from './claude/cli.js';
import { getSessionId, setSessionId, clearSession } from './claude/session.js';
import { enqueue } from './queue.js';
import { handleCommand } from './commands.js';
import { classifyError } from './errors.js';

let wsClient = null;

// ---- Stale-replay coalescing -------------------------------------------------
// 飞书长连接断线重连后会一次性"重放"断线期间漏收的事件，同一 chat 会瞬间灌进多条旧消息，
// 若逐条入队会排队逐个触发 Claude。这里用一个极短的"合并窗口"把同一 chat 在窗口内连串涌入的
// 事件合并成一条：只让「最后一条」真正进队列，前面的旧消息直接跳过并给用户一条轻提示。
// 正常节奏的连续对话（两条消息间隔 > 窗口）不受影响，仍逐条处理。
const COALESCE_WINDOW_MS = 1500;
const coalescing = new Map(); // chatId -> { timer, latestInbound }

function enqueueCoalesced(inbound, run) {
  const chatId = inbound.chatId;
  const prev = coalescing.get(chatId);

  if (prev) {
    // 窗口内又来一条：旧的那条不再入队，替换成最新的；旧消息给用户一条跳过提示。
    const dropped = prev.latestInbound;
    clearTimeout(prev.timer);
    if (dropped) {
      replyText(dropped.messageId, 'ℹ️ 这条消息与后续消息合并，已按最新一条处理。').catch(() => {});
      logger.info('coalesced stale replay dropped', {
        chatId,
        droppedMessageId: dropped.messageId,
        keptMessageId: inbound.messageId,
      });
    }
    // 旧消息被合并跳过：立即 resolve 它自己的 Promise（任务未执行，视为成功跳过）。
    if (prev.resolve) prev.resolve();
  }

  // 返回一个在「合并窗口结束后真正入队」时 settle 的 Promise，
  // 让调用方的 .catch() 能接到任务执行结果。
  let resolve, reject;
  const settled = new Promise((res, rej) => { resolve = res; reject = rej; });

  const timer = setTimeout(() => {
    coalescing.delete(chatId);
    const p = enqueue(chatId, () => run(inbound));
    // 入队的任务：成功 → resolve，失败 → reject，让调用方的 .catch() 接到错误。
    p.then(() => resolve(), (err) => reject(err));
  }, COALESCE_WINDOW_MS);
  coalescing.set(chatId, { latestInbound: inbound, timer, resolve, reject });

  return settled;
}

// ---- Single-instance lock (PID-based, survives hard kill) ----
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check, never kills
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but no permission = alive
  }
}

function acquireLock() {
  const lockPath = join(config.stateDir, 'bridge.lock');
  try {
    // If a stale lock exists from a dead process, reclaim it
    if (existsSync(lockPath)) {
      try {
        const stalePid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
        if (!Number.isNaN(stalePid) && !isProcessAlive(stalePid)) {
          unlinkSync(lockPath); // stale — reclaim
        } else {
          return false; // another live instance holds it
        }
      } catch {
        // Unreadable lock — assume held, fail safe
        return false;
      }
    }
    // Write our own PID
    writeFileSync(lockPath, String(process.pid), 'utf8');
    return true;
  } catch (err) {
    // EEXIST race — another instance won; fail safe
    return false;
  }
}

function releaseLock() {
  const lockPath = join(config.stateDir, 'bridge.lock');
  try {
    // Only remove if it's our own PID
    const pid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    if (pid === process.pid) unlinkSync(lockPath);
  } catch { /* ignore */ }
}

// ---- Health check ----
// Verify Feishu credentials are valid before starting the event stream.
// Returns { ok, msg } — if ok is false, exit immediately so watchdog can retry.
async function healthCheck() {
  const results = [];

  // 1) Verify Feishu tenant_access_token can be obtained
  try {
    const res = await (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.feishuAppId, app_secret: config.feishuAppSecret }),
    })).json();
    if (res?.code === 0 && res.tenant_access_token) {
      const expireMin = Math.floor((res.expire || 0) / 60);
      results.push(`✅ Feishu token OK (expires in ${expireMin}min)`);
    } else {
      results.push(`❌ Feishu token failed: code=${res?.code}, msg=${res?.msg}`);
    }
  } catch (err) {
    results.push(`❌ Feishu token request failed: ${err.message}`);
  }

  // 2) Verify CLAUDE_BIN exists (if configured)
  if (config.claudeBin) {
    if (existsSync(config.claudeBin)) {
      results.push(`✅ Claude binary found at ${config.claudeBin}`);
    } else {
      // Not fatal — bridge can fall back to PATH `claude`
      results.push(`⚠️ CLAUDE_BIN not found at ${config.claudeBin} — will use PATH`);
    }
  } else {
    results.push('ℹ️ CLAUDE_BIN not configured — will use PATH `claude`');
  }

  const summary = results.join('\n');
  const ok = !results.some((r) => r.startsWith('❌'));

  if (ok) {
    logger.info('health check passed\n' + summary);
  } else {
    logger.error('health check FAILED\n' + summary);
  }

  return { ok, msg: summary };
}

// ---- Core message handling ----
// handler must return fast — all real work is enqueued
function onMessage(data) {
  const inbound = normalizeEvent(data);

  // Dedupe re-delivered events
  if (isDuplicate(inbound.messageId)) {
    logger.debug('dropped duplicate', { messageId: inbound.messageId });
    return;
  }

  // Authorize (fail-closed). 非默认 chat 静默忽略，默认 chat 内白名单不通过则回一条提示。
  if (!authorize(inbound)) {
    if (inbound.chatId === config.defaultChatId) {
      replyText(inbound.messageId, '⚠️ 无权访问').catch(() => {});
    }
    return;
  }

  // 文件/图片资源消息：下载内容后作为 prompt 交给 Claude（不报"请发送文本"）
  if (inbound.resource) {
    enqueueCoalesced(inbound, () => processResource(inbound))
      .catch((err) => {
        logger.error('resource task failed', { messageId: inbound.messageId, error: err.message });
        replyText(inbound.messageId, classifyError(err).toFeishu()).catch(() => {});
      });
    return;
  }

  // 合并转发消息：content 只是占位符，需拉取子消息树再交给 Claude
  if (inbound.messageType === 'merge_forward') {
    enqueueCoalesced(inbound, () => processMergeForward(inbound))
      .catch((err) => {
        logger.error('merge forward task failed', { messageId: inbound.messageId, error: err.message });
        replyText(inbound.messageId, classifyError(err).toFeishu()).catch(() => {});
      });
    return;
  }

  // Empty content — ignore (e.g. image-only messages)
  if (!inbound.text) {
    replyText(inbound.messageId, 'ℹ️ 请发送文本消息').catch(() => {});
    return;
  }

  // Local commands first (no Claude invocation)
  const cmd = handleCommand(inbound);
  if (cmd.handled) {
    replyText(inbound.messageId, cmd.reply).catch(() => {});
    if (cmd._then) cmd._then();
    return;
  }

  // Enqueue real work — the queue sends acks and the final reply
  enqueueCoalesced(inbound, () => processMessage(inbound))
    .catch((err) => {
      logger.error('queued task failed', { messageId: inbound.messageId, error: err.message });
      replyText(inbound.messageId, classifyError(err).toFeishu()).catch(() => {});
    });
}

// 解析「被引用/回复」的那条消息内容，按 msg_type 分流：
//   text           → 纯文本原文
//   merge_forward  → 结构化聊天记录（姓名+时间）
//   file           → 下载文件文本内容
//   image          → 仅标记（当前模型不支持图片识别）
// 返回 { kind: 'text'|'file'|'image', text, senderName, fileName } ；无法解析返回 null。
async function resolveReferencedContent(messageId) {
  const quoted = await fetchMessage(messageId);
  const item = quoted?.items?.[0];
  if (!item) return null;

  const senderName = item.sender?.sender_name
    ?? item.sender?.sender_i18n_names?.zh_cn
    ?? '';

  const type = item.msg_type;

  if (type === 'merge_forward') {
    const items = await fetchMergeForwardItems(messageId);
    const rendered = renderMergeForward(items);
    if (rendered) return { kind: 'text', text: rendered, senderName };
    return { kind: 'text', text: '', senderName };
  }

  if (type === 'file') {
    try {
      const parsed = JSON.parse(item.body?.content ?? '{}');
      const fileKey = parsed.file_key;
      const fileName = parsed.file_name ?? '';
      if (!fileKey) return null;
      const buf = await downloadResource(messageId, fileKey, 'file');
      if (isBinaryBuffer(buf)) return null; // 二进制文件不可读
      const text = buf.toString('utf8');
      if (!text.trim()) return null; // 空文件
      return { kind: 'file', text, senderName, fileName };
    } catch { return null; }
  }

  if (type === 'image') {
    // 当前模型不支持图片识别，仅标记类型，由调用方友好提示
    return { kind: 'image', text: '', senderName };
  }

  // text / post 等可解析文本
  const text = item.body?.content ? parseTextContent(item.body.content) : '';
  if (text) return { kind: 'text', text, senderName };
  return null;
}

// 构造发给 Claude 的 prompt，附上「默认 chat」上下文，
// 让 Claude 知道当前对话发生在哪个 chat、发卡片/回复时无需再向用户要 open_id。
// 若消息是「回复/引用」，附上被引用消息的原文（文本/聊天记录/文件），供 Claude 精准理解上下文。
// 被引用内容是图片时，返回 sentinel 由调用方降级提示（当前模型不支持图片识别）。
async function buildPrompt(inbound) {
  const ctx = `[系统] 你的身份是 Micro 飞书智能助手，通过飞书机器人与用户交互。` +
    `当有人问你"你是谁""你的名字是什么""你是谁家的助手"等身份相关问题时，回答："我是 Micro 飞书智能助手，通过飞书机器人为你提供服务。"` +
    `当前默认对话 chat_id 是 ${config.defaultChatId}。` +
    `回复消息、发送卡片时，直接使用默认 chat（无需向用户索要 open_id 或 chat_id）。`;

  // 回复/引用：解析被引用消息（覆盖文本 / 合并转发 / 文件 / 图片）
  let quotedCtx = '';
  let quotedIsImage = false;
  if (inbound.parentId && inbound.parentId !== inbound.messageId) {
    const ref = await resolveReferencedContent(inbound.parentId);
    if (ref) {
      const who = ref.senderName ? `（发送人：${ref.senderName}）` : '';
      if (ref.kind === 'image') {
        quotedCtx = `\n\n[引用上下文] 用户回复/引用了以下内容${who}：一张图片。`;
        quotedIsImage = true;
      } else if (ref.kind === 'file') {
        quotedCtx = `\n\n[引用上下文] 用户回复/引用了以下文件「${ref.fileName || '文件'}」${who}，其内容：\n"""\n${ref.text}\n"""`;
      } else if (ref.text) {
        quotedCtx = `\n\n[引用上下文] 用户回复/引用了以下消息${who}：\n"""\n${ref.text}\n"""`;
      }
    }
  }

  const prompt = `${ctx}${quotedCtx}\n\n用户消息：\n${inbound.text}`;
  return { prompt, quotedIsImage };
}

// 统一的 Claude 调用流：跑 Claude → 存 session → 发一次最终回复。
// 不再把中间思考/工具调用的流式片段回传飞书 —— 那些是过程噪音，
// 用户只想看到最终答案。只在 Claude 跑完拿到 finalText 后统一发一条完整回复。
// processMessage / processResource / processMergeForward 共用。
//
// 不做重试：超时就立刻回用户提示，释放队列给下一条消息，避免因 API 不通堵死全队。
async function invokeClaudeAndReply({ prompt, chatId, messageId, allowedTools }) {
  const sessionId = getSessionId(chatId);

  try {
    const result = await runClaude({
      prompt,
      sessionId,
      chatId,
      allowedTools,
    });

    if (result.sessionId) setSessionId(chatId, result.sessionId);
    // 用长文本（分片）发最终结果；过程中间片段不再逐条发送。
    if (result.text) await replyLongText(messageId, result.text);
  } catch (err) {
    if (err?.code === 'CLAUDE_TIMEOUT') {
      logger.warn('claude timeout — reporting to user', { chatId, messageId });
      await replyText(messageId, '⏳ 响应超时，API 暂时不可用。请稍后重发。').catch(() => {});
      clearSession(chatId);
      return;
    }
    logger.error('message processing failed', { messageId, error: err.message });
    await replyText(messageId, classifyError(err).toFeishu()).catch(() => {});
  }
}

async function processMessage(inbound) {
  // Immediate ack (within 3s window)
  await replyText(inbound.messageId, '🤔 Working on it...').catch(() => {});

  try {
    const { prompt, quotedIsImage } = await buildPrompt(inbound);
    // 被引用的是图片：当前模型不支持图片识别，直接降级提示，不空转 Claude
    if (quotedIsImage) {
      await replyText(inbound.messageId, 'ℹ️ 你引用了一张图片，但当前模型暂不支持图片识别，无法读取图片内容。');
      return;
    }
    await invokeClaudeAndReply({
      prompt,
      chatId: inbound.chatId,
      messageId: inbound.messageId,
    });
  } catch (err) {
    logger.error('message processing failed', { messageId: inbound.messageId, error: err.message });
    await replyText(inbound.messageId, classifyError(err).toFeishu()).catch(() => {});
  }
}

// 处理「合并转发」消息：拉取子消息树 → 结构化文本 → 交给 Claude。
async function processMergeForward(inbound) {
  await replyText(inbound.messageId, '📥 收到合并转发的聊天记录，正在解析...').catch(() => {});

  try {
    const items = await fetchMergeForwardItems(inbound.messageId);
    const rendered = renderMergeForward(items);

    if (!rendered) {
      await replyText(inbound.messageId, '⚠️ 未能解析该合并转发消息的内容（可能为空或权限受限）。');
      return;
    }

    const prompt =
      `[系统] 用户向飞书机器人转发了一段「合并聊天记录」。下面是按时间与发送人整理好的完整内容，` +
      `请结合其中的对话与用户的需求进行理解和回答。\n\n` +
      `以下是转发的聊天记录：\n"""\n${rendered}\n"""\n\n` +
      `（若用户对转发的聊天记录有具体问题，请优先基于以上内容作答。）`;

    await invokeClaudeAndReply({
      prompt,
      chatId: inbound.chatId,
      messageId: inbound.messageId,
    });
  } catch (err) {
    logger.error('merge forward processing failed', { messageId: inbound.messageId, error: err.message });
    await replyText(inbound.messageId, classifyError(err).toFeishu()).catch(() => {});
  }
}

// 处理上传的文件/图片资源消息：下载内容 → 交给 Claude → 回结果。
async function processResource(inbound) {
  await replyText(inbound.messageId, '📄 收到文件，正在读取...').catch(() => {});

  const { type, key, name } = inbound.resource;

  try {
    const buf = await downloadResource(inbound.messageId, key, type);

    // 按文件类型组装 prompt
    let prompt = '';

    if (type === 'file') {
      // 文本类文件：读成字符串直接作为内容。
      // 先检测是否为二进制文件（null bytes / 常见文件魔数），避免乱码传给 Claude。
      if (isBinaryBuffer(buf)) {
        await replyText(inbound.messageId, `⚠️ 文件「${name || '未命名'}」是二进制格式，不是可读的文本文件，暂无法解析。`);
        return;
      }
      prompt = buf.toString('utf8');
      if (!prompt.trim()) {
        // 纯空或只有空白字符的文件 → 也提示不支持
        await replyText(inbound.messageId, `⚠️ 文件「${name || '未命名'}」内容为空或不可读，暂无法解析。`);
        return;
      }
      // 附上文件名作为上下文
      prompt = `以下是用户上传的文件「${name || '文件'}」的内容：\n\n${prompt}\n\n请根据以上文件内容，结合用户的需求进行回答。`;
    } else if (type === 'image') {
      // 当前模型不支持图片识别，直接友好提示，不空转 Claude
      await replyText(inbound.messageId, 'ℹ️ 收到一张图片，但当前模型暂不支持图片识别，无法读取图片内容。');
      return;
    }

    await invokeClaudeAndReply({
      prompt,
      chatId: inbound.chatId,
      messageId: inbound.messageId,
    });
  } catch (err) {
    logger.error('resource processing failed', { messageId: inbound.messageId, error: err.message });
    await replyText(inbound.messageId, classifyError(err).toFeishu()).catch(() => {});
  }
}

// Detect binary (non-text) buffers by scanning for null bytes and common file magic numbers.
// A buffer that contains any null byte in the first 8 KiB is almost certainly binary.
// A buffer starting with a known binary magic number (PNG, JPEG, PDF, ZIP, etc.) is binary.
function isBinaryBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return false;

  // 1) Scan first 8 KiB for null bytes (reliable binary indicator)
  const scanLen = Math.min(buf.length, 8192);
  for (let i = 0; i < scanLen; i++) {
    if (buf[i] === 0) return true;
  }

  // 2) Check file magic numbers (first bytes) for common binary formats
  const head = buf; // alias for readability
  // PNG:  89 50 4E 47 0D 0A 1A 0A
  if (
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47 &&
    head[4] === 0x0D && head[5] === 0x0A && head[6] === 0x1A && head[7] === 0x0A
  ) return true;
  // JPEG: FF D8 FF
  if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return true;
  // GIF: 47 49 46 38 (GIF8)
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return true;
  // PDF: 25 50 44 46 (%PDF)
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return true;
  // ZIP / DOCX / XLSX / JAR / etc.: 50 4B 03 04 (PK..)
  if (head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04) return true;
  // GZIP: 1F 8B
  if (head[0] === 0x1F && head[1] === 0x8B) return true;
  // RAR: 52 61 72 21 1A 07 (Rar!...)
  if (head.length >= 6 &&
    head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 &&
    head[3] === 0x21 && head[4] === 0x1A && head[5] === 0x07
  ) return true;
  // 7z: 37 7A BC AF 27 1C
  if (head.length >= 6 &&
    head[0] === 0x37 && head[1] === 0x7A && head[2] === 0xBC &&
    head[3] === 0xAF && head[4] === 0x27 && head[5] === 0x1C
  ) return true;
  // BMP: 42 4D (BM)
  if (head[0] === 0x42 && head[1] === 0x4D) return true;
  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
  if (head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) return true;

  return false;
}

// ---- Lifecycle ----
async function main() {
  const locked = acquireLock();
  if (!locked) {
    console.error('[bridge] Another instance is already running. Exiting.');
    process.exit(1);
  }

  pruneLogs();
  logger.info('bridge starting', {
    appId: config.feishuAppId,
    permissionMode: config.claudePermissionMode,
  });

  // Health check before starting the event stream
  const health = await healthCheck();
  if (!health.ok) {
    logger.error('health check failed — exiting so watchdog can retry');
    releaseLock();
    process.exit(1);
  }

  wsClient = startEventStream(onMessage);

  logger.info('bridge ready — waiting for events');
}

process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err.message, stack: err.stack });
  // Unknown state — exit and let the service supervisor restart
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { error: String(reason) });
  // Continue — a rejected queue task should not kill the bridge
});

process.on('SIGINT', () => {
  logger.info('SIGINT received — shutting down');
  releaseLock();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down');
  releaseLock();
  process.exit(0);
});

main();