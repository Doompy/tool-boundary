import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  ToolBoundaryError,
  buildApprovalReview,
  buildAuditEvent,
  hashUnknown,
  toToolBoundaryError,
  type ApprovalRecord,
  type ApprovalStore,
  type AuditEventType,
  type AuditSink,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolDefinition
} from '@tool-boundary/core';
import type { LoadedConfig, ResolvedAuthToken } from '@tool-boundary/config';
import { createRuntimeStores, type RuntimeStoreOverrides } from './runtime.js';
import { ToolCallService, getTool, resolveAuditPolicy, type Principal } from './tool-call-service.js';

const auditEventTypes: readonly AuditEventType[] = [
  'tool_call_started',
  'tool_call_allowed',
  'tool_call_denied',
  'approval_required',
  'tool_call_succeeded',
  'tool_call_failed',
  'approval_requested',
  'approval_approved',
  'approval_rejected',
  'approval_consumed',
  'approval_expired',
  'tool_output_validation_failed'
];

export type GatewayServerOptions = {
  readonly logger?: boolean;
  readonly stores?: RuntimeStoreOverrides;
};

export function createGatewayServer(config: LoadedConfig, options: GatewayServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const stores = createRuntimeStores(config, options.stores);
  const { auditSink, approvalStore } = stores;
  const toolCallService = new ToolCallService(config, stores);

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/v1/tools', async (request, reply) => {
    authenticate(request, config, 'tools:read');
    await reply.send({
      tools: Object.values(config.tools).map(publicToolDefinition)
    });
  });

  app.get('/v1/tools/:name', async (request, reply) => {
    authenticate(request, config, 'tools:read');
    const tool = getTool(config, getNameParam(request));
    await reply.send(publicToolDefinition(tool));
  });

  app.post('/v1/tools/:name/call', async (request, reply) => {
    const principal = authenticate(request, config, 'tools:call');
    const body = parseToolCallRequest(request.body);
    const result = await toolCallService.callTool(getNameParam(request), body, principal);
    if (!result.ok) return sendError(reply, result.error, result.executionId);
    return reply.send(result.result);
  });

  app.get('/v1/approvals', async (request, reply) => {
    const principal = authenticate(request, config, 'approvals:read');
    await expireDueAndAudit(config, approvalStore, auditSink, principal);
    await reply.send({ approvals: (await approvalStore.list()).map(publicApprovalRecord) });
  });

  app.post('/v1/approvals', async (request, reply) => {
    const principal = authenticate(request, config, 'approvals:request');
    const body = parseApprovalCreateBody(request.body);
    const tool = getTool(config, body.toolName);
    const auditPolicy = resolveAuditPolicy(config, tool);
    const record = await approvalStore.create({
      toolName: tool.name,
      inputHash: inputHashForApprovalCreate(body),
      requestedBy: principal.name,
      resourceIds: body.resourceIds,
      dryRunHash: body.dryRunHash,
      expiresAt: body.expiresAt,
      ...buildApprovalReview(body.input, {
        previewPaths: tool.approval?.previewPaths,
        redactPaths: auditPolicy.redactPaths
      })
    });
    await auditSink.write(
      buildAuditEvent({
        eventType: 'approval_requested',
        tool,
        userId: principal.name,
        input: body.input,
        approvalId: record.id,
        auditPolicy
      })
    );
    await reply.code(201).send(publicApprovalRecord(record));
  });

  app.post('/v1/approvals/:id/approve', async (request, reply) => {
    const principal = authenticate(request, config, 'approvals:approve');
    const approvalId = getIdParam(request);
    const expiredIds = await expireDueAndAudit(config, approvalStore, auditSink, principal);
    const requested = await approvalStore.get(approvalId);
    if (requested !== undefined && requested.status === 'requested' && requested.requestedBy === principal.name) {
      throw new ToolBoundaryError('FORBIDDEN', 'Approval requester cannot approve the same approval');
    }
    let record: ApprovalRecord;
    let token: string;
    try {
      ({ record, token } = await approvalStore.approve(approvalId, principal.name));
    } catch (error) {
      const normalized = toToolBoundaryError(error);
      if (normalized.code === 'APPROVAL_EXPIRED') {
        const expiredApprovalId = getApprovalIdFromDetails(normalized.details);
        if (expiredApprovalId === undefined || !expiredIds.has(expiredApprovalId)) {
          await writeApprovalExpiredAuditFromError(config, auditSink, principal, normalized);
        }
      }
      return sendError(reply, normalized);
    }
    const tool = getTool(config, record.toolName);
    await auditSink.write(
      buildAuditEvent({
        eventType: 'approval_approved',
        tool,
        userId: principal.name,
        approvalId: record.id,
        approvalTokenHash: record.approvalTokenHash,
        auditPolicy: resolveAuditPolicy(config, tool)
      })
    );
    await reply.send({ approval: publicApprovalRecord(record), approvalToken: token });
  });

  app.post('/v1/approvals/:id/reject', async (request, reply) => {
    const principal = authenticate(request, config, 'approvals:reject');
    let record: ApprovalRecord;
    try {
      record = await approvalStore.reject(getIdParam(request));
    } catch (error) {
      const normalized = toToolBoundaryError(error);
      if (normalized.code === 'APPROVAL_EXPIRED') {
        await writeApprovalExpiredAuditFromError(config, auditSink, principal, normalized);
      }
      return sendError(reply, normalized);
    }
    const tool = getTool(config, record.toolName);
    await auditSink.write(
      buildAuditEvent({
        eventType: 'approval_rejected',
        tool,
        userId: principal.name,
        approvalId: record.id,
        auditPolicy: resolveAuditPolicy(config, tool)
      })
    );
    await reply.send(publicApprovalRecord(record));
  });

  app.get('/v1/audit', async (request, reply) => {
    authenticate(request, config, 'audit:read');
    await reply.send(await auditSink.query(parseAuditQuery(request.query)));
  });

  app.setErrorHandler(async (error, _request, reply) => {
    await sendError(reply, toToolBoundaryError(error));
  });

  return app;
}

