import { randomUUID } from 'node:crypto';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import {
  ToolBoundaryError,
  buildApprovalReview,
  buildAuditEvent,
  defaultPolicy,
  evaluatePolicy,
  hashApprovalToken,
  hashUnknown,
  mergeAuditPolicies,
  requiresIdempotency,
  toToolBoundaryError,
  type ApprovalRecord,
  type ApprovalStore,
  type AuditPayloadPolicy,
  type AuditSink,
  type PolicyDecision,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolDefinition,
  type ToolPolicyDefinition
} from '@tool-boundary/core';
import type { LoadedConfig } from '@tool-boundary/config';
import type { RuntimeStores } from './runtime.js';
import { executeConfiguredToolTarget } from './upstream/executor.js';

export type Principal = {
  readonly name: string;
  readonly scopes: readonly string[];
};

export type ToolCallServiceResponse =
  | { readonly ok: true; readonly result: Extract<ToolCallResult, { readonly ok: true }> }
  | { readonly ok: false; readonly error: ToolBoundaryError; readonly executionId?: string };

export type ToolExecutor = (tool: ToolDefinition, input: unknown) => Promise<unknown>;

export class ToolCallService {
  private readonly ajv = new Ajv({ strict: false, allErrors: true });
  private readonly schemaCache = new WeakMap<object, ValidateFunction>();
  private readonly execute: ToolExecutor;

  constructor(
    private readonly config: LoadedConfig,
    private readonly stores: RuntimeStores,
    options: { readonly execute?: ToolExecutor } = {}
  ) {
    this.execute = options.execute ?? ((tool, input) => executeConfiguredToolTarget(this.config, tool, input));
  }

