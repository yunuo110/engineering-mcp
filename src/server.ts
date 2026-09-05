import { McpServer } from '@modelcontextprotocol/server';
import { registerRoleTools, type ServerConfig } from './tools.ts';

export function createEngineeringServer(config: ServerConfig): McpServer {
  const server = new McpServer(
    {
      name: 'engineering-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: `Engineering MCP V1.6 coordination ledger. Process role: ${config.processRole}. Role is launch identity, not a tool argument.`,
    },
  );
  registerRoleTools(server, config);
  return server;
}
