// feishu-table-map.js — 飞书多维表格坐标映射 + 字段元数据动态缓存
//
// table-map.json 极简版：只存 alias → {appToken, tableId}，不再存 fields/options。
// 字段元数据（包括单选/多选的 option_id ↔ name 映射）全部从飞书 API 动态获取，内存缓存。
//
// 入口：
//   resolveTableRef(table, explicitAppToken) → { appToken, tableId, name } | null
//   fetchFieldMap(appToken, tableId) → [fieldMeta, ...] （含 options）
//   toFeishuRecord(fields, fieldMetaList) → Feishu API record

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const TABLE_MAP_PATH = join(ROOT, 'config', 'table-map.json');

// ---- 加载 table-map.json（极简版） ----
// 结构：{ "tables": { "alias": { "appToken": "...", "tableId": "..." } } }
function loadMap() {
  if (!existsSync(TABLE_MAP_PATH)) {
    console.error(`[feishu-table-map] 未找到 ${TABLE_MAP_PATH}。别名不可用，请直接传 tableId + appToken。`);
    return { tables: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(TABLE_MAP_PATH, 'utf8').replace(/^﻿/, ''));
    const tables = raw?.tables;
    if (!tables || typeof tables !== 'object' || Object.keys(tables).length === 0) {
      console.error(`[feishu-table-map] ${TABLE_MAP_PATH} 中 tables 为空。`);
      return { tables: {} };
    }
    console.error(`[feishu-table-map] loaded ${Object.keys(tables).length} table aliases: ${Object.keys(tables).join(', ')}`);
    return { tables };
  } catch (err) {
    console.error(`[feishu-table-map] 无法解析 ${TABLE_MAP_PATH}: ${err.message}`);
    return { tables: {} };
  }
}

const MAP = loadMap();
export const TABLES = MAP.tables;

// ---- 字段元数据缓存 ----
// key = `${appToken}:${tableId}`, TTL = session lifetime（不主动过期）
const fieldCache = new Map();

// ---- Token 助手（MCP 子进程没有 SDK client，裸 token 调 API） ----
let _cachedToken = null;
let _tokenExpireAt = 0;

async function getTenantToken() {
  if (_cachedToken && Date.now() < _tokenExpireAt) return _cachedToken;
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID / FEISHU_APP_SECRET 未设置（MCP env block 是否缺少凭据？）');
  }
  const res = await (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })).json();
  if (res?.code === 0 && res.tenant_access_token) {
    _cachedToken = res.tenant_access_token;
    _tokenExpireAt = Date.now() + (res.expire - 60) * 1000;
    return _cachedToken;
  }
  throw new Error(`换取 tenant_access_token 失败: code=${res?.code}, msg=${res?.msg}`);
}

// 从飞书 API 拉取字段元数据并缓存。
// 返回的每个字段对象包含 fieldName / fieldId / type / uiType / isPrimary，
// 对于单选/多选字段额外带 options[{id, name, color}] 和 _optionNameMap（name→id 快速查）。
export async function fetchFieldMap(appToken, tableId) {
  const cacheKey = `${appToken}:${tableId}`;
  if (fieldCache.has(cacheKey)) {
    return fieldCache.get(cacheKey).fields;
  }

  const token = await getTenantToken();
  const res = await (await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
    { headers: { Authorization: `Bearer ${token}` } },
  )).json();

  if (res?.code !== 0) {
    throw new Error(`获取字段元数据失败: code=${res.code}, msg=${res.msg}`);
  }

  const fields = (res.data?.items ?? []).map((f) => {
    const meta = {
      fieldName: f.field_name,
      fieldId: f.field_id,
      type: f.type,
      uiType: f.ui_type,
      isPrimary: f.is_primary,
    };
    // 单选/多选：展开选项列表，同时构建 name→id 反向映射
    const options = f.property?.options;
    if (Array.isArray(options) && options.length > 0) {
      meta.options = options.map((o) => ({ id: o.id, name: o.name, color: o.color }));
      meta._optionNameMap = Object.fromEntries(options.map((o) => [o.name, o.id]));
    }
    return meta;
  });

  fieldCache.set(cacheKey, { fields, fetchedAt: Date.now() });
  return fields;
}

// ---- resolveTableRef ----
// 给定 table 参数（别名或原始 tableId），返回 { appToken, tableId, name }。
// table-map.json 缺失时，别名不可用但仍支持显式传 appToken + tableId。
export function resolveTableRef(table, explicitAppToken) {
  if (!table) return null;

  // 1) 别名命中
  if (TABLES[table]) {
    const t = TABLES[table];
    return { appToken: t.appToken, tableId: t.tableId, name: t.name ?? table };
  }

  // 2) tableId 反查（支持传 tableId 不传 appToken 也能自动找到对应的 appToken）
  for (const alias of Object.keys(TABLES)) {
    if (TABLES[alias].tableId === table) {
      const t = TABLES[alias];
      return { appToken: t.appToken, tableId: t.tableId, name: t.name ?? alias };
    }
  }

  // 3) 显式 appToken + 看起来像 tableId → 直连
  if (explicitAppToken && /^[A-Za-z0-9_-]{16,64}$/.test(table)) {
    return { appToken: explicitAppToken, tableId: table, name: table };
  }

  return null;
}

// ---- toFeishuRecord ----
// 把 { 中文字段名: value } → 飞书 API record。
// fieldMetaList 来自 fetchFieldMap()。
// key 固定用 field_name（中文字段名），不做 field_id 转换。
// value 按字段 type 做类型适配：单选/多选自动解析选项名→option_id，user 包装为 {id:...}，number/date 类型转换。
export function toFeishuRecord(fields, fieldMetaList) {
  const record = {};
  if (!fields) return record;

  // 构建 fieldName → meta 快速索引
  const metaByName = {};
  if (fieldMetaList) {
    for (const f of fieldMetaList) {
      metaByName[f.fieldName] = f;
    }
  }

  for (const [fieldName, value] of Object.entries(fields)) {
    const meta = metaByName[fieldName];
    record[fieldName] = adaptFieldValue(fieldName, value, meta);
  }
  return record;
}

function adaptFieldValue(_fieldName, rawValue, meta) {
  if (!meta) return rawValue; // 未知字段原样透传

  switch (meta.type) {
    case 'single_select': {
      // 用户可能传 option_id（opt_xxx）或中文标签名 → 智能解析
      if (typeof rawValue === 'string' && meta._optionNameMap?.[rawValue]) {
        return meta._optionNameMap[rawValue];
      }
      return rawValue;
    }
    case 'multi_select': {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      return values.map((v) => {
        if (typeof v === 'string' && meta._optionNameMap?.[v]) {
          return meta._optionNameMap[v];
        }
        return v;
      });
    }
    case 'user': {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      return values.map((v) => (typeof v === 'object' ? v : { id: v }));
    }
    case 'number': {
      if (typeof rawValue === 'number') return rawValue;
      if (typeof rawValue === 'string' && rawValue.trim() !== '') {
        const n = Number(rawValue.trim());
        if (!Number.isNaN(n)) return n;
      }
      return rawValue;
    }
    case 'date':
    case 'datetime': {
      if (typeof rawValue === 'number') return rawValue;
      if (typeof rawValue === 'string' && rawValue.trim() !== '') {
        const str = rawValue.trim().replace(/\//g, '-');
        const m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) {
          const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
          if (!Number.isNaN(dt.getTime())) return dt.getTime();
        }
        return rawValue;
      }
      return rawValue;
    }
    default:
      return rawValue;
  }
}

export default { TABLES, resolveTableRef, fetchFieldMap, toFeishuRecord };