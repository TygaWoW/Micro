// cli.js — spawn claude.exe as subprocess, parse stream-json, manage timeouts
import { spawn, exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { BridgeError } from '../errors.js';

// Track in-flight children for /stop tree-kill
const activeChildren = new Map(); // chatId -> child process

// Kill a process tree on Windows (claude.exe may spawn grandchild shells)
function treeKill(pid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      return resolve();
    }
    exec(`taskkill /pid ${pid} /T /F`, { windowsHide: true }, () => resolve());
  });
}

export function stopClaude(chatId) {
  const child = activeChildren.get(chatId);
  if (!child) return false;
  treeKill(child.pid);
  activeChildren.delete(chatId);
  return true;
}

export function hasActiveClaude(chatId) {
  return activeChildren.has(chatId);
}

function parseStreamLine(line) {
  const text = line.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Extract the final assistant text and session_id from stream-json output.
// stream-json emits a sequence of objects; the last 'result' message carries the
// final text and session_id. Tool/assistant messages carry incremental content.
function collectResult(lines) {
  let finalText = '';
  let sessionId = null;
  let sawError = false;
  let errMessage = '';

  for (const line of lines) {
    const obj = parseStreamLine(line);
    if (!obj) continue;

    switch (obj.type) {
      case 'result': {
        // Final result message
        if (typeof obj.result === 'string') {
          finalText = obj.result;
        } else if (obj.result && typeof obj.result === 'object') {
          finalText = obj.result.text ?? '';
        }
        sessionId = obj.session_id ?? sessionId;
        if (obj.is_error) {
          sawError = true;
          errMessage = finalText || 'unknown error';
        }
        break;
      }
      case 'assistant': {
        // Incremental assistant message — append content blocks
        const blocks = obj.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === 'text' && b.text) finalText += b.text;
        }
        sessionId = obj.session_id ?? sessionId;
        break;
      }
      case 'system':
        // session_id often appears in system init messages
        sessionId = obj.session_id ?? sessionId;
        break;
      default:
        // ignore other message types (tool_use, tool_result, etc.)
        break;
    }
  }

  return { finalText: finalText.trim(), sessionId, sawError, errMessage };
}

