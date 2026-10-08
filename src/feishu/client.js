// client.js — Feishu SDK Client + WSClient construction
import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';

// MCP 子进程（src/mcp/server.js）由 Claude Code 拉起时，cwd 不一定是项目根目录，
// config.js 读 .env 会失败 → 机器人的 tenant_access_token 拿不到 → 退化成无身份调用
// → 报「用户无权限」。兜底：优先用宿主机通过 env 注入的凭据（setup.ps1 负责注入），
// 否则回退到 config（项目根 .env），最后回退到 process.env。
function resolveCredential(configVal, envKey) {
  if (configVal) return configVal;
  return process.env[envKey] ?? '';
}

export const baseConfig = {
  appId: resolveCredential(config.feishuAppId, 'FEISHU_APP_ID'),
  appSecret: resolveCredential(config.feishuAppSecret, 'FEISHU_APP_SECRET'),
};

if (!baseConfig.appId || !baseConfig.appSecret) {
  logger.error('feishu credentials missing', {
    hasAppId: Boolean(baseConfig.appId),
    hasAppSecret: Boolean(baseConfig.appSecret),
  });
}

// For HTTP reply operations
export const client = new Lark.Client(baseConfig);

// 下载消息里的资源文件（文本/图片等），返回文件内容 Buffer。
// 正确的 SDK 路径是 client.im.messageResource.get（顶层，与 message 平级），
// 返回 { writeFile, getReadableStream, headers }。
export async function downloadResource(messageId, fileKey, type = 'file') {
  try {
    const res = await client.im.messageResource.get({
      params: { type },
      path: { message_id: messageId, file_key: fileKey },
    });

    // 通过 getReadableStream 读成 Buffer
    const stream = res.getReadableStream();
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (err) {
    logger.error('download resource failed', { messageId, fileKey, type, error: err.message });
    throw err;
  }
}

// 获取指定消息的内容(用于「回复/引用」场景拉被引用的原文,以及合并转发子消息)。
// 返回 SDK 原始响应;对 merge_forward 消息,data.items[] 包含父+子消息树。
export async function fetchMessage(messageId) {
  try {
    const res = await client.im.v1.message.get({
      path: { message_id: messageId },
      // with_sender_name=true 让每个 item 的 sender 带 sender_name/sender_i18n_names
      // 真实姓名，这是合并转发里显示「@姓名」的唯一正确来源（无需 contact 权限）。
      params: { with_sender_name: true },
    });
    return res?.data ?? null;
  } catch (err) {
    logger.error('fetch message failed', { messageId, error: err.message });
    return null;
  }
}

// 拉取合并转发消息的子消息平铺列表(items),供调用方按 upper_message_id 拼树。
export async function fetchMergeForwardItems(messageId) {
  const data = await fetchMessage(messageId);
  if (!data) return [];
  // 合并转发消息: data.items[] 里父消息在前(无 upper_message_id),子消息在后。
  return Array.isArray(data.items) ? data.items : [];
}

// Start the WebSocket long-connection event stream.
// onMessage(data) is called for every received event and MUST return
// quickly (the handler contract requires <3s). The bridge only enqueues here.
export function startEventStream(onMessage) {
  const wsClient = new Lark.WSClient({
    ...baseConfig,
    loggerLevel: Lark.LoggerLevel.info,
    autoReconnect: true,
  });

  // Log connection state changes
  try {
    wsClient.on?.('reconnect', () => logger.info('feishu ws reconnected'));
  } catch { /* callback surface may vary between SDK versions */ }

  wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        // Never await long work here — just forward to the normalized handler
        try {
          onMessage(data);
        } catch (err) {
          logger.error('event handler crashed', { error: err.message });
        }
      },
    }),
  });

  return wsClient;
}

export default client;