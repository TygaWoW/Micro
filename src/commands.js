// commands.js — local bridge commands handled without invoking Claude
import { clearSession, getSessionId } from './claude/session.js';
import { stopClaude, hasActiveClaude } from './claude/cli.js';
import { config } from './config.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const STATE_DIR = join(ROOT, 'state');
function ensureStateDir() { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); }

const UPTIME_START = Date.now();

const HELP_TEXT = `可用命令：
/new — 开始新会话（清空当前对话上下文）
/stop — 终止正在运行的 Claude 任务
/status — 查看当前状态
/restart — 重启桥接器（watchdog 会自动重拉）
/exit — 停止桥接器及守护进程（需手动 启动桥接器.bat 重新拉起）
/cwd <路径> — 查看/设置 Claude 工作目录
/help — 显示本帮助`;

// Returns { handled: true, reply: string } if the message is a command, else { handled: false }
export function handleCommand(inbound) {
  const text = inbound.text;

  if (text === '/new') {
    clearSession(inbound.chatId);
    return { handled: true, reply: '✅ 已开始新会话' };
  }

  if (text === '/stop') {
    const stopped = stopClaude(inbound.chatId);
    return { handled: true, reply: stopped ? '⏹ 已终止运行中的任务' : 'ℹ️ 当前没有运行中的任务' };
  }

  if (text === '/status') {
    const sessionId = getSessionId(inbound.chatId);
    const uptime = Math.floor((Date.now() - UPTIME_START) / 1000);
    const busy = hasActiveClaude(inbound.chatId);
    const status = [
      `会话: ${sessionId ? sessionId.slice(0, 8) + '...' : '(新会话)'}`,
      `运行时长: ${Math.floor(uptime / 60)}m ${uptime % 60}s`,
      `任务状态: ${busy ? '运行中' : '空闲'}`,
      `权限模式: ${config.claudePermissionMode}`,
      `并发上限: ${config.maxConcurrentClaude}`,
    ].join('\n');
    return { handled: true, reply: `📊 状态\n${status}` };
  }

  if (text === '/restart' || text === '/reboot') {
    ensureStateDir();
    writeFileSync(join(STATE_DIR, 'bridge.restart'), '', 'utf8');
    // 先发回复再退出，给飞书 API 一点时间把消息发出去
    return {
      handled: true,
      reply: '🔁 正在重启桥接器，请稍候...',
      _then: () => {
        // 等 500ms 让回复先发出去，再退出
        setTimeout(() => process.exit(0), 500);
      },
    };
  }

  if (text === '/exit' || text === '/shutdown') {
    ensureStateDir();
    writeFileSync(join(STATE_DIR, 'bridge.stop'), '', 'utf8');
    return {
      handled: true,
      reply: '🛑 桥接器已停止。重新启动请运行 启动桥接器.bat。',
      _then: () => {
        setTimeout(() => process.exit(0), 500);
      },
    };
  }

  if (text === '/help') {
    return { handled: true, reply: HELP_TEXT };
  }

  if (text.startsWith('/cwd')) {
    return { handled: true, reply: `当前工作目录: ${config.claudeCwd}\n（修改需编辑 .env 的 CLAUDE_CWD 后重启）` };
  }

  return { handled: false };
}

export default { handleCommand, HELP_TEXT };