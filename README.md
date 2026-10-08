# 飞书 ↔ Claude 桥接器 · 部署包

把 Claude Code 接入飞书机器人：手机发消息给飞书机器人 → 电脑上的 Claude 干活 → 结果回飞书。

---

## 给同事用？两步就够了

### 1. 前置条件
- 已安装 [Node.js](https://nodejs.org) ≥ v20
- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)
- 电脑能科学上网（Claude API 调的是公司代理）

### 2. 双击 `一键配置.bat`

脚本自动做四件事，最后弹出一个**配置弹窗**：

1. `npm install` 装依赖
2. 注册飞书 + Jira 两个 MCP 服务器（用官方 `claude mcp add`，凭据写进 MCP env）
3. 注册 Windows 计划任务（开机自启）
4. **弹出配置弹窗**，填写以下信息后点「保存配置」即生效：

| 弹窗输入框 | 说明 |
|---|---|
| 飞书 App ID / App Secret | 飞书开放平台 → 应用凭证页 |
| 默认 Chat ID | **必填**。桥接器只在这个 chat 里收发。群聊填 `oc_xxx`，私聊填 `ou_xxx` |
| Jira 秘钥(PAT) | 可留空。后续所有需 Jira MCP 访问权限的操作都用这个秘钥 |

> 配置统一通过弹窗填写。想随时改配置，双击根目录的 `一键配置.bat` 重新弹窗即可。

### 2.5 先跑一遍自检沙盒（推荐）

装完配置好后、正式用之前，先跑一遍 **自检沙盒**，提前把「权限没开 / 机器人没进群 / 多维表格鉴权不过」等问题报出来：

```powershell
node selfcheck/check.mjs
```

全绿即「新环境就绪」。脚本只读不写（不碰 `.claude.json`、不改生产状态），在自身目录隔离运行。

---

## 消息格式支持

桥接器能正确解析飞书发来的以下消息类型：

### 文本消息
- ✅ 纯文本消息 — 直接作为正文传给 Claude

### 富文本（post）消息 — 完整支持
| 格式 | 说明 |
|---|---|
| **粗体** / *斜体* / <u>下划线</u> / ~~删除线~~ | 转为对应 Markdown 语法 |
| 链接 | 转为 `[文本](链接)` |
| @提及 | 用 `@用户名` 保留可读性 |
| Emoji 表情 | 约 80 种飞书表情 → 对应 Unicode 字符 |
| 代码块 | 转为 ` ```lang\ncode\n``` ` 格式（支持 20+ 语言） |
| 分割线 | 转为 `---` |
| 图片/文件引用 | 标记为 `[图片:key]` / `[文件:name]` |
| Markdown 块 | 原文透传 |

### 卡片（interactive）消息
- ✅ 卡片标题（header.title）→ `**标题**`
- ✅ 正文内容（body.elements / Card 1.0 elements）— 递归提取 markdown / plain_text / lark_md / text / div
- ✅ 按钮（actions）→ `[按钮:按钮文字]`
- ✅ 图片 / 分割线占位符

### 文件上传
| 文件类型 | 行为 |
|---|---|
| 文本文件（.md / .txt / .csv / .json / .js / .py / .html 等） | ✅ 读取内容传给 Claude |
| 代码文件（各编程语言源代码） | ✅ 读取内容传给 Claude |
| 二进制文件（图片 / PDF / 压缩包 / Office 文档） | ❌ 自动拦截，提示「二进制格式无法解析」 |
| 图片消息 | ℹ️ 不传 Claude，直接提示「暂不支持图片识别」 |

> 二进制检测通过 null byte 扫描 + 文件魔数双重判断（PNG / JPEG / GIF / BMP / WebP / PDF / ZIP / GZIP / RAR / 7z / MP4 等均被拦截）。

### 合并转发
- ✅ 合并转发的聊天记录 → 按发送人 + 时间戳结构化展示，嵌套结构保留缩进层级

---

## 关于「默认 chatid 锁定」

`默认 Chat ID` 一旦填写，桥接器就**锁定**在这个对话里交互：其它 chat 发来的消息会被静默忽略，聊天默认在它填写的 chat 里发生——不再需要部署后手动在 Claude 里配聊天场景。

**访问控制只靠「锁定聊天场景」**：不设黑白名单，同一 chat 内的任何人都能和机器人交互。把机器人拉进一个群、填上这个群的 `oc_xxx`，群里所有人即可直接使用。想清空对话上下文，在群里发 `/new`。

## 关于「飞书权限身份」

配置弹窗里填的 `app_id / app_secret`，会被 `scripts\setup.ps1` / `lib\write-config.ps1` 写死进飞书 MCP 进程的 `env`。这样所有飞书 MCP 操作（读写多维表格、读文档、发消息…）都**默认以这个机器人（应用）身份执行**，不会再退化成「当前登录用户」导致报「用户无权限」。

---

## 飞书开放平台还要检查这 5 步

部署包只是把你的凭据写进本地。飞书应用**本身**还要在飞书开放平台配好：

