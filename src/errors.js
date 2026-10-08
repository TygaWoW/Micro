// errors.js — error classification and user-facing messages
export class BridgeError extends Error {
  constructor(code, message, httpStatus = 500) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }

  toFeishu() {
    return `❌ ${this.message}`;
  }
}

export function classifyError(err) {
  // Already classified
  if (err instanceof BridgeError) return err;

  // Claude subprocess errors
  if (err.code === 'CLAUDE_TIMEOUT') {
    return new BridgeError('CLAUDE_TIMEOUT', '响应超时，已终止 Claude 进程。可重新发送消息重试。');
  }
  if (err.code === 'CLAUDE_SPAWN_FAILED') {
    return new BridgeError('CLAUDE_SPAWN_FAILED', '无法启动 Claude，请检查 claude.exe 路径和配置。');
  }
  if (err.code === 'CLAUDE_EXIT_ERROR') {
    return new BridgeError('CLAUDE_EXIT_ERROR', `Claude 异常退出 (exit code: ${err.exitCode})。可重试。`);
  }

  // Queue errors
  if (err.code === 'QUEUED') {
    return new BridgeError('QUEUED', '上一条消息仍在处理中，当前消息已加入队列。');
  }

  // Unexpected
  return new BridgeError('UNEXPECTED', `内部错误: ${err.message}`);
}