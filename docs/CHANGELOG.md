# 更新日志 Changelog

## v0.2.1 — 2026-10-08

身份系统 + 远程控制 + 表坐标修复。

### 新增

1. **Micro 身份**
   - `src/index.js` — `buildPrompt()` 注入身份系统提示
   - 回答"你是谁"类问题时回复"我是 Micro 飞书智能助手，通过飞书机器人为你提供服务"

2. **飞书远程控制命令**
   - `/restart` — 重启桥接器，watchdog 自动重拉，全程无需人工介入
   - `/reboot` — 同 `/restart` 的别名
   - `/exit` — 停止桥接器及 watchdog，需手动 `启动桥接器.bat` 重新拉起
   - `/shutdown` — 同 `/exit` 的别名
   - 机制：命令在 `state/` 写入 `bridge.restart` / `bridge.stop` 标记文件后退出进程，watchdog 检测标记并执行对应操作
   - 文件变更：`src/commands.js`（新增命令处理）、`src/index.js`（支持 `_then` 回调）、`scripts/watchdog.ps1`（新增 restart/stop marker 检测）

### 修复

3. **MCP 表坐标更新**
   - `delay` 和 `completion_rate` 旧 appToken 失效（91402 NOTEXIST），原因为表格迁移到新多维表格文档
   - `config/table-map.json` 更新：两表 appToken 指向 `GRM6bKqaSax0MEs4fVmch5U6nze`（2026Q4延期情况统计）
   - `delay` → `tblvnxbmWGysv27O`（延期数据汇总）
   - `completion_rate` → `tblglROn8pRaGAVI`（每周完成率数据）
   - 新多维表格内另有 2 张辅助表：`tblBKFvcvCC3yayQ`（Q3 JIRA数据）、`tblYxXtdGnTZUgHu`（组别延期率统计表）
   - 权限修复：Wiki 空间协作者权限需单独授予应用，表级权限需单独确认

### 发现（非代码问题，待后续跟进）

- MCP 调用每次约 60+ 秒，根因在 API 渠道（deepseek-v4-pro）链路延迟，桥接器本身冷启动仅 607ms

## v0.2.0 — 2026-09-29

富文本全面升级 + Bug 修复 + 运维体验优化。

### 新增

1. **富文本解析器 `src/feishu/rich-text.js`**（~270 行，纯函数）
   - 统一入口 `parseMessageContent(content)` — JSON.parse → text/post/card 分流
   - Post 消息 9 种 tag 全覆盖：
     - 文本样式：粗体 `**text**` / 斜体 `*text*` / 下划线 `<u>text</u>` / 删除线 `~~text~~`
     - 链接：`[text](href)` / @提及：`@用户名`
     - Emoji：~80 种飞书 emoji_type → Unicode 映射
     - 代码块：` ```lang\ncode\n``` ` / 分割线：`---` / Markdown 块透传
     - 图片/文件引用：`[图片:key]` / `[文件:name]`
   - Card 解析升级：header.title → `**title**`、body.elements 递归、actions → `[按钮:text]`

2. **二进制文件检测 `isBinaryBuffer()`**（`src/index.js`）
   - 前 8 KiB null byte 扫描
   - 11 种文件魔数检测：PNG / JPEG / GIF / BMP / WebP / PDF / ZIP / GZIP / RAR / 7z / MP4
   - 引用上下文中的文件下载也走同一检测

3. **`关闭桥接器.bat`** — 根目录双击即停，替代手动 ps1

4. **`docs/技术架构.txt`** — 完整技术架构文档，含 AI Agent 排查指南

### 变更

- `src/feishu/inbound.js` — 删除 `flattenCard()` + `flattenRichText()`，`parseTextContent()` 委托 `rich-text.js`
- `src/feishu/merge-forward.js` — `renderContent()` 内联解析改为调用 `parseMessageContent()`，合并转发内的卡片/post 消息现在也能正确解析
- 删除 `变更配置.bat`（功能与 `一键配置.bat` 重合）
- 安装/配置提示文案统一指向 bat 文件名，不再引用内部脚本路径

### 修复

