import { randomUUID } from 'node:crypto';
import { applyAuditPolicy } from './redaction.js';
import type { AuditEvent, AuditPayloadPolicy, PolicyDecision, ToolDefinition } from './types.js';

export type BuildAuditEventInput = {
  readonly eventType: AuditEvent['eventType'];
  readonly tool: ToolDefinition;
  readonly executionId?: string;
  readonly userId?: string;
  readonly agentId?: string;
  readonly policyDecision?: PolicyDecision;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly approvalId?: string;
  readonly approvalTokenHash?: string;
  readonly idempotencyKey?: string;
  readonly auditPolicy: AuditPayloadPolicy;
};

export function buildAuditEvent(input: BuildAuditEventInput): AuditEvent {
  const base: Record<string, unknown> = {
    id: randomUUID(),
    executionId: input.executionId,
    eventType: input.eventType,
    toolName: input.tool.name,
    mode: input.tool.mode,
    userId: input.userId,
    agentId: input.agentId,
    policyDecision: input.policyDecision,
    approvalId: input.approvalId,
    approvalTokenHash: input.approvalTokenHash,
    idempotencyKey: input.idempotencyKey,
    createdAt: new Date().toISOString()
  };

  if (input.input !== undefined) {
    const result = applyAuditPolicy(input.input, 'input', input.auditPolicy);
    if (result.field === 'value') base.input = result.value;
  }
  if (input.output !== undefined) {
    const result = applyAuditPolicy(input.output, 'output', input.auditPolicy);
    if (result.field === 'summary') base.outputSummary = result.summary;
    if (result.field === 'value') base.output = result.value;
  }
  if (input.error !== undefined) {
    const result = applyAuditPolicy(input.error, 'error', input.auditPolicy);
    if (result.field === 'summary') base.error = result.summary;
    if (result.field === 'value') base.error = result.value;
  }

  return removeUndefined(base) as AuditEvent;
}

export function mergeAuditPolicies(defaults: AuditPayloadPolicy | undefined, override: AuditPayloadPolicy | undefined): AuditPayloadPolicy {
  return {
    input: override?.input ?? defaults?.input,
    output: override?.output ?? defaults?.output,
    error: override?.error ?? defaults?.error,
    redactPaths: [...(defaults?.redactPaths ?? []), ...(override?.redactPaths ?? [])]
  };
}

function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