1. **开启 Bot 能力** — 应用功能 → 机器人 → 启用
2. **事件订阅切「长连接」** — 事件订阅 → 长连接模式（不需要公网 URL）
3. **订阅事件 `im.message.receive_v1`** — 点「添加事件」
4. **开通权限**（至少三项）：
   - `im:message:send_as_bot`
   - `im:message:receive_v1`
   - `im:message:reply`
5. **发布新版本** — 右上角「创建版本」→ 发布

---

## 目录结构

```
feishu-claude-bridge-部署包/
├── 一键配置.bat       ← 双击安装/改配置（弹窗，覆盖旧配置）
├── 启动桥接器.bat     ← 双击启动（关窗口桥不停，后台守护）
├── 关闭桥接器.bat     ← 双击停止
├── README.md          ← 本说明
├── package.json
├── src/
│   ├── index.js       ← 主入口（消息路由、prompt 构造、Claude 调用）
│   ├── config.js      ← 读 .env 的配置层
│   ├── logger.js      ← 日志
│   ├── errors.js      ← 错误分类
│   ├── queue.js       ← 合流窗口 + 并发控制
│   ├── commands.js    ← 本地命令（/new /stop /status 等）
│   ├── claude/
│   │   ├── cli.js     ← 调 claude.exe 子进程
│   │   └── session.js ← 会话管理
│   ├── feishu/
│   │   ├── client.js       ← 飞书 SDK 初始化 + WS + HTTP
│   │   ├── inbound.js      ← 消息解析 + 归一化 + 认证 + 去重
│   │   ├── rich-text.js    ← 统一富文本/卡片解析（post + interactive）
│   │   ├── merge-forward.js← 合并转发渲染
│   │   └── outbound.js     ← 回复/发消息
│   └── mcp/
│       ├── server.js       ← MCP server 入口
│       ├── tools.js        ← MCP 工具实现
│       ├── feishu-table-map.js ← 表格字段映射
│       └── jira/
│           └── server.js   ← Jira MCP
├── scripts/
│   ├── configure.ps1      ← WinForms 配置向导（弹窗）
│   ├── setup.ps1          ← 安装脚本（装依赖 + 注册自启，调 lib 配置中心）
│   ├── start-bridge.ps1   ← 手动启动（后台起 watchdog 守护，关窗口桥不停）
│   ├── stop-bridge.ps1    ← 手动停止（放停止标记 + 结束进程）
│   ├── watchdog.ps1       ← 守护进程（常驻，计划任务调用）
│   ├── install-service.ps1← 注册开机自启
│   └── uninstall-service.ps1 ← 注销开机自启（含停守护、清状态）
├── config/
│   ├── table-map.json       ← 多维表格映射（appToken/tableId/fieldId/optionId，换成你的表即可）
│   ├── table-map.example.json ← 表格映射模板
│   └── .env.example         ← 环境变量模板
├── lib/               ← 配置中心 write-config.ps1（唯一写 .env/mcp 的地方）
├── selfcheck/         ← 新环境自检沙盒（部署前先跑一遍）
├── docs/              ← 更新日志
├── state/             ← 运行时状态（自动生成）
└── logs/              ← 日志（自动生成）
```

---

## 进程归属与启停（v0.1）

桥接器**只有一个守护者**：`watchdog.ps1`（由计划任务 `FeishuClaudeBridge` 调用）。它常驻运行，桥接器进程（`node src/index.js`）无论正常退出还是崩溃，都会被它自动重新拉起。

> 之前容易搞混的地方（v0.1 已修）：无论你在哪儿启动，最终都是 watchdog 在管。那个 powershell 前端窗口只是「一次性触发」，
> **关掉它不会停止桥接器**。别再担心"挂着的窗口能不能关"——可以关，桥照跑。

| 操作 | 怎么做 | 效果 |
|------|--------|------|
| 启动 | 双击 `scripts\start-bridge.ps1`，或重启电脑（已注册计划任务） | watchdog 拉起并常驻守护 |
| 停止 | 双击 `scripts\stop-bridge.ps1` | 优雅停止（放 `state\bridge.stop` + 结束进程） |
| 永久停止（不再自启） | 手动放一个 `state\bridge.stop` 空文件，或跑 `scripts\uninstall-service.ps1` | watchdog 看到标记后退出；卸载脚本还删计划任务 |
| 查状态 | 群/私聊里发 `/status`；或看 `logs\watchdog.log` 与 `logs\bridge-*.log` | 了解当前 PID 与健康状态 |

**停止标记 `state\bridge.stop`**：它是一个纯文本标记文件，存在即代表「请求停止」。watchdog 每轮循环都会检查它，检测到就删除该文件并优雅退出。要恢复运行，重新启动即可（`start-bridge.ps1` 会自动清除残留标记）。

---

## 使用方式

- **私聊**：直接给飞书机器人发消息
- **群聊**：@机器人 后发消息
- 访问控制只靠「锁定默认 chat」：同一 chat 内所有人都可交互，不设白名单
- 常用命令：`/new`（清上下文）、`/stop`（终止运行）、`/status`（状态）