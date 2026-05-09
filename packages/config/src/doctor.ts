import {
  defaultPolicy,
  requiresApproval,
  requiresIdempotency,
  type ToolDefinition,
  type ToolPolicyDefinition
} from '@tool-boundary/core';
import type { UnresolvedLoadedConfig } from './load-config.js';

const knownScopes = new Set(['tools:read', 'tools:call', 'approvals:read', 'approvals:request', 'approvals:approve', 'approvals:reject', 'audit:read']);

export type DoctorDiagnostic = {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly toolName?: string;
};

export function doctorConfig(config: UnresolvedLoadedConfig, env: NodeJS.ProcessEnv = process.env): readonly DoctorDiagnostic[] {
  const diagnostics: DoctorDiagnostic[] = [];

  diagnostics.push(...doctorStaticTokens(config, env));
  diagnostics.push(...doctorMcpUpstreams(config, env));

  for (const tool of Object.values(config.tools)) {
    diagnostics.push(...doctorTool(tool, config));
  }

  return diagnostics;
}

function doctorStaticTokens(config: UnresolvedLoadedConfig, env: NodeJS.ProcessEnv): readonly DoctorDiagnostic[] {
  const diagnostics: DoctorDiagnostic[] = [];
  const names = new Map<string, number>();
  const tokenEnvs = new Map<string, number>();
  const resolvedValues = new Map<string, string>();

  for (const token of config.auth.tokens) {
    names.set(token.name, (names.get(token.name) ?? 0) + 1);
    tokenEnvs.set(token.tokenEnv, (tokenEnvs.get(token.tokenEnv) ?? 0) + 1);

    if (env[token.tokenEnv] === undefined || env[token.tokenEnv]?.length === 0) {
      diagnostics.push({
        severity: 'error',
        code: 'STATIC_TOKEN_ENV_MISSING',
        message: `Static token env ${token.tokenEnv} is not set`
      });
    } else {
      const value = env[token.tokenEnv] ?? '';
      const existing = resolvedValues.get(value);
      if (existing !== undefined && existing !== token.name) {
        diagnostics.push({
          severity: 'error',
          code: 'DUPLICATE_RESOLVED_TOKEN',
          message: `Static token ${token.name} resolves to the same value as ${existing}`
        });
      }
      resolvedValues.set(value, token.name);
    }

    for (const scope of token.scopes) {
      if (!knownScopes.has(scope)) {
        diagnostics.push({
          severity: 'error',
          code: 'UNKNOWN_SCOPE',
          message: `Static token ${token.name} uses unknown scope ${scope}`
        });
      }
    }

    if (token.scopes.includes('approvals:request') && (token.scopes.includes('approvals:approve') || token.scopes.includes('approvals:reject'))) {
      diagnostics.push({
        severity: 'warning',
        code: 'TOKEN_CAN_REQUEST_AND_APPROVE',
        message: `Static token ${token.name} can both request and approve or reject approvals`
      });
    }
  }

  for (const [name, count] of names) {
    if (count > 1) {
      diagnostics.push({
        severity: 'error',
        code: 'DUPLICATE_TOKEN_NAME',
        message: `Static token name ${name} is defined more than once`
      });
    }
  }

  for (const [tokenEnv, count] of tokenEnvs) {
    if (count > 1) {
      diagnostics.push({
        severity: 'warning',
        code: 'DUPLICATE_TOKEN_ENV',
        message: `Static token env ${tokenEnv} is referenced more than once`
      });
    }
  }

  return diagnostics;
}

function doctorMcpUpstreams(config: UnresolvedLoadedConfig, env: NodeJS.ProcessEnv): readonly DoctorDiagnostic[] {
  const diagnostics: DoctorDiagnostic[] = [];
  for (const [name, upstream] of Object.entries(config.mcp.upstreams)) {
    if (upstream.transport !== 'stdio') {
      diagnostics.push({
        severity: 'error',
        code: 'MCP_UPSTREAM_UNSUPPORTED_TRANSPORT',
        message: `MCP upstream ${name} uses unsupported transport ${upstream.transport}`
      });
    }
    for (const [targetEnv, sourceEnv] of Object.entries(upstream.envFrom ?? {})) {
      if (env[sourceEnv] === undefined || env[sourceEnv]?.length === 0) {
        diagnostics.push({
          severity: 'error',
          code: 'MCP_UPSTREAM_ENV_MISSING',
          message: `MCP upstream ${name} maps ${targetEnv} from missing env ${sourceEnv}`
        });
      }
    }
  }
  return diagnostics;
}

