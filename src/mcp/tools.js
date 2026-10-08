// tools.js — MCP tool definitions and handlers
import { client } from '../feishu/client.js';
import { config } from '../config.js';
import { resolveTableRef, TABLES, fetchFieldMap, toFeishuRecord } from './feishu-table-map.js';

// ---- Helper: log to stderr only (never stdout) ----
function log(msg, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), msg, ...data });
  console.error(line);
}

// ---- Error wrapper ----
async function safeHandler(name, fn, args) {
  try {
    return await fn(args);
  } catch (err) {
    log(`tool error: ${name}`, { error: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
    return {
      content: [{ type: 'text', text: `❌ 调用失败: ${err.message}` }],
      isError: true,
    };
  }
}

// Build a user-friendly "unknown table" error message from the loaded aliases
function unknownTableMessage(given) {
  const aliases = Object.keys(TABLES || {});
  if (aliases.length) {
    return `未知表: ${given}。可用别名: ${aliases.join(', ')}；或传原始 tableId + appToken`;
  }
  return `未知表: ${given}。未配置别名，请直接传 tableId + appToken`;
}

// ============================================================
// Tool: feishu_read_records
// ============================================================
async function readRecords(args) {
  const table = resolveTableRef(args.table, args.appToken);
  if (!table) {
    return { content: [{ type: 'text', text: unknownTableMessage(args.table) }], isError: true };
  }

  const params = { page_size: args.pageSize ?? 50 };
  if (args.filter) params.filter = args.filter;

  log('feishu_read_records', { appToken: table.appToken.slice(0, 8) + '...', tableId: table.tableId });

  let res = await client.bitable.appTableRecord.list({
    path: { app_token: table.appToken, table_id: table.tableId },
    params,
  });

  let filterDropped = false;
  if ((!res || res.code !== 0) && args.filter) {
    log('feishu_read_records filter failed, retrying without filter', { code: res?.code, filter: args.filter });
    res = await client.bitable.appTableRecord.list({
      path: { app_token: table.appToken, table_id: table.tableId },
      params: { page_size: args.pageSize ?? 50 },
    });
    filterDropped = true;
  }

  if (!res || res.code !== 0) {
    return {
      content: [{ type: 'text', text: `查询失败: code=${res?.code}, msg=${res?.msg}` }],
      isError: true,
    };
  }

  const items = res.data?.items ?? [];
  const hasMore = res.data?.has_more ?? false;
  const total = res.data?.total ?? items.length;

  const records = items.map((item) => ({
    recordId: item.record_id,
    ...item.fields,
  }));

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ total, hasMore, records, filterDropped }, null, 2),
    }],
  };
}

// ============================================================
// Tool: feishu_create_record
// ============================================================
async function createRecord(args) {
  const table = resolveTableRef(args.table, args.appToken);
  if (!table) {
    return { content: [{ type: 'text', text: unknownTableMessage(args.table) }], isError: true };
  }

  // Dynamically fetch field metadata (including options) for type-adaptation
  let fieldMetaList = [];
  try {
    fieldMetaList = await fetchFieldMap(table.appToken, table.tableId);
  } catch (err) {
    log('createRecord: field fetch failed, will proceed without type adaptation', { error: err.message });
    // Non-fatal: create can still succeed if values are already in correct format
  }

  const record = toFeishuRecord(args.fields, fieldMetaList);
  log('feishu_create_record', { appToken: table.appToken.slice(0, 8) + '...', tableId: table.tableId });

  const res = await client.bitable.appTableRecord.create({
    path: { app_token: table.appToken, table_id: table.tableId },
    data: { fields: record },
  });

  if (!res || res.code !== 0) {
    return {
      content: [{ type: 'text', text: `创建失败: code=${res?.code}, msg=${res?.msg}` }],
      isError: true,
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ok: true, recordId: res.data?.record?.record_id, fields: res.data?.record?.fields }, null, 2),
    }],
  };
}

