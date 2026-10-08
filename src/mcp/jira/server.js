// jira server.js — JIRA MCP server (stdlib) with PAT Bearer auth
// Reads JIRA creds from env vars injected by the MCP config's env block.
// Never log to stdout.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const JIRA_BASE = process.env.JIRA_BASE_URL || 'https://jira.boomingtechs.cn';
const JIRA_PAT = process.env.JIRA_PAT;

if (!JIRA_PAT) {
  console.error('[jira-mcp] FATAL: JIRA_PAT environment variable is not set');
  process.exit(1);
}

function log(msg, data = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), msg, ...data }));
}

async function jiraGet(path) {
  const url = JIRA_BASE + path;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${JIRA_PAT}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function jiraPost(path, body) {
  const res = await fetch(JIRA_BASE + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${JIRA_PAT}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

function simplifyIssue(issue) {
  const f = issue.fields || {};
  return {
    key: issue.key,
    id: issue.id,
    summary: f.summary,
    status: f.status?.name,
    assignee: f.assignee?.displayName ?? null,
    actualExecutor: f.customfield_11911?.displayName ?? null,
    reporter: f.reporter?.displayName ?? null,
    priority: f.priority?.name ?? null,
    issuetype: f.issuetype?.name,
    created: f.created ? f.created.slice(0, 10) : null,
    updated: f.updated ? f.updated.slice(0, 10) : null,
    duedate: f.duedate ?? null,
    finishDate: f.customfield_11902 ?? null,
    labels: f.labels ?? [],
    project: f.project?.key,
    components: (f.components ?? []).map((c) => c.name),
    description: f.description ?? null,
  };
}

async function safeHandler(name, fn, args) {
  try {
    return await fn(args);
  } catch (err) {
    log(`jira tool error: ${name}`, { error: err.message });
    return { content: [{ type: 'text', text: `❌ JIRA 调用失败: ${err.message}` }], isError: true };
  }
}

// ---- tools ----

async function search(args) {
  const jql = encodeURIComponent(args.jql);
  const max = args.maxResults ?? 50;
  const res = await jiraGet(`/rest/api/2/search?jql=${jql}&maxResults=${max}${args.fields ? `&fields=${encodeURIComponent(args.fields)}` : ''}`);
  if (res.status !== 200) {
    return { content: [{ type: 'text', text: `JQL 查询失败 (${res.status}): ${JSON.stringify(res.data)}` }], isError: true };
  }
  const issues = (res.data.issues ?? []).map(simplifyIssue);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ total: res.data.total, returned: issues.length, issues }, null, 2),
    }],
  };
}

async function getIssue(args) {
  const key = encodeURIComponent(args.issueKey);
  const res = await jiraGet(`/rest/api/2/issue/${key}` + (args.expand ? `?expand=${encodeURIComponent(args.expand)}` : ''));
  if (res.status !== 200) {
    return { content: [{ type: 'text', text: `查询 issue 失败 (${res.status}): ${JSON.stringify(res.data)}` }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(simplifyIssue(res.data), null, 2) }] };
}

async function getChangelog(args) {
  const key = encodeURIComponent(args.issueKey);
  const res = await jiraGet(`/rest/api/2/issue/${key}?expand=changelog&fields=summary,status`);
  if (res.status !== 200) {
    return { content: [{ type: 'text', text: `查询变更记录失败 (${res.status}): ${JSON.stringify(res.data)}` }], isError: true };
  }
  const issue = res.data;
  const histories = issue.changelog?.histories ?? [];
  // Simplify: extract status changes and date transitions
  const changes = histories.flatMap((h) => (h.items ?? []).filter((it) => it.field === 'status').map((it) => ({
    created: h.created ? h.created.slice(0, 10) : null,
    author: h.author?.displayName ?? null,
    from: it.fromString,
    to: it.toString,
  })));
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        key: issue.key,
        summary: issue.fields?.summary,
        currentStatus: issue.fields?.status?.name,
        statusChanges: changes,
      }, null, 2),
    }],
  };
}

async function searchIssuesSimple(args) {
  // Convenience: search by free text + status
  const jql = [`summary ~ "${args.text}"`];
  if (args.status) jql.push(`status = "${args.status}"`);
  if (args.assignee) jql.push(`assignee = "${args.assignee}"`);
  return search({ jql: jql.join(' AND '), maxResults: args.maxResults ?? 50 });
}

async function getFields(args) {
  const res = await jiraGet('/rest/api/2/field');
  if (res.status !== 200) {
    return { content: [{ type: 'text', text: `查询字段失败: ${JSON.stringify(res.data)}` }], isError: true };
  }
  const fields = res.data.map((fld) => ({ id: fld.id, name: fld.name, custom: fld.custom }));
  return { content: [{ type: 'text', text: JSON.stringify(fields, null, 2) }] };
}

const server = new McpServer({ name: 'jira', version: '1.0.0' });

server.registerTool('jira_search', {
  description: '用 JQL 查询 Jira issues。返回简化的 key/summary/status/assignee 等字段。',
  inputSchema: z.object({
    jql: z.string().describe('JQL 查询语句，如 assignee=currentuser() AND status != Closed'),
    maxResults: z.number().optional().describe('最大返回条数，默认 50'),
  }),
}, (args) => safeHandler('jira_search', search, args));

server.registerTool('jira_get_issue', {
  description: '查询单个 Jira issue 详情，传 issue key（如 BMB-5311）。',
  inputSchema: z.object({
    issueKey: z.string().describe('issue key，如 BMB-5311'),
  }),
}, (args) => safeHandler('jira_get_issue', getIssue, args));

server.registerTool('jira_get_changelog', {
  description: '查询 issue 的状态变更记录（延期分析常用：从何时→何时状态变化）。',
  inputSchema: z.object({
    issueKey: z.string().describe('issue key'),
  }),
}, (args) => safeHandler('jira_get_changelog', getChangelog, args));

server.registerTool('jira_search_simple', {
  description: '免 JQL 的简单搜索：按关键词 + 可选状态/经办人查询。',
  inputSchema: z.object({
    text: z.string().describe('标题关键词'),
    status: z.string().optional().describe('状态过滤，如 In Progress'),
    assignee: z.string().optional().describe('经办人'),
    maxResults: z.number().optional(),
  }),
}, (args) => safeHandler('jira_search_simple', searchIssuesSimple, args));

server.registerTool('jira_get_fields', {
  description: '列出 Jira 所有可用字段的 id 和名称（自定义字段排查用）。',
  inputSchema: z.object({}),
}, (args) => safeHandler('jira_get_fields', getFields, args));

// connect
const transport = new StdioServerTransport();
await server.connect(transport);
log('jira mcp ready', { tools: '5' });