// Run Claude Code for a prompt. Returns { text, sessionId }.
// @param {object} opts — { prompt, sessionId, chatId, onProgress, allowedTools }
export async function runClaude({ prompt, sessionId, chatId, onProgress, allowedTools }) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', config.claudePermissionMode,
  ];

  // 图片识别等场景：允许 Claude 用 Read 工具读本地文件（绝对路径写在 prompt 里）
  if (allowedTools && allowedTools.length) {
    args.push('--allowedTools', allowedTools.join(','));
  }

  if (sessionId) {
    args.push('--resume', sessionId);
  } else {
    args.push('--session-id', randomUUID());
  }

  logger.info('spawning claude', { chatId, sessionId: sessionId ?? '(new)', promptLen: prompt.length });

  // 确定 claude 可执行对象：CLAUDE_BIN 明确且存在则用它；否则回退到 PATH 上的 `claude` 命令，
  // 保证放到别人电脑上（claude 装哪都能跑，只要命令行认 `claude`）。
  const bin = config.claudeBin && existsSync(config.claudeBin) ? config.claudeBin : 'claude';
  const useShell = bin === 'claude' && process.platform === 'win32';
  if (useShell) {
    logger.info('claude path fallback', { reason: 'CLAUDE_BIN missing/unresolvable — using PATH `claude` via shell' });
  }

  let child;
  try {
    child = spawn(bin, args, {
      cwd: config.claudeCwd,
      windowsHide: true,
      shell: useShell,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new BridgeError('CLAUDE_SPAWN_FAILED', '无法启动 Claude。');
  }

  activeChildren.set(chatId, child);

  const stdoutLines = [];
  const stderrLines = [];

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  // Collect stdout incrementally
  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      stdoutLines.push(line);

      // Reset both timers on each stdout line — process is alive
      refreshTimers();

      // Optional progress callback on assistant messages
      try {
        const obj = parseStreamLine(line);
        if (obj?.type === 'assistant' && onProgress) {
          const blocks = obj.message?.content ?? [];
          const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
          if (text) onProgress(text);
        }
      } catch { /* ignore progress parse errors */ }
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrLines.push(chunk.toString());
  });

  // ---- Timeout management ----
  // Two layers:
  //   1) progressTimeout: no stdout for N ms → process is stuck (API rate-limit / hang) → kill
  //   2) hardTimeout: absolute deadline → kill (catches cases where claude is "thinking"
  //      but never finishes, e.g. infinite tool loop)
  // Both reset on each stdout line — long but productive thinking won't trigger either.
  let hardTimer = null;
  let progressTimer = null;
  let timedOut = false;
  let progressKilled = false;
  let rearmTime = 0; // debounce: don't rearm timer floods

  function refreshTimers() {
    // Debounce: don't rearm on every line during burst output
    if (Date.now() - rearmTime < 100) return;
    rearmTime = Date.now();

    if (progressTimer) clearTimeout(progressTimer);
    if (hardTimer) clearTimeout(hardTimer);

    progressTimer = setTimeout(() => {
      logger.warn('claude progress stall — no stdout for ' + config.progressTimeoutMs + 'ms, killing', { chatId });
      progressKilled = true;
      treeKill(child.pid);
    }, config.progressTimeoutMs);

    hardTimer = setTimeout(() => {
      logger.warn('claude hard timeout — ' + config.hardTimeoutMs + 'ms elapsed', { chatId });
      timedOut = true;
      treeKill(child.pid);
    }, config.hardTimeoutMs);
  }

  refreshTimers();

  // Race: exit vs progress stall vs hard timeout.
  // Timers kill the child which triggers exit; we check flags after exit to know why.
  const exitResult = await exitPromise;
  if (progressTimer) clearTimeout(progressTimer);
  if (hardTimer) clearTimeout(hardTimer);
  progressTimer = null;
  hardTimer = null;

  logger.info('claude race result (debug)', {
    chatId,
    result: exitResult,
    progressKilled,
    timedOut,
  });

  // Flush remaining stdout buffer
  if (stdoutBuf.trim()) stdoutLines.push(stdoutBuf);

  activeChildren.delete(chatId);

  // Log raw claude output (separate file)
  logger.claudeLog(chatId + '_' + (sessionId ?? 'new'), stdoutLines.join('\n') + '\n---STDERR---\n' + stderrLines.join('\n'));

  if (timedOut || progressKilled) {
    throw new BridgeError('CLAUDE_TIMEOUT', '响应超时，已终止 Claude 进程。');
  }

  // 先解析 stdout，拿到最终文本/session/sawError，再做退出码判断。
  // 原因：多轮 tool 任务（如 skill/Jira 查询）claude 可能跑完并吐出了 assistant 文本，
  // 却因中间被打断或 SDK 内部异常而以非 0 退出——此时最终文本往往已经完整，
  // 不应仅凭 exit code 就丢弃用户可用的回答（旧逻辑在这里误报"Claude 异常退出"）。
  const { finalText, sessionId: outSessionId, sawError, errMessage } = collectResult(stdoutLines);

  if (sawError) {
    throw new BridgeError('CLAUDE_EXIT_ERROR', errMessage || 'Claude 处理出错。');
  }

  if (exitResult?.code && exitResult.code !== 0) {
    // 非 0 退出：有完整回话文本则降级使用，没有才报错。
    if (finalText) {
      logger.warn('claude non-zero exit but has text — using text', { chatId, exitCode: exitResult.code });
    } else {
      const e = new BridgeError('CLAUDE_EXIT_ERROR', `Claude 异常退出。`, exitResult.code);
      e.exitCode = exitResult.code;
      throw e;
    }
  }

  if (!finalText && !outSessionId) {
    throw new BridgeError('CLAUDE_EXIT_ERROR', 'Claude 未返回有效输出。');
  }

  return { text: finalText, sessionId: outSessionId || sessionId };
}

export default runClaude;