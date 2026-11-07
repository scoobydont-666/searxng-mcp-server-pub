import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function createServer(): McpServer {
  return new McpServer({
    name: 'searxng-mcp',
    version: '0.2.0',
  });
}