1. **MENTION_RE `/g` lastIndex 泄漏** — `inbound.js:7`，`test()` 带 g flag 会修改 lastIndex，改为不带 g 的 regex + `stripMentions` 用独立 `/g` 实例
2. **post 消息群 @提及认证失效** — `authorize()` 新增检查 `data.message.mentions[]` 数组
3. **二进制文件误判为文本** — `buf.toString('utf8')` 对二进制也可能产生非空乱码，改为 `isBinaryBuffer()` 前置检测
4. **MCP 重配置无法覆盖旧凭据** — `lib/write-config.ps1` 的 `Register-Mcp` 重写：remove→验证→add→再验证，解决 claude mcp 缓存旧 env vars

## v1.1.4 — 2026-09-28

稳定性修复 + 目录收束 + 部署包瘦身。

### 修复

1. **后台化 watchdog，修复「关窗导致桥失效」**
   - `start-bridge.ps1` 之前用 `& powershell -File watchdog.ps1` 前台挂载守护，watchdog 与双击窗口同进程链，关窗连带终止整条守护链，桥进程跟着死。
   - 改为 `Start-Process -WindowStyle Hidden` 后台起 watchdog，脱离窗口成独立进程；关窗后桥 + 守护继续跑。
   - 去重由「只信 bridge.lock」改为「遍历 node 进程匹配 `src\index.js`」，并新增 watchdog 去重与 node 互斥兜底，消除多实例撞车。

2. **给 uninstall-service.ps1 补 UTF-8 BOM**
   - 该脚本曾是唯一缺 BOM 的 ps1，Windows PowerShell 5.x 无 BOM 按 GBK 解码，中文注释/字符串被错读导致解析错误，卸载脚本一跑就挂。

### 收纳与清理

- 删除死文件 `config.yaml`（代码读 `.env`，该文件零引用），同步清理 README / write-config.ps1 中的误导性引用。
- 收束根目录零散文件，只保留 3 个入口 bat + README + package 源码：
  - `一键安装.bat` → `一键配置.bat`、`配置.bat` → `变更配置.bat`
  - `configure.ps1` / `setup.ps1` 下沉 `scripts/`
  - `table-map.json` / `table-map.example.json` / `.env.example` 下沉新建 `config/`
  - `CHANGELOG.md` 下沉 `docs/`
  - 代码 `feishu-table-map.js`、`selfcheck/check.mjs` 改读 `config/table-map.json`
- 清空 `logs/` / `state/` 运行时产物，部署包不再携带历史会话数据。

## v1.1.3 — 2026-09-28

修复两个导致回复丢失的关键 bug。均为 `src/claude/cli.js` 与 `src/index.js` 的改动，`src/` 以外无变更。

### 修复内容

1. **合流窗口 Promise 泄漏修复**
   - 现象：两条消息在 1.5s 合流窗口内先后到达时，bridge 崩溃报 `Cannot read properties of undefined (reading 'catch')`，两条消息均丢失。
   - 根因：`enqueueCoalesced()` 遗漏了 `return settled;`，调用方 `.catch()` 落在 `undefined` 上。
   - 修复：补回 `return settled;`，并在 timeout 回调中正确 `resolve` / `reject`，确保调用方拿到的永远是 Promise。

2. **"Claude 异常退出"误报修复（exit code 判断顺序）**
   - 现象：多轮 tool 任务（如 skill 指令 + Jira 查询 + 飞书卡片生成）claude 实际已产出完整回复，bridge 却丢弃回复并返回「Claude 异常退出」。
   - 根因：`cli.js` 中 `result.code !== 0` 的退出码检查发生在 `collectResult()` 解析 stdout 之前。claude 在某些多轮场景下会因中间被打断或 SDK 内部异常以非 0 退出，但 stdout 中的 `assistant` + `result` 文本已经完整。
   - 修复：重新排序 —— `collectResult()` 先解析 stdout，若已拿到完整文本且非 `sawError`，即使 exit code ≠ 0 也降级使用（打 warn 日志），仅在没有产出文本时才报错。

### 验证

- 合流窗口：模拟两条消息在 1.5s 内到达，bridge 不再崩溃，仅保留最新一条处理。
- 退出码：debug 日志确认常规消息 `result.code === 0`；非 0 退出但有文本的场景降级使用，不再误报。

## v0.1.3 — 2026-09-23

