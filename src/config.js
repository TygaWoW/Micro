// config.js — load .env, validate, parse allowlist
// Supports two modes:
//   Bridge mode (default): reads from .env, required() fails if missing
//   MCP mode (MCP_MODE=1): reads from process.env (injected by Claude Code), nothing is fatal here
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const IS_MCP = process.env.MCP_MODE === '1';

// Load .env from project root (bridge mode only; MCP gets env from Claude Code)
const envPath = resolve(ROOT, '.env');
if (existsSync(envPath) && !IS_MCP) {
  dotenv.config({ path: envPath });
}

function required(key) {
  const val = process.env[key];
  if (!val) {
    console.error(`[config] FATAL: ${key} is not set in .env`);
    process.exit(1);
  }
  return val;
}

function optional(key, def = '') {
  return process.env[key] ?? def;
}

// In MCP mode, feishu creds come from the MCP server's env block (Claude Code injects them).
// We never exit() here — the MCP tool handlers will surface errors to the caller instead.
function mcpCredential(key) {
  const val = process.env[key];
  if (!val) {
    console.error(`[config:MCP] WARNING: ${key} is not set — some tools may fail`);
  }
  return val ?? '';
}

export const config = {
  // Directories
  root: ROOT,
  stateDir: resolve(ROOT, 'state'),
  logsDir: resolve(ROOT, 'logs'),

  // Feishu
  feishuAppId:    IS_MCP ? mcpCredential('FEISHU_APP_ID')    : required('FEISHU_APP_ID'),
  feishuAppSecret: IS_MCP ? mcpCredential('FEISHU_APP_SECRET') : required('FEISHU_APP_SECRET'),
  // 默认交互 chat（必填）：桥接器只在这个 chat 里收发消息，锁定交互逻辑。
  // 群聊填 oc_xxx，私聊填 ou_xxx。
  defaultChatId:  IS_MCP ? mcpCredential('FEISHU_CHAT_ID')   : required('FEISHU_CHAT_ID'),

  // Claude (bridge-only; MCP mode doesn't spawn claude)
  // CLAUDE_BIN 用 optional —— MCP server 不会 spawn claude，bridge 主进程在 spawn 前自行校验。
  claudeBin: optional('CLAUDE_BIN', ''),
  claudePermissionMode: optional('CLAUDE_PERMISSION_MODE', 'acceptEdits'),
  claudeCwd: optional('CLAUDE_CWD', process.env.USERPROFILE || 'C:\\'),

  // Queue
  maxConcurrentClaude: parseInt(optional('MAX_CONCURRENT_CLAUDE', '2'), 10),
  progressTimeoutMs: parseInt(optional('PROGRESS_TIMEOUT_MS', '120000'), 10), // 2min no stdout -> kill
  hardTimeoutMs: parseInt(optional('HARD_TIMEOUT_MS', '900000'), 10),         // 15min absolute deadline

  // Logging
  logLevel: optional('LOG_LEVEL', 'info'),
  logRetentionDays: parseInt(optional('LOG_RETENTION_DAYS', '14'), 10),

  // Session
  sessionPruneDays: parseInt(optional('SESSION_PRUNE_DAYS', '30'), 10),

  // Message chunking limits
  maxChunkChars: optional('MAX_CHUNK_CHARS', '15000'),
  maxChunks: parseInt(optional('MAX_CHUNKS', '5'), 10),
};

// Validate numeric configs
if (Number.isNaN(config.maxConcurrentClaude) || config.maxConcurrentClaude < 1) {
  console.error('[config] FATAL: MAX_CONCURRENT_CLAUDE must be >= 1');
  process.exit(1);
}

export default config;