export async function startGateway(config: LoadedConfig, options: GatewayServerOptions = {}): Promise<FastifyInstance> {
  const app = createGatewayServer(config, options);
  await app.listen({ host: config.server.host, port: config.server.port });
  return app;
}

function authenticate(request: FastifyRequest, config: LoadedConfig, requiredScope: string): Principal {
  const authHeader = request.headers.authorization;
  const tokenValue = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
  if (tokenValue === undefined) {
    throw new ToolBoundaryError('UNAUTHORIZED', 'Bearer token is required');
  }
  const token = config.auth.tokens.find((candidate) => candidate.token === tokenValue);
  if (token === undefined) {
    throw new ToolBoundaryError('UNAUTHORIZED', 'Bearer token is invalid');
  }
  if (!hasScope(token, requiredScope)) {
    throw new ToolBoundaryError('FORBIDDEN', `Required scope ${requiredScope}`);
  }
  return { name: token.name, scopes: token.scopes };
}

function hasScope(token: ResolvedAuthToken, scope: string): boolean {
  return token.scopes.includes(scope);
}

function publicToolDefinition(tool: ToolDefinition): ToolDefinition {
  if (tool.target.type !== 'http' || tool.target.headers === undefined) return tool;
  const { headers: _headers, ...target } = tool.target;
  return {
    ...tool,
    target
  };
}

function publicApprovalRecord(record: ApprovalRecord): Omit<ApprovalRecord, 'approvalTokenHash'> {
  const { approvalTokenHash: _approvalTokenHash, ...publicRecord } = record;
  return publicRecord;
}

function getNameParam(request: FastifyRequest): string {
  return getStringParam(request, 'name');
}

function getIdParam(request: FastifyRequest): string {
  return getStringParam(request, 'id');
}

function getStringParam(request: FastifyRequest, key: string): string {
  const params = request.params as Record<string, unknown>;
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolBoundaryError('CONFIG_INVALID', `Missing route parameter ${key}`);
  }
  return value;
}

function parseToolCallRequest(body: unknown): ToolCallRequest {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ToolBoundaryError('CONFIG_INVALID', 'Tool call body must be an object');
  }
  const value = body as Record<string, unknown>;
  return {
    input: value.input,
    hasInput: Object.hasOwn(value, 'input'),
    idempotencyKey: typeof value.idempotencyKey === 'string' ? value.idempotencyKey : undefined,
    approvalToken: typeof value.approvalToken === 'string' ? value.approvalToken : undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined
  };
}