- 识别飞书卡片（interactive）消息，递归抽出卡片里的 markdown / 文本块作为正文
- 回复时不再逐条外泄 Claude 的思考过程与工具中间步骤，统一只回一条干净的最终结果

## v0.1.2 — 2026-09-22

- 识别合并转发的聊天记录，按姓名 + 时间结构化展示
- 支持回复/引用上下文，文本、聊天记录、文件内容都能带入理解
- 引用消息里自动带上发送人姓名
- 图片消息改为友好提示（当前模型暂不支持识图）
- 移除代码里硬编码的私有表格坐标，表格映射改为纯运行时配置（table-map.json，已加入 .gitignore，提供 table-map.example.json 模板）

## v0.1.1 — 2026-09-21

修复飞书多维表格（Bitable）写入相关的一批关键 bug。本次改动集中在 `src/mcp/feishu-table-map.js` 与 `src/mcp/tools.js`，`src/` 以外无破坏性变更。

### 修复内容

1. **completion_rate 写入字段映射修复**
   - 现象：`create_record` / `update_record` 写 `completion_rate` 表时，无论传中文字段名、英文 key、原始 tableId，甚至仅传 `{"日期":"2026/09/21"}`，一律返回 `code=1254045 FieldNameNotFound`。
   - 根因：`toFeishuRecord` 把中文字段名**错误转成了 fieldId** 再作为写入 key 发送。
   - 修复：`toFeishuRecord` 的 **key 一律用 field_name（中文字段名），不再转 fieldId**；value 的类型转换（单选/多选→optionId、user→id 对象、number→数值）保留。

2. **delay 表同类写入问题修复**
   - 同一根因影响 `delay` 表：用 fieldId 写同样返回 1254045。本次一并修复，两表写入行为现在一致。

3. **resolve_wiki_node 正确解析标准 /wiki/{token} 并返回 appToken**
   - 现象：`feishu_resolve_wiki_node` 对标准 `/wiki/{token}` 链接无法返回节点类型与真实 obj_token。
   - 修复：改为走正确的 `wiki/v2/spaces/get_node?token=…` 路径，返回 `nodeToken` / `nodeType` / `objType` / `objToken` / `appToken`（Bitable 节点时，appToken = obj_token）/ `spaceId` / `title` / `hasChild`。

4. **新增字段元数据拉取接口 `feishu_get_table_fields`**
   - 新增 MCP 工具，拉取多维表格真实字段元数据（fieldName/fieldId/type/uiType/isPrimary），返回 6 个字段（日期、当日任务总数、已完成任务数量、Delay/Pending任务数量、任务完成率、记录日期）。
   - 用途：写入前确认真实字段名与类型，避免依赖静态表映射或写出错的字段。

5. **DateTime 字段写入修复（回归中发现，一并修复）**
   - 现象：写 `记录日期` / `更新后Finish date` 等 DateTime 字段（飞书 type=5）时，传字符串日期报 `1254064 DatetimeFieldConvFail`。
   - 根因：table-map.json 把这类字段标为 `date`，`toFieldValue` 对 `date` 原样透传字符串；而飞书 DateTime 字段要求 epoch 毫秒 number。
   - 修复：类型标注改为 `datetime`；`toFieldValue` 对 `datetime` 字段把 `yyyy-MM-dd` / `yyyy/MM/dd` 字符串转成当日 00:00 的 epoch 毫秒，number 直接透传。

### 明确约束（重要）

- **飞书写入 API 必须以 field_name 为 key，不支持 field_id 作为 fields 的 key。** 传 fieldId 会统一报 `1254045 FieldNameNotFound`。这是飞书 Bitable records 写入接口的硬约束，已按此修正。
- 单选/多选字段的 **value** 可传 optionId 或中文选项名（飞书均可识别）；普通字段（text/number/date/formula）value 直接传值。公式字段（如「任务完成率」）为只读，不可写入。

### 验证

- 最小回归：resolve_wiki_node、字段元数据拉取、completion_rate 与 delay 两表各创建/更新一条测试记录（用可回收记录，写后即删，不污染正式表）。
- 端到端：重启 MCP 与桥接器进程后，确认实际被 Agent 调用的进程已加载新代码。