  async callTool(toolName: string, body: ToolCallRequest, principal: Principal): Promise<ToolCallServiceResponse> {
    const tool = getTool(this.config, toolName);
    const auditPolicy = resolveAuditPolicy(this.config, tool);
    const policy = resolvePolicy(this.config, tool);
    const executionFingerprint = executionFingerprintForToolCall(tool, policy);
    const executionId = randomUUID();
    const input = body.input;
    const inputHash = inputHashForToolCall(body);

    await this.stores.auditSink.write(
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

    const validation = this.validateSchema(tool.inputSchema, input);
    if (!validation.ok) {
      await this.writeDeniedAudit(tool, executionId, principal, input, auditPolicy, {
        verdict: 'deny',
        reason: 'Input schema validation failed'
      });
      return failure(
        new ToolBoundaryError('TOOL_SCHEMA_VALIDATION_FAILED', 'Input schema validation failed', {
          details: validation.details,
          publicDetails: { issues: validation.details }
        })
      );
    }

    const preliminaryDecision = evaluatePolicy({ tool, policy, hasValidApproval: false });
    if (preliminaryDecision.verdict === 'deny') {
      await this.writeDeniedAudit(tool, executionId, principal, input, auditPolicy, preliminaryDecision);
      return failure(new ToolBoundaryError('POLICY_DENIED', preliminaryDecision.reason));
    }

    if (body.idempotencyKey !== undefined) {
      const idempotency = await this.stores.idempotencyStore.check(tool.name, body.idempotencyKey, inputHash, principal.name, executionFingerprint);
      if (idempotency.status === 'conflict') {
        await this.writeDeniedAudit(tool, executionId, principal, input, auditPolicy, {
          verdict: 'deny',
          reason: `Idempotency conflict: ${idempotency.reason}`
        });
        return failure(new ToolBoundaryError('IDEMPOTENCY_CONFLICT', 'Idempotency key conflicts with a previous call'));
      }
      if (idempotency.status === 'replay') {
        if (preliminaryDecision.verdict === 'approval_required' && idempotency.result.approvalId === undefined) {
          await this.writeDeniedAudit(tool, executionId, principal, input, auditPolicy, {
            verdict: 'deny',
            reason: 'Cached result no longer satisfies current approval policy'
          });
          return failure(new ToolBoundaryError('IDEMPOTENCY_CONFLICT', 'Idempotency replay does not satisfy current policy'));
        }
        const replayResult: ToolCallResult = {
          ok: true,
          executionId: idempotency.result.executionId,
          toolName: tool.name,
          mode: tool.mode,
          output: idempotency.result.output,
          approvalId: idempotency.result.approvalId,
          idempotencyReplay: true
        };
        await this.stores.auditSink.write(
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
        return { ok: true, result: replayResult };
      }
    }

    let approval: ApprovalRecord | undefined;
    if (body.approvalToken !== undefined) {
      try {
        approval = await this.stores.approvalStore.findApprovedByToken(tool.name, inputHash, body.approvalToken);
      } catch (error) {
        const normalized = toToolBoundaryError(error);
        if (normalized.code === 'APPROVAL_EXPIRED') {
          await this.stores.auditSink.write(
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
        await this.writeDeniedAudit(tool, executionId, principal, input, auditPolicy, {
          verdict: 'deny',
          reason: normalized.message
        });
        return failure(normalized);
      }
    }

    const decision = evaluatePolicy({ tool, policy, hasValidApproval: approval !== undefined });
    if (decision.verdict === 'deny') {
      await this.writeDeniedAudit(tool, executionId, principal, input, auditPolicy, decision);
      return failure(new ToolBoundaryError('POLICY_DENIED', decision.reason));
    }

    if (decision.verdict === 'approval_required') {
      const approvalRecord = await this.stores.approvalStore.create({
        toolName: tool.name,
        inputHash,
        requestedBy: principal.name,
        ...buildApprovalReview(input, {
          previewPaths: tool.approval?.previewPaths,
          redactPaths: auditPolicy.redactPaths
        })
      });
      await this.stores.auditSink.write(
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
      await this.stores.auditSink.write(
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
      return failure(
        new ToolBoundaryError('APPROVAL_REQUIRED', decision.reason, {
          details: { approvalId: approvalRecord.id },
          publicDetails: { approvalId: approvalRecord.id }
        })
      );
    }

    const idempotencyRequired = requiresIdempotency(tool, policy);
    if (idempotencyRequired && body.idempotencyKey === undefined) {
      await this.writeDeniedAudit(tool, executionId, principal, input, auditPolicy, {
        verdict: 'deny',
        reason: 'Idempotency key is required'
      });
      return failure(new ToolBoundaryError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency key is required'));
    }

    if (approval !== undefined) {
      const consumed = await this.stores.approvalStore.consume(approval.id);
      await this.stores.auditSink.write(
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

    await this.stores.auditSink.write(
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
      const output = await this.execute(tool, input);
      const outputValidation = this.validateOutput(tool, output);
      if (!outputValidation.ok) {
        const validationError = new ToolBoundaryError('TOOL_OUTPUT_SCHEMA_VALIDATION_FAILED', 'Output schema validation failed', {
          details: outputValidation.details,
          publicDetails: { issues: outputValidation.details }
        });
        await this.stores.auditSink.write(
          buildAuditEvent({
            eventType: 'tool_output_validation_failed',
            tool,
            executionId,
            userId: principal.name,
            output,
            error: validationError,
            approvalId: approval?.id,
            idempotencyKey: body.idempotencyKey,
            auditPolicy
          })
        );
        if (outputValidation.mode === 'enforce') {
          await this.stores.auditSink.write(
            buildAuditEvent({
              eventType: 'tool_call_failed',
              tool,
              executionId,
              userId: principal.name,
              error: validationError,
              approvalId: approval?.id,
              idempotencyKey: body.idempotencyKey,
              auditPolicy
            })
          );
          return failure(validationError, executionId);
        }
      }

      if (body.idempotencyKey !== undefined) {
        await this.stores.idempotencyStore.record(tool.name, body.idempotencyKey, inputHash, principal.name, executionFingerprint, { executionId, output, approvalId: approval?.id });
      }
      await this.stores.auditSink.write(
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
      return {
        ok: true,
        result: {
          ok: true,
          executionId,
          toolName: tool.name,
          mode: tool.mode,
          output,
          approvalId: approval?.id
        }
      };
    } catch (error) {
      const toolError = toToolBoundaryError(error);
      await this.stores.auditSink.write(
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
      return failure(toolError, executionId);
    }
  }

  private validateOutput(
    tool: ToolDefinition,
    output: unknown
  ): { readonly ok: true } | { readonly ok: false; readonly mode: 'enforce' | 'auditOnly'; readonly details: readonly string[] } {
    if (tool.outputValidation?.enabled !== true) return { ok: true };
    const validation = this.validateSchema(tool.outputSchema, output);
    if (validation.ok) return { ok: true };
    return {
      ok: false,
      mode: tool.outputValidation.mode ?? 'enforce',
      details: validation.details
    };
  }

  private validateSchema(schema: unknown, value: unknown): { readonly ok: true } | { readonly ok: false; readonly details: readonly string[] } {
    if (schema === undefined || schema === null) return { ok: true };
    if (typeof schema !== 'object') return { ok: true };
    const validate = this.validatorFor(schema);
    if (validate(value)) return { ok: true };
    return { ok: false, details: formatAjvErrors(validate.errors ?? []) };
  }

  private validatorFor(schema: object): ValidateFunction {
    const cached = this.schemaCache.get(schema);
    if (cached !== undefined) return cached;
    const validate = this.ajv.compile(schema);
    this.schemaCache.set(schema, validate);
    return validate;
  }

  private async writeDeniedAudit(
    tool: ToolDefinition,
    executionId: string,
    principal: Principal,
    input: unknown,
    auditPolicy: AuditPayloadPolicy,
    policyDecision: PolicyDecision
  ): Promise<void> {
    await this.stores.auditSink.write(
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
}

export function getTool(config: LoadedConfig, name: string): ToolDefinition {
  const tool = config.tools[name];
  if (tool === undefined) {
    throw new ToolBoundaryError('TOOL_NOT_FOUND', `Tool ${name} was not found`);
  }
  return tool;
}

export function resolvePolicy(config: LoadedConfig, tool: ToolDefinition): ToolPolicyDefinition {
  if (tool.policy !== undefined) {
    const policy = config.policies[tool.policy];
    if (policy === undefined) {
      throw new ToolBoundaryError('CONFIG_INVALID', `Policy ${tool.policy} referenced by ${tool.name} was not found`);
    }
    return policy;
  }
  return config.policies.default ?? defaultPolicy;
}

export function resolveAuditPolicy(config: LoadedConfig, tool: ToolDefinition): AuditPayloadPolicy {
  return mergeAuditPolicies(config.audit.defaults, tool.audit);
}

export function inputHashForToolCall(body: ToolCallRequest): string {
  return hashUnknown(body.hasInput === true ? { hasInput: true, input: body.input } : { hasInput: false });
}

export function executionFingerprintForToolCall(tool: ToolDefinition, policy: ToolPolicyDefinition): string {
  return hashUnknown({
    toolName: tool.name,
    version: tool.version,
    mode: tool.mode,
    riskLevel: tool.riskLevel,
    approvalRequired: tool.approvalRequired,
    idempotency: tool.idempotency,
    policy,
    target: tool.target,
    inputSchema: tool.inputSchema
  });
}

function failure(error: ToolBoundaryError, executionId?: string): ToolCallServiceResponse {
  return { ok: false, error, executionId };
}

function formatAjvErrors(errors: readonly ErrorObject[]): readonly string[] {
  return errors.map((error) => {
    const path = error.instancePath.length === 0 ? '/' : error.instancePath;
    return `${path} ${error.message ?? 'is invalid'}`;
  });
}

function getApprovalIdFromDetails(details: unknown): string | undefined {
  return isRecord(details) && typeof details.approvalId === 'string' ? details.approvalId : undefined;
}

function getApprovalTokenHashFromDetails(details: unknown): string | undefined {
  return isRecord(details) && typeof details.approvalTokenHash === 'string' ? details.approvalTokenHash : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
