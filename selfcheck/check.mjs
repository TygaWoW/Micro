// selfcheck/check.mjs — new-environment self-check sandbox
// Uses feishu app credentials from .env to probe four tiers of health
// BEFORE running the real bridge. Read-only; no side effects.
// All steps report pass/fail/warn in real time.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENV_PATH = join(ROOT, '.env');
const TABLE_MAP_PATH = join(ROOT, 'config', 'table-map.json');

// ---- helpers ----
const grief = '\x1b[1;31mFAIL\x1b[0m';  // bold red
const okStr = '\x1b[32mOK\x1b[0m';
const warnStr = '\x1b[33mWARN\x1b[0m';
const line  = (...a) => console.log(...a);
const ok    = (name, detail = '') => console.log(`  ${okStr}  ${name}${detail ? ' — ' + detail : ''}`);
const bad   = (name, detail = '') => console.log(`  ${grief}  ${name}${detail ? ' — ' + detail : ''}`);
const warn  = (name, detail = '') => console.log(`  ${warnStr}  ${name}${detail ? ' — ' + detail : ''}`);

// ---- load .env (zero-deps) ----
function loadEnv() {
  const env = { ...process.env };
  if (existsSync(ENV_PATH)) {
    for (const raw of readFileSync(ENV_PATH, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const t = raw.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (k && !env[k]) env[k] = v;
    }
  }
  return env;
}

const env = loadEnv();
const APP_ID     = (env.FEISHU_APP_ID     || '').trim();
const APP_SECRET = (env.FEISHU_APP_SECRET || '').trim();
const CHAT_ID    = (env.FEISHU_CHAT_ID    || '').trim();
const CHAT_IS_GROUP = CHAT_ID.startsWith('oc_');

let fatal = false;
let failCount = 0;

line('');
line('========================================================');
line('  飞书 ⇄ Claude 桥接器 · 新环境自检沙盒');
line('========================================================');
line('');

// ====== Step 0: config completeness ======
line('[1/4] 检查配置完整性');
if (!APP_ID)     { bad('FEISHU_APP_ID',     '未配置'); fatal = true; } else ok('FEISHU_APP_ID',     APP_ID);
if (!APP_SECRET) { bad('FEISHU_APP_SECRET', '未配置'); fatal = true; } else ok('FEISHU_APP_SECRET', '(已配置，值已隐藏)');
if (!CHAT_ID)    { bad('FEISHU_CHAT_ID',    '未配置（必填）'); fatal = true; } else ok('FEISHU_CHAT_ID', CHAT_ID + (CHAT_IS_GROUP ? ' (群聊)' : ' (私聊)'));
if (fatal)       { line('\n配置不完整，请通过 配置.bat 补全后重试。'); process.exit(1); }
line('');

// ====== Step 1: get tenant_access_token ======
line('[2/4] 换取 tenant_access_token（验证机器人身份）');
let token = '';
try {
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await r.json();
  if (data.code === 0 && data.tenant_access_token) {
    token = data.tenant_access_token;
    ok('token 获取成功', `code=${data.code} expire=${data.expire}s`);
  } else {
    bad('token 获取失败', `code=${data.code} msg=${data.msg}`);
    failCount++;
  }
} catch (e) {
  bad('token 请求异常', e.message);
  failCount++;
}
line('');

// ====== Step 2: validate default chat ======
line('[3/4] 校验默认 chat 与机器人群关系');
if (token) {
  if (CHAT_IS_GROUP) {
    try {
      const r = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats/${CHAT_ID}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      if (data.code === 0) {
        ok('群 chat 有效', `群名: ${data.data?.name ?? '(未命名)'}`);
      } else {
        bad('群 chat 无效', `code=${data.code} msg=${data.msg}`);
        failCount++;
      }
    } catch (e) {
      bad('群校验请求异常', e.message);
      failCount++;
    }
  } else {
    ok('私聊 open_id 已配置', CHAT_ID);
  }
} else {
  warn('跳过 chat 校验', '无 token');
}
line('');

// ====== Step 3: bitable auth probe ======
line('[4/4] 多维表格鉴权探针（真实读一次 delay 表）');
if (token) {
  let tables = null;
  try {
    const raw = readFileSync(TABLE_MAP_PATH, 'utf8').replace(/^﻿/, '');
    tables = JSON.parse(raw).tables;
  } catch (e) { /* table-map.json missing or malformed */ }

  if (tables && tables.delay) {
    const { appToken, tableId } = tables.delay;
    if (!appToken || !tableId) {
      warn('delay 表未配置 appToken/tableId', '跳过表格鉴权');
    } else {
      try {
        const r = await fetch(
          `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=1`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const data = await r.json();
        if (data.code === 0) {
          ok('多维表格鉴权通过', `delay 表，共 ${data.data?.total ?? 0} 条`);
        } else {
          bad('多维表格鉴权失败', `code=${data.code} msg=${data.msg}`);
          printScopeHint(data.code);
          failCount++;
        }
      } catch (e) {
        bad('多维表格请求异常', e.message);
        failCount++;
      }
    }
  } else {
    warn('table-map.json 中未找到 delay 表', '跳过表格鉴权');
  }
} else {
  warn('跳过多维表格鉴权', '无 token');
}
line('');

// ====== Summary ======
line('--------------------------------------------------------');
if (failCount === 0) {
  ok('自检通过 — 新环境已就绪，可以放心使用。');
} else {
  bad(`自检发现 ${failCount} 项问题，请按上方提示逐项修复后重跑。`);
}
line('--------------------------------------------------------');
line('');
if (failCount) process.exit(1);

// ---- permission scope hint ----
function printScopeHint(code) {
  line('');
  if (code === 99991663 || code === 99991661) {
    line('  建议在飞书开放平台 → 你的应用 → 权限管理 开通：');
    line('    - bitable:app');
  } else if (code === 99991672) {
    line('  该多维表格可能未添加机器人为协作者。');
    line('  解决：多维表格右上角… → 更多 → 添加协作者 → 搜索你的机器人应用并添加。');
  } else {
    line('  若为权限类错误，请在飞书开放平台 → 你的应用 → 权限管理 检查多维表格/文档相关 scope，');
    line('  并确认目标文档/表格已添加应用为协作者。');
  }
}