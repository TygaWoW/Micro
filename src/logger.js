// logger.js — structured JSON logger with daily file rotation
import { appendFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

// Ensure logs dir exists
if (!existsSync(config.logsDir)) {
  mkdirSync(config.logsDir, { recursive: true });
}

// Sensitive patterns to redact
const REDACT_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/g,
  /[A-Za-z0-9]{32,}/g, // app_secret-like strings
];

function redact(str) {
  let out = str;
  for (const p of REDACT_PATTERNS) {
    out = out.replace(p, (m) => m.slice(0, 4) + '...' + m.slice(-4));
  }
  return out;
}

function logFilePath() {
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return join(config.logsDir, `bridge-${dateStr}.log`);
}

function writeLog(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(logFilePath(), line, 'utf8');
    // Always write to stderr — never stdout (MCP stdio transport uses stdout for JSON-RPC)
    process.stderr.write(line);
  } catch {
    // Survive logging failures — don't crash the bridge
  }
}

// One-shot
export function pruneLogs() {
  try {
    const now = Date.now();
    const maxAge = config.logRetentionDays * 86400 * 1000;
    const files = readdirSync(config.logsDir).filter((f) => f.startsWith('bridge-') && f.endsWith('.log'));
    for (const f of files) {
      const full = join(config.logsDir, f);
      try {
        if (now - statSync(full).mtimeMs > maxAge) unlinkSync(full);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

export const logger = {
  debug(msg, extra = {}) {
    if (currentLevel > LEVELS.debug) return;
    writeLog({ ts: new Date().toISOString(), level: 'debug', msg: redact(String(msg)), ...extra });
  },
  info(msg, extra = {}) {
    if (currentLevel > LEVELS.info) return;
    writeLog({ ts: new Date().toISOString(), level: 'info', msg, ...extra });
  },
  warn(msg, extra = {}) {
    if (currentLevel > LEVELS.warn) return;
    writeLog({ ts: new Date().toISOString(), level: 'warn', msg, ...extra });
  },
  error(msg, extra = {}) {
    writeLog({ ts: new Date().toISOString(), level: 'error', msg, ...extra });
  },
  // Log claude raw output to a separate file
  claudeLog(messageId, text) {
    try {
      const dir = join(config.logsDir, 'claude');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = join(dir, `${messageId}_${ts}.log`);
      appendFileSync(filePath, text + '\n', 'utf8');
      logger.info('claude log written', { filePath });
    } catch (e) {
      logger.error('failed to write claude log', { error: e.message });
    }
  },
};

export default logger;