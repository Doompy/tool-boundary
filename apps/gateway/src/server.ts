import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  FileApprovalStore,
  FileIdempotencyStore,
  JsonlAuditSink,
  ToolBoundaryError,
  buildAuditEvent,
  defaultPolicy,
  evaluatePolicy,
  hashApprovalToken,
  hashUnknown,
  mergeAuditPolicies,
  requiresIdempotency,
  toToolBoundaryError,
  type ApprovalRecord,
  type AuditPayloadPolicy,
  type PolicyDecision,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolDefinition,
  type ToolPolicyDefinition
} from '@tool-boundary/core';
import type { LoadedConfig, ResolvedAuthToken } from '@tool-boundary/config';
import { executeToolTarget } from './upstream/http-tool.js';

type Principal = {
  readonly name: string;
  readonly scopes: readonly string[];
};

export type GatewayServerOptions = {
  readonly logger?: boolean;
};

export function createGatewayServer(config: LoadedConfig, options: GatewayServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const paths = resolveRuntimePaths(config);
  const auditSink = new JsonlAuditSink(paths.auditPath);
  const approvalStore = new FileApprovalStore(paths.approvalsPath);
  const idempotencyStore = new FileIdempotencyStore(paths.idempotencyPath);

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
    const tool = getTool(config, getNameParam(request));
    const body = parseToolCallRequest(request.body);
    const auditPolicy = resolveAuditPolicy(config, tool);
    const policy = resolvePolicy(config, tool);
    const executionId = randomUUID();
    const input = body.input;
    const inputHash = inputHashForToolCall(body);

    await auditSink.write(
      buildAuditEvent({
        eventType: 'tool_call_started',
        tool,
        executionId,
        userId: principal.name,
        input,
        idempotencyKey: body.idempotencyKey,
        auditPolicy
      })
    );

    const validation = validateInputSchema(tool.inputSchema, input);
    if (!validation.ok) {
      await writeDeniedAudit(auditSink, tool, executionId, principal, input, auditPolicy, {
        verdict: 'deny',
        reason: 'Input schema validation failed'
      });
      return sendError(reply, new ToolBoundaryError('TOOL_SCHEMA_VALIDATION_FAILED', 'Input schema validation failed', { details: validation.details }));
    }

    const preliminaryDecision = evaluatePolicy({ tool, policy, hasValidApproval: false });
    if (preliminaryDecision.verdict === 'deny') {
      await writeDeniedAudit(auditSink, tool, executionId, principal, input, auditPolicy, preliminaryDecision);
      return sendError(reply, new ToolBoundaryError('POLICY_DENIED', preliminaryDecision.reason));
    }

    if (body.idempotencyKey !== undefined) {
      const idempotency = await idempotencyStore.check(tool.name, body.idempotencyKey, inputHash);
      if (idempotency.status === 'conflict') {
        await writeDeniedAudit(auditSink, tool, executionId, principal, input, auditPolicy, {
          verdict: 'deny',
          reason: 'Idempotency key conflicts with a different input'
        });
        return sendError(reply, new ToolBoundaryError('IDEMPOTENCY_CONFLICT', 'Idempotency key conflicts with a different input'));
      }
      if (idempotency.status === 'replay') {
        const replayResult: ToolCallResult = {
          ok: true,
          executionId: idempotency.result.executionId,
          toolName: tool.name,
          mode: tool.mode,
          output: idempotency.result.output,
          approvalId: idempotency.result.approvalId,
          idempotencyReplay: true
        };
        await auditSink.write(
          buildAuditEvent({
            eventType: 'tool_call_succeeded',
            tool,
            executionId,
            userId: principal.name,
            output: replayResult.output,
            approvalId: replayResult.approvalId,
            idempotencyKey: body.idempotencyKey,
            auditPolicy
          })
        );
        return reply.send(replayResult);
      }
    }

    let approval: ApprovalRecord | undefined;
    if (body.approvalToken !== undefined) {
      try {
        approval = await approvalStore.findApprovedByToken(tool.name, inputHash, body.approvalToken);
      } catch (error) {
        const normalized = toToolBoundaryError(error);
        if (normalized.code === 'APPROVAL_EXPIRED') {
          await auditSink.write(
            buildAuditEvent({
              eventType: 'approval_expired',
              tool,
              executionId,
              userId: principal.name,
              input,
              approvalId: getApprovalIdFromDetails(normalized.details),
              approvalTokenHash: getApprovalTokenHashFromDetails(normalized.details),
              auditPolicy
            })
          );
        }
        await writeDeniedAudit(auditSink, tool, executionId, principal, input, auditPolicy, {
          verdict: 'deny',
          reason: normalized.message
        });
        return sendError(reply, normalized);
      }
    }

    const decision = evaluatePolicy({ tool, policy, hasValidApproval: approval !== undefined });
    if (decision.verdict === 'deny') {
      await writeDeniedAudit(auditSink, tool, executionId, principal, input, auditPolicy, decision);
      return sendError(reply, new ToolBoundaryError('POLICY_DENIED', decision.reason));
    }

    if (decision.verdict === 'approval_required') {
      const approvalRecord = await approvalStore.create({
        toolName: tool.name,
        inputHash,
        requestedBy: principal.name
      });
      await auditSink.write(
        buildAuditEvent({
          eventType: 'approval_required',
          tool,
          executionId,
          userId: principal.name,
          policyDecision: decision,
          input,
          approvalId: approvalRecord.id,
          auditPolicy
        })
      );
      await auditSink.write(
        buildAuditEvent({
          eventType: 'approval_requested',
          tool,
          executionId,
          userId: principal.name,
          input,
          approvalId: approvalRecord.id,
          auditPolicy
        })
      );
      return sendError(
        reply,
        new ToolBoundaryError('APPROVAL_REQUIRED', decision.reason, {
          details: { approvalId: approvalRecord.id }
        })
      );
    }

    const idempotencyRequired = requiresIdempotency(tool, policy);
    if (idempotencyRequired && body.idempotencyKey === undefined) {
      await writeDeniedAudit(auditSink, tool, executionId, principal, input, auditPolicy, {
        verdict: 'deny',
        reason: 'Idempotency key is required'
      });
      return sendError(reply, new ToolBoundaryError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency key is required'));
    }

    if (approval !== undefined) {
      const consumed = await approvalStore.consume(approval.id);
      await auditSink.write(
        buildAuditEvent({
          eventType: 'approval_consumed',
          tool,
          executionId,
          userId: principal.name,
          input,
          approvalId: consumed.id,
          approvalTokenHash: body.approvalToken === undefined ? undefined : hashApprovalToken(body.approvalToken),
          auditPolicy
        })
      );
    }

    await auditSink.write(
      buildAuditEvent({
        eventType: 'tool_call_allowed',
        tool,
        executionId,
        userId: principal.name,
        policyDecision: decision,
        input,
        approvalId: approval?.id,
        approvalTokenHash: body.approvalToken === undefined ? undefined : hashApprovalToken(body.approvalToken),
        idempotencyKey: body.idempotencyKey,
        auditPolicy
      })
    );

    try {
      const output = await executeToolTarget(tool, input);
      if (body.idempotencyKey !== undefined) {
        await idempotencyStore.record(tool.name, body.idempotencyKey, inputHash, { executionId, output, approvalId: approval?.id });
      }
      await auditSink.write(
        buildAuditEvent({
          eventType: 'tool_call_succeeded',
          tool,
          executionId,
          userId: principal.name,
          output,
          approvalId: approval?.id,
          idempotencyKey: body.idempotencyKey,
          auditPolicy
        })
      );
      return reply.send({
        ok: true,
        executionId,
        toolName: tool.name,
        mode: tool.mode,
        output,
        approvalId: approval?.id
      } satisfies ToolCallResult);
    } catch (error) {
      const toolError = toToolBoundaryError(error);
      await auditSink.write(
        buildAuditEvent({
          eventType: 'tool_call_failed',
          tool,
          executionId,
          userId: principal.name,
          error: toolError,
          approvalId: approval?.id,
          idempotencyKey: body.idempotencyKey,
          auditPolicy
        })
      );
      return sendError(reply, toolError, executionId);
    }
  });

  app.get('/v1/approvals', async (request, reply) => {
    authenticate(request, config, 'approvals:read');
    await reply.send({ approvals: await approvalStore.list() });
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
      expiresAt: body.expiresAt
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
    await reply.code(201).send(record);
  });

  app.post('/v1/approvals/:id/approve', async (request, reply) => {
    const principal = authenticate(request, config, 'approvals:approve');
    const { record, token } = await approvalStore.approve(getIdParam(request), principal.name);
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
    await reply.send({ approval: record, approvalToken: token });
  });

  app.post('/v1/approvals/:id/reject', async (request, reply) => {
    const principal = authenticate(request, config, 'approvals:reject');
    const record = await approvalStore.reject(getIdParam(request));
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
    await reply.send(record);
  });

  app.get('/v1/audit', async (request, reply) => {
    authenticate(request, config, 'audit:read');
    await reply.send({ events: await auditSink.readAll() });
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

function getTool(config: LoadedConfig, name: string): ToolDefinition {
  const tool = config.tools[name];
  if (tool === undefined) {
    throw new ToolBoundaryError('TOOL_NOT_FOUND', `Tool ${name} was not found`);
  }
  return tool;
}

function resolvePolicy(config: LoadedConfig, tool: ToolDefinition): ToolPolicyDefinition {
  if (tool.policy !== undefined) {
    const policy = config.policies[tool.policy];
    if (policy === undefined) {
      throw new ToolBoundaryError('CONFIG_INVALID', `Policy ${tool.policy} referenced by ${tool.name} was not found`);
    }
    return policy;
  }
  return config.policies.default ?? defaultPolicy;
}

function resolveAuditPolicy(config: LoadedConfig, tool: ToolDefinition): AuditPayloadPolicy {
  return mergeAuditPolicies(config.audit.defaults, tool.audit);
}

function resolveRuntimePaths(config: LoadedConfig): { readonly auditPath: string; readonly approvalsPath: string; readonly idempotencyPath: string } {
  const stateDir = resolve(config.configDir, '.tool-boundary');
  return {
    auditPath: resolveConfigPath(config.configDir, config.audit.path),
    approvalsPath: resolve(stateDir, 'approvals.json'),
    idempotencyPath: resolve(stateDir, 'idempotency.json')
  };
}

function resolveConfigPath(configDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(configDir, path);
}

function publicToolDefinition(tool: ToolDefinition): ToolDefinition {
  if (tool.target.type !== 'http' || tool.target.headers === undefined) return tool;
  const { headers: _headers, ...target } = tool.target;
  return {
    ...tool,
    target
  };
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

function inputHashForToolCall(body: ToolCallRequest): string {
  return hashUnknown(body.hasInput === true ? { hasInput: true, input: body.input } : { hasInput: false });
}

function inputHashForApprovalCreate(body: { readonly hasInput: boolean; readonly input?: unknown }): string {
  return hashUnknown(body.hasInput ? { hasInput: true, input: body.input } : { hasInput: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateInputSchema(schema: unknown, input: unknown): { readonly ok: true } | { readonly ok: false; readonly details: readonly string[] } {
  if (schema === undefined || schema === null) return { ok: true };
  if (!isRecord(schema)) return { ok: true };
  const details: string[] = [];
  validateSchemaNode(schema, input, '', details);
  return details.length === 0 ? { ok: true } : { ok: false, details };
}

function validateSchemaNode(schema: Record<string, unknown>, value: unknown, path: string, details: string[]): void {
  if (typeof schema.type === 'string' && !matchesJsonType(value, schema.type)) {
    details.push(`${path || '/'} must be ${schema.type}`);
    return;
  }
  if (schema.type === 'object' && isRecord(value)) {
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) details.push(`${path}/${key} is required`);
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key) && isRecord(childSchema)) {
        validateSchemaNode(childSchema, value[key], `${path}/${key}`, details);
      }
    }
  }
}

function matchesJsonType(value: unknown, type: string): boolean {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number';
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

async function writeDeniedAudit(
  auditSink: JsonlAuditSink,
  tool: ToolDefinition,
  executionId: string,
  principal: Principal,
  input: unknown,
  auditPolicy: AuditPayloadPolicy,
  policyDecision: PolicyDecision
): Promise<void> {
  await auditSink.write(
    buildAuditEvent({
      eventType: 'tool_call_denied',
      tool,
      executionId,
      userId: principal.name,
      policyDecision,
      input,
      auditPolicy
    })
  );
}

async function sendError(reply: FastifyReply, error: ToolBoundaryError, executionId?: string): Promise<void> {
  await reply.code(error.statusCode).send({
    ok: false,
    executionId,
    error: {
      code: error.code,
      message: error.message,
      details: error.details
    }
  } satisfies ToolCallResult);
}

function getApprovalIdFromDetails(details: unknown): string | undefined {
  return isRecord(details) && typeof details.approvalId === 'string' ? details.approvalId : undefined;
}

function getApprovalTokenHashFromDetails(details: unknown): string | undefined {
  return isRecord(details) && typeof details.approvalTokenHash === 'string' ? details.approvalTokenHash : undefined;
}