// ============================================================
// Tool: feishu_update_record
// ============================================================
async function updateRecord(args) {
  const table = resolveTableRef(args.table, args.appToken);
  if (!table) {
    return { content: [{ type: 'text', text: unknownTableMessage(args.table) }], isError: true };
  }
  if (!args.recordId) {
    return { content: [{ type: 'text', text: '缺少 recordId 参数' }], isError: true };
  }

  // Dynamically fetch field metadata for type-adaptation
  let fieldMetaList = [];
  try {
    fieldMetaList = await fetchFieldMap(table.appToken, table.tableId);
  } catch (err) {
    log('updateRecord: field fetch failed, will proceed without type adaptation', { error: err.message });
  }

  const record = toFeishuRecord(args.fields, fieldMetaList);
  log('feishu_update_record', { appToken: table.appToken.slice(0, 8) + '...', tableId: table.tableId, recordId: args.recordId });

  const res = await client.bitable.appTableRecord.update({
    path: { app_token: table.appToken, table_id: table.tableId, record_id: args.recordId },
    data: { fields: record },
  });

  if (!res || res.code !== 0) {
    return {
      content: [{ type: 'text', text: `更新失败: code=${res?.code}, msg=${res?.msg}` }],
      isError: true,
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ok: true, recordId: res.data?.record?.record_id, fields: res.data?.record?.fields }, null, 2),
    }],
  };
}

// ============================================================
// Tool: feishu_get_table_fields
// ============================================================
async function getTableFields(args) {
  const table = resolveTableRef(args.table, args.appToken);
  if (!table) {
    return { content: [{ type: 'text', text: unknownTableMessage(args.table) }], isError: true };
  }

  log('feishu_get_table_fields', { appToken: table.appToken.slice(0, 8) + '...', tableId: table.tableId });

  try {
    const fields = await fetchFieldMap(table.appToken, table.tableId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          appToken: table.appToken,
          tableId: table.tableId,
          name: table.name,
          total: fields.length,
          fields,
        }, null, 2),
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `获取字段异常: ${err.message}` }],
      isError: true,
    };
  }
}

// ============================================================
// Tool: feishu_send_text
// ============================================================
async function sendText(args) {
  const receiveId = args.receiveId || config.defaultChatId;
  if (!receiveId) {
    return { content: [{ type: 'text', text: '缺少 receiveId 参数' }], isError: true };
  }

  const receiveIdType = receiveId.startsWith('ou_') ? 'open_id' : 'chat_id';
  log('feishu_send_text', { receiveIdType });

  const res = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text: args.text }),
    },
  });

  if (!res || res.code !== 0) {
    return {
      content: [{ type: 'text', text: `发送失败: code=${res?.code}, msg=${res?.msg}` }],
      isError: true,
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ok: true, messageId: res.data?.message_id }, null, 2),
    }],
  };
}

// ============================================================
// Tool: feishu_send_card
// ============================================================
async function sendCard(args) {
  if (!args.cardJson) {
    return { content: [{ type: 'text', text: '缺少 cardJson 参数' }], isError: true };
  }

  const receiveId = args.chatId || args.receiveId || config.defaultChatId;
  if (!receiveId) {
    return { content: [{ type: 'text', text: '缺少 chatId 或 receiveId 参数' }], isError: true };
  }

  let card;
  try {
    card = typeof args.cardJson === 'string' ? JSON.parse(args.cardJson) : args.cardJson;
  } catch {
    return { content: [{ type: 'text', text: 'cardJson 不是有效的 JSON' }], isError: true };
  }

  const receiveIdType = receiveId.startsWith('ou_') ? 'open_id' : 'chat_id';
  log('feishu_send_card', { receiveIdType });

  const res = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  });

  if (!res || res.code !== 0) {
    return {
      content: [{ type: 'text', text: `发送卡片失败: code=${res?.code}, msg=${res?.msg}` }],
      isError: true,
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ok: true, messageId: res.data?.message_id }, null, 2),
    }],
  };
}

