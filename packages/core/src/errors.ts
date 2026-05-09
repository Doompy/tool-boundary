export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_SCHEMA_VALIDATION_FAILED'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_INVALID'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_ALREADY_CONSUMED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'TOOL_UPSTREAM_TIMEOUT'
  | 'TOOL_UPSTREAM_ERROR'
  | 'CONFIG_INVALID'
  | 'INTERNAL_ERROR';

export class ToolBoundaryError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly statusCode: number;

  constructor(code: ErrorCode, message: string, options: { readonly details?: unknown; readonly statusCode?: number } = {}) {
    super(message);
    this.name = 'ToolBoundaryError';
    this.code = code;
    this.details = options.details;
    this.statusCode = options.statusCode ?? defaultStatusCode(code);
  }
}

export function defaultStatusCode(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'TOOL_NOT_FOUND':
      return 404;
    case 'TOOL_SCHEMA_VALIDATION_FAILED':
    case 'APPROVAL_REQUIRED':
    case 'APPROVAL_INVALID':
    case 'APPROVAL_EXPIRED':
    case 'APPROVAL_ALREADY_CONSUMED':
    case 'IDEMPOTENCY_KEY_REQUIRED':
    case 'IDEMPOTENCY_CONFLICT':
    case 'CONFIG_INVALID':
      return 400;
    case 'POLICY_DENIED':
      return 403;
    case 'TOOL_UPSTREAM_TIMEOUT':
      return 504;
    case 'TOOL_UPSTREAM_ERROR':
      return 502;
    case 'INTERNAL_ERROR':
      return 500;
  }
}

export function toToolBoundaryError(error: unknown): ToolBoundaryError {
  if (error instanceof ToolBoundaryError) return error;
  if (error instanceof Error) {
    return new ToolBoundaryError('INTERNAL_ERROR', error.message);
  }
  return new ToolBoundaryError('INTERNAL_ERROR', 'Internal error', { details: error });
}
