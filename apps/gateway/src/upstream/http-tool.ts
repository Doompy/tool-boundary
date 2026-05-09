import { ToolBoundaryError, type ToolDefinition } from '@tool-boundary/core';

export async function executeToolTarget(tool: ToolDefinition, input: unknown): Promise<unknown> {
  if (tool.target.type === 'mock') return tool.target.result;
  if (tool.target.type !== 'http') {
    throw new ToolBoundaryError('CONFIG_INVALID', 'Unsupported target type');
  }
  if (tool.target.method !== 'POST') {
    throw new ToolBoundaryError('CONFIG_INVALID', 'MVP only supports HTTP POST upstream targets');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), tool.target.timeoutMs ?? 10_000);
  try {
    const response = await fetch(tool.target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(tool.target.headers ?? {})
      },
      body: JSON.stringify(input ?? {}),
      signal: controller.signal
    });
    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw new ToolBoundaryError('TOOL_UPSTREAM_ERROR', `Upstream returned ${response.status}`, {
        details: { statusCode: response.status },
        statusCode: 502
      });
    }
    return body;
  } catch (error) {
    if (error instanceof ToolBoundaryError) throw error;
    if (isAbortError(error)) {
      throw new ToolBoundaryError('TOOL_UPSTREAM_TIMEOUT', 'Upstream request timed out', { statusCode: 504 });
    }
    throw new ToolBoundaryError('TOOL_UPSTREAM_ERROR', 'Upstream request failed', { details: safeErrorMessage(error), statusCode: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown upstream error';
}