// ============================================================
// Tool: feishu_delete_message
// ============================================================
async function deleteMessage(args) {
  if (!args.messageId) {
    return { content: [{ type: 'text', text: '缺少 messageId 参数' }], isError: true };
  }

  log('feishu_delete_message', { messageId: args.messageId });

  const res = await client.im.message.delete({
    path: { message_id: args.messageId },
  });

  if (!res || res.code !== 0) {
    return {
      content: [{ type: 'text', text: `删除失败: code=${res?.code}, msg=${res?.msg}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }],
  };
}

// ============================================================
// Tool: feishu_read_doc / feishu_list_doc_blocks / feishu_batch_update_blocks
// ============================================================

// 换取 tenant_access_token（tools.js 内部自用——文档类 API 不经过 feishu-table-map）
let _cachedToken = null;
let _tokenExpireAt = 0;
async function getTenantToken() {
  if (_cachedToken && Date.now() < _tokenExpireAt) return _cachedToken;
  const res = await (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: config.feishuAppId, app_secret: config.feishuAppSecret }),
  })).json();
  if (res?.code === 0 && res.tenant_access_token) {
    _cachedToken = res.tenant_access_token;
    _tokenExpireAt = Date.now() + (res.expire - 60) * 1000;
    return _cachedToken;
  }
  throw new Error(`换 token 失败: ${res?.msg}`);
}

async function resolveDocToken(input) {
  if (!input) return null;

  let wikiToken = null;
  const urlMatch = input.match(/wiki\/([A-Za-z0-9_-]+)/);
  if (urlMatch) wikiToken = urlMatch[1];
  if (!wikiToken && !/^docx/i.test(input) && /^[A-Za-z0-9_-]{15,}$/.test(input)) {
    wikiToken = input;
  }

  if (wikiToken) {
    try {
      const token = await getTenantToken();
      const res = await (await fetch(
        `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(wikiToken)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )).json();
      if (res?.code === 0 && res.data?.node?.obj_token) {
        return { docToken: res.data.node.obj_token, objType: res.data.node.obj_type, title: res.data.node.title };
      }
    } catch { /* fall through */ }
  }

  return { docToken: input, objType: null, title: null };
}

async function readDoc(args) {
  if (!args.docToken) {
    return { content: [{ type: 'text', text: '缺少 docToken 参数' }], isError: true };
  }

  log('feishu_read_doc', { docToken: args.docToken });

  const resolved = await resolveDocToken(args.docToken);
  if (!resolved?.docToken) {
    return { content: [{ type: 'text', text: '无法解析文档 token' }], isError: true };
  }

  const res = await client.docx.document.get({
    path: { document_id: resolved.docToken },
  });

  if (!res || res.code !== 0) {
    return {
      content: [{ type: 'text', text: `读取文档失败: code=${res?.code}, msg=${res?.msg}` }],
      isError: true,
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ...res.data, _title: resolved.title }, null, 2),
    }],
  };
}

async function listDocBlocks(args) {
  if (!args.documentId) {
    return { content: [{ type: 'text', text: '缺少 documentId 参数' }], isError: true };
  }

  log('feishu_list_doc_blocks', { documentId: args.documentId });

  const resolved = await resolveDocToken(args.documentId);
  if (!resolved?.docToken) {
    return { content: [{ type: 'text', text: '无法解析文档 token' }], isError: true };
  }

  const params = { page_size: args.pageSize ?? 500 };
  if (args.pageToken) params.page_token = args.pageToken;

  const res = await client.docx.documentBlock.list({
    path: { document_id: resolved.docToken },
    params,
  });

  if (!res || res.code !== 0) {
    return {
      content: [{ type: 'text', text: `读取文档块失败: code=${res?.code}, msg=${res?.msg}` }],
      isError: true,
    };
  }

  const blocks = res.data?.items ?? [];
  const hasMore = res.data?.has_more ?? false;
  const pageToken = res.data?.page_token;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ hasMore, pageToken, total: blocks.length, blocks }, null, 2),
    }],
  };
}

async function batchUpdateBlocks(args) {
  if (!args.documentId) {
    return { content: [{ type: 'text', text: '缺少 documentId 参数' }], isError: true };
  }
  if (!args.requests || !Array.isArray(args.requests)) {
    return { content: [{ type: 'text', text: '缺少 requests 参数（数组）' }], isError: true };
  }

  log('feishu_batch_update_blocks', { documentId: args.documentId, count: args.requests.length });

  const resolved = await resolveDocToken(args.documentId);
  if (!resolved?.docToken) {
    return { content: [{ type: 'text', text: '无法解析文档 token' }], isError: true };
  }

  const res = await client.docx.documentBlock.batchUpdate({
    path: { document_id: resolved.docToken },
    data: { requests: args.requests },
  });

  if (!res || res.code !== 0) {
    return {
      content: [{ type: 'text', text: `批量更新文档块失败: code=${res?.code}, msg=${res?.msg}` }],
      isError: true,
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ok: true, count: args.requests.length }, null, 2),
    }],
  };
}