function parseApprovalCreateBody(body: unknown): {
  readonly toolName: string;
  readonly input?: unknown;
  readonly hasInput: boolean;
  readonly resourceIds?: readonly string[];
  readonly dryRunHash?: string;
  readonly expiresAt?: string;
} {
  if (!isRecord(body) || typeof body.toolName !== 'string') {
    throw new ToolBoundaryError('CONFIG_INVALID', 'Approval request requires toolName');
  }
  return {
    toolName: body.toolName,
    input: body.input,
    hasInput: Object.hasOwn(body, 'input'),
    resourceIds: Array.isArray(body.resourceIds) && body.resourceIds.every((item) => typeof item === 'string') ? body.resourceIds : undefined,
    dryRunHash: typeof body.dryRunHash === 'string' ? body.dryRunHash : undefined,
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined
  };
}

function parseAuditQuery(query: unknown): {
  readonly limit: number;
  readonly after?: string;
  readonly toolName?: string;
  readonly eventType?: AuditEventType;
} {
  const value = isRecord(query) ? query : {};
  const limit = parseLimit(value.limit);
  const eventType = parseAuditEventType(value.eventType);
  return {
    limit,
    after: typeof value.after === 'string' && value.after.length > 0 ? value.after : undefined,
    toolName: typeof value.toolName === 'string' && value.toolName.length > 0 ? value.toolName : undefined,
    eventType
  };
}

function parseLimit(value: unknown): number {
  if (value === undefined) return 100;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(parsed) || typeof parsed !== 'number' || parsed < 1) {
    throw new ToolBoundaryError('CONFIG_INVALID', 'Audit limit must be a positive integer');
  }
  return Math.min(parsed, 1000);
}

function parseAuditEventType(value: unknown): AuditEventType | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !auditEventTypes.includes(value as AuditEventType)) {
    throw new ToolBoundaryError('CONFIG_INVALID', 'Audit eventType is invalid');
  }
  return value as AuditEventType;
}

function inputHashForApprovalCreate(body: { readonly hasInput: boolean; readonly input?: unknown }): string {
  return hashUnknown(body.hasInput ? { hasInput: true, input: body.input } : { hasInput: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function sendError(reply: FastifyReply, error: ToolBoundaryError, executionId?: string): Promise<void> {
  await reply.code(error.statusCode).send({
    ok: false,
    executionId,
    error: {
      code: error.code,
      message: error.message,
      details: error.publicDetails
    }
  } satisfies ToolCallResult);
}

async function writeApprovalExpiredAudit(config: LoadedConfig, auditSink: AuditSink, principal: Principal, record: ApprovalRecord): Promise<void> {
  const tool = getTool(config, record.toolName);
  await auditSink.write(
    buildAuditEvent({
      eventType: 'approval_expired',
      tool,
      userId: principal.name,
      approvalId: record.id,
      approvalTokenHash: record.approvalTokenHash,
      auditPolicy: resolveAuditPolicy(config, tool)
    })
  );
}

async function expireDueAndAudit(config: LoadedConfig, approvalStore: ApprovalStore, auditSink: AuditSink, principal: Principal): Promise<ReadonlySet<string>> {
  const expired = await approvalStore.expireDue();
  for (const record of expired) {
    await writeApprovalExpiredAudit(config, auditSink, principal, record);
  }
  return new Set(expired.map((record) => record.id));
}

async function writeApprovalExpiredAuditFromError(
  config: LoadedConfig,
  auditSink: AuditSink,
  principal: Principal,
  error: ToolBoundaryError
): Promise<void> {
  const details = isRecord(error.details) ? error.details : {};
  const approvalId = typeof details.approvalId === 'string' ? details.approvalId : undefined;
  const toolName = typeof details.toolName === 'string' ? details.toolName : undefined;
  if (approvalId === undefined || toolName === undefined) return;
  const tool = getTool(config, toolName);
  await auditSink.write(
    buildAuditEvent({
      eventType: 'approval_expired',
      tool,
      userId: principal.name,
      approvalId,
      approvalTokenHash: getApprovalTokenHashFromDetails(error.details),
      auditPolicy: resolveAuditPolicy(config, tool)
    })
  );
}

function getApprovalIdFromDetails(details: unknown): string | undefined {
  return isRecord(details) && typeof details.approvalId === 'string' ? details.approvalId : undefined;
}

function getApprovalTokenHashFromDetails(details: unknown): string | undefined {
  return isRecord(details) && typeof details.approvalTokenHash === 'string' ? details.approvalTokenHash : undefined;
}
