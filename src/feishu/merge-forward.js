// merge-forward.js — 把飞书「合并转发」消息解析成结构化文本
// 合并转发消息(message_type=merge_forward)的 content 只是占位符，真实内容
// 需通过 im.v1.message.get 拉取 data.items[]：父消息在前(无 upper_message_id)，
// 子消息各带 upper_message_id 指向直接父，据此拼树并渲染成可读文本。
//
// 参考 SDK 内置 convertMergeForward 的思路(见 @larksuiteoapi/node-sdk 的
// buildChildrenMap/formatSubTree/renderItem)，但这里针对我们的裸 SDK + 只读场景
// 重写，避免引入完整 SDK 封装。

import { parseMessageContent } from './rich-text.js';

// 解析条目的 sender 名称。飞书返回的 sender 可能是 {id} 或 {id, id_type, sender_type}
// 或 {sender_id:{open_id}} 等多种形态，这里尽量兼容。
function resolveSenderName(sender) {
  if (!sender) return 'unknown';
  if (typeof sender === 'string') return sender;
  // 优先：message.get(with_sender_name=true) 返回的真实姓名
  if (sender.sender_name) return sender.sender_name;
  if (sender.sender_i18n_names?.zh_cn) return sender.sender_i18n_names.zh_cn;
  if (sender.sender_i18n_names?.en_us) return sender.sender_i18n_names.en_us;
  if (sender.name) return sender.name;
  const id = sender.id ?? sender.user_id ?? sender.open_id
    ?? sender.sender_id?.open_id ?? sender.sender_id?.user_id;
  if (!id) return 'unknown';
  // 兜底：没有名字时用 open_id 后 6 位做可读占位符
  const s = String(id);
  return s.length > 6 ? `用户-${s.slice(-6)}` : s;
}

// 把 msg_type + body.content 渲染成纯文本。
function renderContent(msgType, body) {
  const raw = body?.content ?? '';
  if (!raw) return '[empty]';
  // Use the unified rich-text parser (handles text / post / card)
  const text = parseMessageContent(raw);
  if (text) return text;
  // 兜底：非文本类型(图片/文件等)给一个可读标签
  return `[${msgType || 'message'}]`;
}

// 把 items 平铺列表按 upper_message_id 拼成树，再渲染。
// rootId = 顶层消息的 message_id(通常是 items[0].message_id)。
export function renderMergeForward(items) {
  if (!Array.isArray(items) || items.length === 0) return '';

  const rootId = items[0]?.message_id;

  // pid -> children[]（按 create_time 升序）
  const map = new Map();
  for (const it of items) {
    if (it.message_id === rootId && !it.upper_message_id) continue; // 跳过父节点本身
    const pid = it.upper_message_id ?? rootId;
    let arr = map.get(pid);
    if (!arr) { arr = []; map.set(pid, arr); }
    arr.push(it);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => (Number(a?.create_time) || 0) - (Number(b?.create_time) || 0));
  }

  const formatTs = (ms) => {
    const t = Number(ms);
    if (!t) return 'unknown time';
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const renderSubTree = (parentId, depth = 0) => {
    const children = map.get(parentId);
    if (!children || children.length === 0) return [];
    const lines = [];
    const indent = '  '.repeat(depth);
    for (const item of children) {
      const who = resolveSenderName(item.sender);
      let content;
      if (item.msg_type === 'merge_forward') {
        // 嵌套合并转发：就地递归，不再额外拉 API
        const subs = renderSubTree(item.message_id, depth + 1);
        content = subs.length ? `\n${subs.join('\n')}` : '[forwarded]';
      } else {
        content = renderContent(item.msg_type, item.body);
      }
      const indented = content.split('\n').map((l) => indent + l).join('\n');
      lines.push(`${indent}[${formatTs(item.create_time)}] ${who}: ${indented}`);
    }
    return lines;
  };

  return renderSubTree(rootId).join('\n');
}
