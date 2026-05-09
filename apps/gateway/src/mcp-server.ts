import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult
} from '@modelcontextprotocol/sdk/types.js';
import { ToolBoundaryError, toToolBoundaryError, type ToolCallRequest, type ToolDefinition } from '@tool-boundary/core';
import type { LoadedConfig } from '@tool-boundary/config';
import { createRuntimeStores, type RuntimeStoreOverrides } from './runtime.js';
import { ToolCallService, type Principal } from './tool-call-service.js';

export type McpServerOptions = {
  readonly principal: Principal;
  readonly stores?: RuntimeStoreOverrides;
};

export function createMcpServer(config: LoadedConfig, options: McpServerOptions): Server {
  const stores = createRuntimeStores(config, options.stores);
  const service = new ToolCallService(config, stores);
  const server = new Server(
    { name: 'tool-boundary', version: '0.2.0' },
    {
      capabilities: {
        tools: {}
      },
      instructions: 'ToolBoundary exposes configured tools through the same approval, policy, audit, redaction, and idempotency boundary as the HTTP gateway.'
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => ({
    tools: Object.values(config.tools).map(mcpToolDefinition)
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const body = mcpArgumentsToToolCallRequest(request.params.arguments);
    const result = await service.callTool(request.params.name, body, options.principal);
    if (!result.ok) return mcpErrorResult(result.error);
    return mcpSuccessResult(result.result.output);
  });

  return server;
}

export async function startMcpServer(config: LoadedConfig, options: McpServerOptions): Promise<Server> {
  const server = createMcpServer(config, options);
  await server.connect(new StdioServerTransport());
  return server;
}

export function resolveMcpPrincipal(config: LoadedConfig, tokenEnv: string, env: NodeJS.ProcessEnv = process.env): Principal {
  const tokenValue = env[tokenEnv];
  if (tokenValue === undefined || tokenValue.length === 0) {
    throw new ToolBoundaryError('CONFIG_INVALID', `Missing MCP token env ${tokenEnv}`);
  }
  const token = config.auth.tokens.find((candidate) => candidate.token === tokenValue);
  if (token === undefined) {
    throw new ToolBoundaryError('UNAUTHORIZED', `MCP token env ${tokenEnv} does not match a configured static token`);
  }
  if (!token.scopes.includes('tools:call')) {
    throw new ToolBoundaryError('FORBIDDEN', 'MCP token requires tools:call scope');
  }
  return {
    name: token.name,
    scopes: token.scopes
  };
}

function mcpToolDefinition(tool: ToolDefinition): ListToolsResult['tools'][number] {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: mcpInputSchema(tool),
    annotations: {
      readOnlyHint: tool.mode === 'read',
      destructiveHint: tool.mode === 'mutate',
      idempotentHint: tool.idempotency?.required === true
    }
  };
}

function mcpInputSchema(tool: ToolDefinition): ListToolsResult['tools'][number]['inputSchema'] {
  return {
    type: 'object',
    properties: {
      input: schemaObject(tool.inputSchema),
      idempotencyKey: { type: 'string' },
      approvalToken: { type: 'string' }
    }
  };
}

function schemaObject(schema: unknown): Record<string, unknown> {
  return typeof schema === 'object' && schema !== null && !Array.isArray(schema) ? (schema as Record<string, unknown>) : {};
}

function mcpArgumentsToToolCallRequest(args: unknown): ToolCallRequest {
  const value = isRecord(args) ? args : {};
  return {
    input: value.input,
    hasInput: Object.hasOwn(value, 'input'),
    idempotencyKey: typeof value.idempotencyKey === 'string' ? value.idempotencyKey : undefined,
    approvalToken: typeof value.approvalToken === 'string' ? value.approvalToken : undefined
  };
}

function mcpSuccessResult(output: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(output)
      }
    ],
    structuredContent: isRecord(output) ? output : undefined
  };
}

function mcpErrorResult(error: ToolBoundaryError): CallToolResult {
  const normalized = toToolBoundaryError(error);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          code: normalized.code,
          message: normalized.message,
          details: normalized.publicDetails
        })
      }
    ]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