// ============================================================
// Tool: feishu_resolve_wiki_node
// ============================================================
async function resolveWikiNode(args) {
  if (!args.wikiToken) {
    return { content: [{ type: 'text', text: '缺少 wikiToken 参数' }], isError: true };
  }

  log('feishu_resolve_wiki_node', { wikiToken: args.wikiToken });

  let token = args.wikiToken;
  const urlMatch = token.match(/wiki\/([A-Za-z0-9_-]+)/);
  if (urlMatch) token = urlMatch[1];

  try {
    const tenantToken = await getTenantToken();
    const res = await (await fetch(
      `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`,
      { headers: { Authorization: `Bearer ${tenantToken}` } },
    )).json();

    if (res?.code === 0 && res.data?.node) {
      const node = res.data.node;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            nodeToken: node.node_token,
            nodeType: node.node_type,
            objType: node.obj_type,
            objToken: node.obj_token,
            appToken: node.obj_type === 'bitable' ? node.obj_token : undefined,
            spaceId: node.space_id,
            title: node.title,
            hasChild: node.has_child,
          }, null, 2),
        }],
      };
    }

    return {
      content: [{ type: 'text', text: `解析 wiki 节点失败: code=${res?.code}, msg=${res?.msg}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `解析 wiki 节点异常: ${err.message}` }],
      isError: true,
    };
  }
}

// ============================================================
// Tool definitions
// ============================================================
import * as z from 'zod/v4';

export const TOOL_DEFINITIONS = [
  {
    name: 'feishu_read_records',
    description: '从飞书多维表格读取记录。table 可传别名 "delay"/"completion_rate"，也可直接传原始 tableId（需配合 appToken 传多维表格 appToken）。可选 filter（飞书公式过滤）和 pageSize。',
    schema: z.object({
      table: z.string().describe('表名别名（delay/completion_rate）或原始 tableId'),
      appToken: z.string().optional().describe('多维表格 appToken，仅当 table 传原始 tableId 时必填'),
      filter: z.string().optional().describe('飞书公式过滤条件，如 CURRENTROW()!="". 可选。'),
      pageSize: z.number().optional().describe('每页条数，默认 50'),
    }),
    handler: (args) => safeHandler('feishu_read_records', readRecords, args),
  },
  {
    name: 'feishu_create_record',
    description: '在飞书多维表格中新建一条记录。table 可传别名 "delay"/"completion_rate"，或原始 tableId（配合 appToken）。fields 用中文字段名（如 { "延期任务描述":"xxx", "进度":"开发中" }），单选/多选字段可传中文标签名，系统自动从飞书 API 动态解析为 option_id。',
    schema: z.object({
      table: z.string().describe('表名别名（delay/completion_rate）或原始 tableId'),
      appToken: z.string().optional().describe('多维表格 appToken，仅当 table 传原始 tableId 时必填'),
      fields: z.object({}).passthrough().describe('字段名→值的映射，用中文字段名'),
    }),
    handler: (args) => safeHandler('feishu_create_record', createRecord, args),
  },
  {
    name: 'feishu_get_table_fields',
    description: '获取飞书多维表格的字段元数据（fieldName/fieldId/type/uiType，含单选/多选字段的完整 options 列表）。table 可传别名 "delay"/"completion_rate"，或原始 tableId（配合 appToken）。用于在写入前确认真实字段名、类型和可选值。',
    schema: z.object({
      table: z.string().describe('表名别名（delay/completion_rate）或原始 tableId'),
      appToken: z.string().optional().describe('多维表格 appToken，仅当 table 传原始 tableId 时必填'),
    }),
    handler: (args) => safeHandler('feishu_get_table_fields', getTableFields, args),
  },
  {
    name: 'feishu_update_record',
    description: '更新飞书多维表格中的一条记录。需传 recordId（从 read_records 获取）。table 可传别名或原始 tableId（配合 appToken）。fields 格式同 create，单选/多选字段可传中文标签名自动解析。',
    schema: z.object({
      table: z.string().describe('表名别名（delay/completion_rate）或原始 tableId'),
      appToken: z.string().optional().describe('多维表格 appToken，仅当 table 传原始 tableId 时必填'),
      recordId: z.string().describe('记录 ID（从 feishu_read_records 结果的 recordId 字段获取）'),
      fields: z.object({}).passthrough().describe('要更新的字段名→值'),
    }),
    handler: (args) => safeHandler('feishu_update_record', updateRecord, args),
  },
  {
    name: 'feishu_send_text',
    description: '通过飞书机器人发送文本消息。receiveId 可省略——不传时会自动发送到桥接器配置的默认群聊（当前对话所在的 chat），无需 open_id。需要定向发送时才传 open_id（ou_xxx）或 chat_id（oc_xxx）。',
    schema: z.object({
      receiveId: z.string().optional().describe('可选。不传自动发到默认群聊。接收方 ID：open_id (ou_xxx) 或 chat_id (oc_xxx)'),
      text: z.string().describe('要发送的文本内容'),
    }),
    handler: (args) => safeHandler('feishu_send_text', sendText, args),
  },
  {
    name: 'feishu_send_card',
    description: '通过飞书机器人发送交互式卡片消息。chatId/receiveId 均可省略——不传时会自动发送到桥接器配置的默认群聊（当前对话所在的 chat），无需 open_id。需要定向发送时才传。',
    schema: z.object({
      chatId: z.string().optional().describe('可选。不传自动发到默认群聊。接收群/人 ID（chat_id 或 open_id）'),
      receiveId: z.string().optional().describe('同 chatId，二选一'),
      cardJson: z.unknown().describe('飞书卡片 JSON 对象或 JSON 字符串'),
    }),
    handler: (args) => safeHandler('feishu_send_card', sendCard, args),
  },
  {
    name: 'feishu_delete_message',
    description: '撤回/删除飞书消息。messageId 传 om_xxx 消息 ID。',
    schema: z.object({
      messageId: z.string().describe('要删除的消息 ID (om_xxx)'),
    }),
    handler: (args) => safeHandler('feishu_delete_message', deleteMessage, args),
  },
  {
    name: 'feishu_read_doc',
    description: '读取飞书文档内容。docToken 传文档 ID 或 URL 中包含的 token。',
    schema: z.object({
      docToken: z.string().describe('文档 token 或文档 URL'),
    }),
    handler: (args) => safeHandler('feishu_read_doc', readDoc, args),
  },
  {
    name: 'feishu_resolve_wiki_node',
    description: '解析飞书知识库/wiki 节点。传入 wiki URL 或 wiki token，返回 wiki 下的节点列表（包括多维表格的 appToken）。',
    schema: z.object({
      wikiToken: z.string().describe('Wiki URL 或 wiki token'),
    }),
    handler: (args) => safeHandler('feishu_resolve_wiki_node', resolveWikiNode, args),
  },
  {
    name: 'feishu_list_doc_blocks',
    description: '读取飞书文档块列表（含正文内容、样式、Jira链接等）。documentId 传文档 token。返回块级文本（text_elements）、块样式（bgColor、strikethrough）和子块。',
    schema: z.object({
      documentId: z.string().describe('文档 token，如 APXgwm4O1i7Pcok8nT4cER0vnNh'),
      pageSize: z.number().optional().describe('每页条数，默认 500'),
      pageToken: z.string().optional().describe('分页 token，从上次响应获取'),
    }),
    handler: (args) => safeHandler('feishu_list_doc_blocks', listDocBlocks, args),
  },
  {
    name: 'feishu_batch_update_blocks',
    description: '批量更新飞书文档块（标红/修改样式等）。documentId 传文档 token。requests 为 update block request 数组。',
    schema: z.object({
      documentId: z.string().describe('文档 token'),
      requests: z.array(z.object({}).passthrough()).describe('批量更新请求数组，每个元素含 block_id 和操作'),
    }),
    handler: (args) => safeHandler('feishu_batch_update_blocks', batchUpdateBlocks, args),
  },
];

export default TOOL_DEFINITIONS;