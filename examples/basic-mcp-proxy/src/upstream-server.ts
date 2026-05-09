import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'tool-boundary-basic-mcp-upstream', version: '0.1.0' },
  {
    capabilities: { tools: {} }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => ({
  tools: [
    {
      name: 'searchUsers',
      description: 'Search users by a text query.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        },
        required: ['query']
      }
    },
    {
      name: 'disableUser',
      description: 'Disable a user account.',
      inputSchema: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          reasonCode: { type: 'string' }
        },
        required: ['userId', 'reasonCode']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  if (request.params.name === 'searchUsers') {
    const query = readString(request.params.arguments, 'query');
    const output = {
      users: [
        {
          id: 'usr_123',
          email: 'ada@example.com',
          displayName: `Ada (${query})`
        }
      ]
    };
    return textJson(output);
  }

  if (request.params.name === 'disableUser') {
    const userId = readString(request.params.arguments, 'userId');
    const reasonCode = readString(request.params.arguments, 'reasonCode');
    const output = {
      disabled: true,
      userId,
      reasonCode
    };
    return textJson(output);
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool ${request.params.name}` }]
  };
});

await server.connect(new StdioServerTransport());

function textJson(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function readString(args: unknown, key: string): string {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return '';
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}