function doctorTool(tool: ToolDefinition, config: UnresolvedLoadedConfig): readonly DoctorDiagnostic[] {
  const diagnostics: DoctorDiagnostic[] = [];
  const policy = resolvePolicyForDoctor(config, tool, diagnostics);

  if (tool.mode === 'mutate' && !requiresApproval(tool, policy)) {
    diagnostics.push({
      severity: 'error',
      code: 'MUTATE_WITHOUT_APPROVAL',
      message: 'Mutating tool must require approval through tool or policy config',
      toolName: tool.name
    });
  }

  if (isHighRisk(tool) && tool.audit === undefined) {
    diagnostics.push({
      severity: 'warning',
      code: 'HIGH_RISK_WITHOUT_AUDIT_POLICY',
      message: 'High or critical risk tool should define an audit policy',
      toolName: tool.name
    });
  }

  if (isHighRisk(tool) && requiresApproval(tool, policy) && (tool.approval?.previewPaths?.length ?? 0) === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'HIGH_RISK_WITHOUT_APPROVAL_PREVIEW',
      message: 'High or critical risk approval-required tool should define approval preview paths',
      toolName: tool.name
    });
  }

  if (tool.description === undefined || tool.description.trim().length === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'TOOL_WITHOUT_DESCRIPTION',
      message: 'Tool should include a description',
      toolName: tool.name
    });
  }

  if (tool.inputSchema === undefined) {
    diagnostics.push({
      severity: 'warning',
      code: 'TOOL_WITHOUT_INPUT_SCHEMA',
      message: 'Tool should include an input schema placeholder',
      toolName: tool.name
    });
  }

  if (tool.outputSchema === undefined) {
    diagnostics.push({
      severity: 'warning',
      code: 'TOOL_WITHOUT_OUTPUT_SCHEMA',
      message: 'Tool should include an output schema so opt-in output validation can be enabled',
      toolName: tool.name
    });
  }

  if (tool.outputValidation?.enabled === true && tool.outputSchema === undefined) {
    diagnostics.push({
      severity: 'error',
      code: 'OUTPUT_VALIDATION_WITHOUT_SCHEMA',
      message: 'Output validation is enabled but outputSchema is missing',
      toolName: tool.name
    });
  }

  if (isHighRisk(tool) && tool.outputValidation?.enabled !== true) {
    diagnostics.push({
      severity: 'warning',
      code: 'HIGH_RISK_WITHOUT_OUTPUT_VALIDATION',
      message: 'High or critical risk tool should enable output validation',
      toolName: tool.name
    });
  }

  if (isHighRisk(tool) && tool.audit?.output === 'full') {
    diagnostics.push({
      severity: 'error',
      code: 'HIGH_RISK_OUTPUT_FULL',
      message: 'High or critical risk tool must not audit full output',
      toolName: tool.name
    });
  }

  if (isHighRisk(tool) && tool.audit?.error === 'full') {
    diagnostics.push({
      severity: 'error',
      code: 'HIGH_RISK_ERROR_FULL',
      message: 'High or critical risk tool must not audit full errors',
      toolName: tool.name
    });
  }

  if (tool.mode === 'mutate' && !requiresIdempotency(tool, policy)) {
    diagnostics.push({
      severity: 'error',
      code: 'MUTATE_WITHOUT_IDEMPOTENCY',
      message: 'Mutating tool must require idempotency through tool or policy config',
      toolName: tool.name
    });
  }

  if (tool.target.type === 'http' && serverIsPublic(config.server.host) && upstreamIsLocalhost(tool.target.url)) {
    diagnostics.push({
      severity: 'warning',
      code: 'PUBLIC_SERVER_TO_LOCALHOST_UPSTREAM',
      message: 'Public gateway host points to a localhost upstream URL',
      toolName: tool.name
    });
  }

  if (tool.target.type === 'mcp' && config.mcp.upstreams[tool.target.upstream] === undefined) {
    diagnostics.push({
      severity: 'error',
      code: 'MCP_UPSTREAM_NOT_FOUND',
      message: `MCP target references missing upstream ${tool.target.upstream}`,
      toolName: tool.name
    });
  }

  return diagnostics;
}

function resolvePolicyForDoctor(
  config: UnresolvedLoadedConfig,
  tool: ToolDefinition,
  diagnostics: DoctorDiagnostic[]
): ToolPolicyDefinition {
  if (tool.policy === undefined) return config.policies.default ?? defaultPolicy;
  const policy = config.policies[tool.policy];
  if (policy !== undefined) return policy;
  diagnostics.push({
    severity: 'error',
    code: 'POLICY_NOT_FOUND',
    message: `Policy ${tool.policy} referenced by ${tool.name} was not found`,
    toolName: tool.name
  });
  return config.policies.default ?? defaultPolicy;
}

function isHighRisk(tool: ToolDefinition): boolean {
  return tool.riskLevel === 'high' || tool.riskLevel === 'critical';
}

function serverIsPublic(host: string): boolean {
  return !['127.0.0.1', 'localhost', '::1'].includes(host);
}

function upstreamIsLocalhost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}
