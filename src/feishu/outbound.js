// outbound.js — reply to Feishu, chunk long text, write oversized output to file
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { client } from './client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Send a text reply threaded under the original message
export async function replyText(messageId, text) {
  try {
    await client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text }) },
    });
  } catch (err) {
    logger.error('reply failed', {
      messageId,
      error: err.message,
      status: err.response?.status,
      data: err.response?.data,
    });
    throw err;
  }
}

// Send a card (interactive) reply — preserves code blocks / markdown
export async function replyCard(messageId, cardJson) {
  try {
    const payload = {
      msg_type: 'interactive',
      content: JSON.stringify(cardJson),
    };
    await client.im.message.reply({
      path: { message_id: messageId },
      data: payload,
    });
  } catch (err) {
    logger.error('replyCard failed', { messageId, error: err.message });
    throw err;
  }
}

// Build a simple text card (better rendering than raw text for code)
export function buildTextCard(title, text) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: title },
    },
    elements: [
      {
        tag: 'markdown',
        content: text,
      },
    ],
  };
}

const DEFAULT_CHUNK_LIMIT = 15000;

// Split text at semantic boundaries, never inside a code fence.
// Returns an array of chunks.
export function chunkText(text, limit = DEFAULT_CHUNK_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let remaining = text;
  let fenceLang = ''; // track open code fence language across chunks

  while (remaining.length > limit) {
    // Find a split point within the first `limit` chars
    const slice = remaining.slice(0, limit);

    // Determine current fence state by counting triple-backticks in `slice`
    const openFences = (remaining.match(/```/g) || []).length % 2 !== 0;

    let splitIdx = -1;

    if (openFences) {
      // Inside a code block — find the closing fence in the slice, split after it
      const closeFence = slice.lastIndexOf('```');
      if (closeFence > 0) {
        splitIdx = closeFence + 3;
      } else {
        // No closing fence in this window; hard-split but keep block open
        splitIdx = slice.lastIndexOf('\n');
        if (splitIdx === -1) splitIdx = limit;
      }
    } else {
      // Prefer paragraph, then newline, then sentence, then space
      const para = slice.lastIndexOf('\n\n');
      const nl = slice.lastIndexOf('\n');
      const sentence = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('. '));
      const space = slice.lastIndexOf(' ');

      if (para > limit * 0.5) splitIdx = para;
      else if (nl > limit * 0.5) splitIdx = nl;
      else if (sentence > limit * 0.5) splitIdx = sentence;
      else if (space > limit * 0.5) splitIdx = space;
      else splitIdx = limit;
    }

    // Fallback: guarantee forward progress
    if (splitIdx <= 0) splitIdx = Math.min(limit, remaining.length);

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// Reply to a message with a potentially long text, chunking as needed.
// If the reply exceeds maxChunks, write the full output to a file and
// report the path instead of flooding the chat.
export async function replyLongText(messageId, text) {
  const chunks = chunkText(text, config.maxChunkChars || DEFAULT_CHUNK_LIMIT);

  if (chunks.length <= config.maxChunks) {
    for (const chunk of chunks) {
      await replyText(messageId, chunk);
    }
    return;
  }

  // Oversized: keep first few chunks in chat, write remainder to file
  const keepCount = config.maxChunks - 1;
  for (let i = 0; i < keepCount; i++) {
    await replyText(messageId, chunks[i]);
  }

  const fullPath = writeOversizeToFile(messageId, text);
  await replyText(messageId, `...（输出过长，完整内容已写入文件）\n${fullPath}`);
}

function writeOversizeToFile(messageId, text) {
  const dir = join(config.logsDir, 'oversize');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(dir, `${messageId}_${ts}.md`);
  writeFileSync(filePath, text, 'utf8');
  logger.info('oversize output written', { filePath });
  return filePath;
}

export default { replyText, replyCard, replyLongText, buildTextCard, chunkText };