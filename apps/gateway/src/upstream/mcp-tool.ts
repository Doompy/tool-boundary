import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ToolBoundaryError, type ToolDefinition } from '@tool-boundary/core';
import type { LoadedConfig } from '@tool-boundary/config';

export async function executeMcpToolTarget(config: LoadedConfig, tool: ToolDefinition, input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  if (tool.target.type !== 'mcp') {
    throw new ToolBoundaryError('CONFIG_INVALID', 'Tool target is not MCP');
  }
  const target = tool.target;

  const upstream = config.mcp.upstreams[target.upstream];
  if (upstream === undefined) {
    throw new ToolBoundaryError('CONFIG_INVALID', `MCP upstream ${target.upstream} was not found`, {
      publicDetails: { upstream: target.upstream }
    });
  }
  if (upstream.transport !== 'stdio') {
    throw new ToolBoundaryError('CONFIG_INVALID', `Unsupported MCP upstream transport ${upstream.transport}`, {
      publicDetails: { upstream: target.upstream }
    });
  }

  const upstreamEnv = resolveUpstreamEnv(upstream.env, upstream.envFrom, env, target.upstream);
  const transport = new StdioClientTransport({
    command: upstream.command,
    args: upstream.args,
    cwd: upstream.cwd === undefined ? config.configDir : resolve(config.configDir, upstream.cwd),
    env: upstreamEnv,
    stderr: 'pipe'
  });
  const client = new Client({ name: 'tool-boundary-mcp-upstream', version: '0.2.1' });
  const timeout = target.timeoutMs ?? 10_000;

  try {
    await client.connect(transport, { timeout });
    const tools = await client.listTools({}, { timeout });
    if (!tools.tools.some((candidate) => candidate.name === target.toolName)) {
      throw new ToolBoundaryError('TOOL_UPSTREAM_ERROR', `MCP upstream tool ${target.toolName} was not found`, {
        publicDetails: { upstream: target.upstream, toolName: target.toolName }
      });
    }

    const result = await client.callTool(
      {
        name: target.toolName,
        arguments: mcpArguments(input)
      },
      undefined,
      { timeout }
    );
    if ('toolResult' in result) return result.toolResult;
    if (result.isError === true) {
      throw new ToolBoundaryError('TOOL_UPSTREAM_ERROR', `MCP upstream tool ${target.toolName} returned an error`, {
        details: { content: result.content },
        publicDetails: { upstream: target.upstream, toolName: target.toolName }
      });
    }
    return result.structuredContent ?? result.content;
  } catch (error) {
    if (error instanceof ToolBoundaryError) throw error;
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
      throw new ToolBoundaryError('TOOL_UPSTREAM_TIMEOUT', 'MCP upstream request timed out', {
        publicDetails: { upstream: target.upstream, toolName: target.toolName },
        statusCode: 504
      });
    }
    throw new ToolBoundaryError('TOOL_UPSTREAM_ERROR', 'MCP upstream request failed', {
      details: safeErrorMessage(error),
      publicDetails: { upstream: target.upstream, toolName: target.toolName },
      statusCode: 502
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

function resolveUpstreamEnv(
  explicitEnv: Readonly<Record<string, string>> | undefined,
  envFrom: Readonly<Record<string, string>> | undefined,
  env: NodeJS.ProcessEnv,
  upstreamName: string
): Record<string, string> {
  const resolved = {
    ...getDefaultEnvironment(),
    ...(explicitEnv ?? {})
  };
  for (const [targetEnv, sourceEnv] of Object.entries(envFrom ?? {})) {
    const value = env[sourceEnv];
    if (value === undefined || value.length === 0) {
      throw new ToolBoundaryError('CONFIG_INVALID', `Missing env ${sourceEnv} for MCP upstream ${upstreamName}`, {
        publicDetails: { upstream: upstreamName, env: sourceEnv }
      });
    }
    resolved[targetEnv] = value;
  }
  return resolved;
}

function mcpArguments(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) return input as Record<string, unknown>;
  return { input };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown MCP upstream error';
}
