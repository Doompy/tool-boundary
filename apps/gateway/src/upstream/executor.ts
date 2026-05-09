import { type ToolDefinition } from '@tool-boundary/core';
import type { LoadedConfig } from '@tool-boundary/config';
import { executeToolTarget } from './http-tool.js';
import { executeMcpToolTarget } from './mcp-tool.js';

export async function executeConfiguredToolTarget(config: LoadedConfig, tool: ToolDefinition, input: unknown): Promise<unknown> {
  if (tool.target.type === 'mcp') return executeMcpToolTarget(config, tool, input);
  return executeToolTarget(tool, input);
}
