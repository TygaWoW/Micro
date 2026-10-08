// server.js — Feishu MCP server (stdio transport)
// IMPORTANT: never call console.log — stdout is the JSON-RPC channel.
// All logging goes to stderr via console.error.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { TOOL_DEFINITIONS } from './tools.js';

const server = new McpServer({
  name: 'feishu',
  version: '1.0.0',
});

// Register all tools
for (const def of TOOL_DEFINITIONS) {
  server.registerTool(
    def.name,
    {
      description: def.description,
      inputSchema: def.schema,
    },
    def.handler,
  );
}

console.error(`[feishu-mcp] registering ${TOOL_DEFINITIONS.length} tools`);

// Connect via stdio (stdin/stdout)
const transport = new StdioServerTransport();
await server.connect(transport);

console.error('[feishu-mcp] server connected and ready');