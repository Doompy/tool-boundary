import type { PolicyDecision, ToolDefinition, ToolMode, ToolPolicyDefinition, ToolRiskLevel } from './types.js';

export const defaultPolicy: ToolPolicyDefinition = {
  allowedModes: ['read', 'draft', 'dryRun']
};

export type EvaluatePolicyInput = {
  readonly tool: ToolDefinition;
  readonly policy?: ToolPolicyDefinition;
  readonly hasValidApproval?: boolean;
};

export function evaluatePolicy(input: EvaluatePolicyInput): PolicyDecision {
  const policy = input.policy ?? defaultPolicy;

  if (policy.denyDeprecatedTools === true && input.tool.deprecated === true) {
    return { verdict: 'deny', reason: 'Tool is deprecated' };
  }

  if (!allowsMode(policy.allowedModes, input.tool.mode)) {
    return { verdict: 'deny', reason: `Mode ${input.tool.mode} is not allowed by policy` };
  }

  if (requiresApproval(input.tool, policy) && input.hasValidApproval !== true) {
    return { verdict: 'approval_required', reason: 'Approval is required for this tool call' };
  }

  return { verdict: 'allow', reason: 'Policy allowed tool call' };
}

export function requiresApproval(tool: ToolDefinition, policy: ToolPolicyDefinition = defaultPolicy): boolean {
  if (tool.approvalRequired === true) return true;
  if (includesMode(policy.requireApprovalForModes, tool.mode)) return true;
  if (tool.riskLevel !== undefined && includesRisk(policy.requireApprovalForRiskLevels, tool.riskLevel)) return true;
  return false;
}

export function requiresIdempotency(tool: ToolDefinition, policy: ToolPolicyDefinition = defaultPolicy): boolean {
  if (tool.idempotency?.required === true) return true;
  return includesMode(policy.requireIdempotencyForModes, tool.mode);
}

function allowsMode(allowedModes: readonly ToolMode[] | undefined, mode: ToolMode): boolean {
  return allowedModes === undefined || allowedModes.includes(mode);
}

function includesMode(modes: readonly ToolMode[] | undefined, mode: ToolMode): boolean {
  return modes !== undefined && modes.includes(mode);
}

function includesRisk(risks: readonly ToolRiskLevel[] | undefined, risk: ToolRiskLevel): boolean {
  return risks !== undefined && risks.includes(risk);
}
