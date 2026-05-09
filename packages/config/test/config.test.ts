import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { doctorConfig, loadConfig, loadConfigUnresolved, parseConfigContent } from '../src/index.js';

const validConfig = `
server:
  host: 127.0.0.1
  port: 3050
auth:
  mode: static-token
  tokens:
    - name: local-agent
      tokenEnv: TOOL_BOUNDARY_AGENT_TOKEN
      scopes: [tools:read, tools:call]
audit:
  sink: jsonl
  path: .tool-boundary/audit.jsonl
  defaults:
    input: hash
    output: summary
    error: summary
policies:
  default:
    allowedModes: [read, draft, dryRun]
tools:
  admin.searchUsers:
    mode: read
    description: Search users.
    inputSchema:
      type: object
    outputSchema:
      type: object
    target:
      type: mock
      result:
        ok: true
`;

describe('config loader', () => {
  it('loads YAML and resolves token env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-config-'));
    const path = join(dir, 'tool-boundary.config.yaml');
    await writeFile(path, validConfig);
    const config = await loadConfig(path, { env: { TOOL_BOUNDARY_AGENT_TOKEN: 'token' } });
    expect(config.auth.tokens[0]?.token).toBe('token');
    expect(config.tools['admin.searchUsers']?.name).toBe('admin.searchUsers');
    expect(config.storage.type).toBe('file');
  });

  it('loads tool versions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-config-'));
    const path = join(dir, 'tool-boundary.config.yaml');
    await writeFile(path, validConfig.replace('mode: read', 'version: "2026-05-10.1"\n    mode: read'));
    const config = await loadConfig(path, { env: { TOOL_BOUNDARY_AGENT_TOKEN: 'token' } });
    expect(config.tools['admin.searchUsers']?.version).toBe('2026-05-10.1');
  });

  it('loads sqlite storage and output validation config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-config-'));
    const path = join(dir, 'tool-boundary.config.yaml');
    await writeFile(
      path,
      validConfig
        .replace(
          'policies:',
          'storage:\n  type: sqlite\n  path: .tool-boundary/toolboundary.db\npolicies:'
        )
        .replace('outputSchema:\n      type: object', 'outputSchema:\n      type: object\n    outputValidation:\n      enabled: true\n      mode: auditOnly')
    );
    const config = await loadConfig(path, { env: { TOOL_BOUNDARY_AGENT_TOKEN: 'token' } });
    expect(config.storage).toEqual({ type: 'sqlite', path: '.tool-boundary/toolboundary.db' });
    expect(config.tools['admin.searchUsers']?.outputValidation).toEqual({ enabled: true, mode: 'auditOnly' });
  });

  it('loads MCP upstreams and MCP tool targets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-config-'));
    const path = join(dir, 'tool-boundary.config.yaml');
    await writeFile(
      path,
      validConfig
        .replace(
          'policies:',
          'mcp:\n  upstreams:\n    local-admin:\n      transport: stdio\n      command: node\n      args: ["./dist/upstream-server.js"]\n      cwd: "."\n      envFrom:\n        API_TOKEN: TOOL_BOUNDARY_UPSTREAM_TOKEN\npolicies:'
        )
        .replace('target:\n      type: mock\n      result:\n        ok: true', 'target:\n      type: mcp\n      upstream: local-admin\n      toolName: searchUsers\n      timeoutMs: 5000')
    );
    const config = await loadConfig(path, {
      env: {
        TOOL_BOUNDARY_AGENT_TOKEN: 'token'
      }
    });
    expect(config.mcp.upstreams['local-admin']?.command).toBe('node');
    expect(config.tools['admin.searchUsers']?.target).toMatchObject({ type: 'mcp', upstream: 'local-admin', toolName: 'searchUsers' });
  });

  it('rejects invalid storage config', () => {
    expect(() => parseConfigContent(validConfig.replace('policies:', 'storage:\n  type: postgres\npolicies:'))).toThrow();
  });

  it('rejects missing token env in strict load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-config-'));
    const path = join(dir, 'tool-boundary.config.yaml');
    await writeFile(path, validConfig);
    await expect(loadConfig(path, { env: {} })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('rejects invalid modes', () => {
    expect(() => parseConfigContent(validConfig.replace('mode: read', 'mode: execute'))).toThrow();
  });

  it('reports unsafe mutate definitions through doctor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-config-'));
    const path = join(dir, 'tool-boundary.config.yaml');
    await writeFile(
      path,
      validConfig.replace('mode: read', 'mode: mutate').replace('target:\n      type: mock', 'riskLevel: high\n    target:\n      type: mock')
    );
    const config = await loadConfigUnresolved(path);
    const diagnostics = doctorConfig(config, {});
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('MUTATE_WITHOUT_APPROVAL');
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('MUTATE_WITHOUT_IDEMPOTENCY');
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('STATIC_TOKEN_ENV_MISSING');
  });

  it('reports high-risk approval-required tools without approval preview paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-config-'));
    const path = join(dir, 'tool-boundary.config.yaml');
    await writeFile(
      path,
      validConfig
        .replace(
          'policies:\n  default:\n    allowedModes: [read, draft, dryRun]',
          'policies:\n  default:\n    allowedModes: [read, draft, dryRun]\n  mutating:\n    allowedModes: [read, draft, dryRun, mutate]\n    requireApprovalForModes: [mutate]\n    requireIdempotencyForModes: [mutate]'
        )
        .replace('mode: read', 'mode: mutate\n    riskLevel: high\n    approvalRequired: true\n    policy: mutating')
    );
    const config = await loadConfigUnresolved(path);
    const diagnostics = doctorConfig(config, { TOOL_BOUNDARY_AGENT_TOKEN: 'token' });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('HIGH_RISK_WITHOUT_APPROVAL_PREVIEW');
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('HIGH_RISK_WITHOUT_OUTPUT_VALIDATION');
  });

  it('reports output validation without output schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-config-'));
    const path = join(dir, 'tool-boundary.config.yaml');
    await writeFile(
      path,
      validConfig
        .replace('    outputSchema:\n      type: object\n', '')
        .replace('target:', 'outputValidation:\n      enabled: true\n      mode: enforce\n    target:')
    );
    const config = await loadConfigUnresolved(path);
    const diagnostics = doctorConfig(config, { TOOL_BOUNDARY_AGENT_TOKEN: 'token' });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('OUTPUT_VALIDATION_WITHOUT_SCHEMA');
  });

  it('reports MCP upstream configuration diagnostics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-config-'));
    const path = join(dir, 'tool-boundary.config.yaml');
    await writeFile(
      path,
      validConfig
        .replace(
          'policies:',
          'mcp:\n  upstreams:\n    local-admin:\n      transport: websocket\n      command: node\n      envFrom:\n        API_TOKEN: TOOL_BOUNDARY_UPSTREAM_TOKEN\npolicies:'
        )
        .replace('target:\n      type: mock\n      result:\n        ok: true', 'target:\n      type: mcp\n      upstream: missing-admin\n      toolName: searchUsers')
    );
    const config = await loadConfigUnresolved(path);
    const diagnostics = doctorConfig(config, { TOOL_BOUNDARY_AGENT_TOKEN: 'token' });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['MCP_UPSTREAM_UNSUPPORTED_TRANSPORT', 'MCP_UPSTREAM_ENV_MISSING', 'MCP_UPSTREAM_NOT_FOUND'])
    );
  });

  it('uses runtime policy rules when checking mutate approval and idempotency', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-config-'));
    const path = join(dir, 'tool-boundary.config.yaml');
    await writeFile(
      path,
      validConfig
        .replace(
          'policies:\n  default:\n    allowedModes: [read, draft, dryRun]',
          'policies:\n  default:\n    allowedModes: [read, draft, dryRun]\n  mutating:\n    allowedModes: [read, draft, dryRun, mutate]\n    requireApprovalForModes: [mutate]\n    requireIdempotencyForModes: [mutate]'
        )
        .replace('mode: read', 'mode: mutate\n    policy: mutating')
    );
    const config = await loadConfigUnresolved(path);
    const diagnostics = doctorConfig(config, { TOOL_BOUNDARY_AGENT_TOKEN: 'token' });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('MUTATE_WITHOUT_APPROVAL');
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('MUTATE_WITHOUT_IDEMPOTENCY');
  });

  it('reports missing policy references through doctor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-config-'));
    const path = join(dir, 'tool-boundary.config.yaml');
    await writeFile(path, validConfig.replace('mode: read', 'mode: read\n    policy: missing-policy'));
    const config = await loadConfigUnresolved(path);
    const diagnostics = doctorConfig(config, { TOOL_BOUNDARY_AGENT_TOKEN: 'token' });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('POLICY_NOT_FOUND');
  });

  it('reports static tokens that can both request and approve', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-config-'));
    const path = join(dir, 'tool-boundary.config.yaml');
    await writeFile(path, validConfig.replace('scopes: [tools:read, tools:call]', 'scopes: [tools:read, approvals:request, approvals:approve]'));
    const config = await loadConfigUnresolved(path);
    const diagnostics = doctorConfig(config, { TOOL_BOUNDARY_AGENT_TOKEN: 'token' });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('TOKEN_CAN_REQUEST_AND_APPROVE');
  });

  it('reports static token scope and duplicate diagnostics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-config-'));
    const path = join(dir, 'tool-boundary.config.yaml');
    await writeFile(
      path,
      validConfig.replace(
        'scopes: [tools:read, tools:call]',
        'scopes: [tools:read, approval:approve]\n    - name: local-agent\n      tokenEnv: TOOL_BOUNDARY_OTHER_TOKEN\n      scopes: [tools:read]\n    - name: local-operator\n      tokenEnv: TOOL_BOUNDARY_AGENT_TOKEN\n      scopes: [audit:read]'
      )
    );
    const config = await loadConfigUnresolved(path);
    const diagnostics = doctorConfig(config, {
      TOOL_BOUNDARY_AGENT_TOKEN: 'same-token',
      TOOL_BOUNDARY_OTHER_TOKEN: 'same-token'
    });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['UNKNOWN_SCOPE', 'DUPLICATE_TOKEN_NAME', 'DUPLICATE_TOKEN_ENV', 'DUPLICATE_RESOLVED_TOKEN'])
    );
  });

  it('rejects non-POST HTTP targets in MVP config', () => {
    const httpConfig = validConfig.replace(
      'target:\n      type: mock\n      result:\n        ok: true',
      'target:\n      type: http\n      method: GET\n      url: http://localhost:4001/tools/admin.searchUsers'
    );
    expect(() => parseConfigContent(httpConfig)).toThrow();
  });

  it('loads approval preview paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-config-'));
    const path = join(dir, 'tool-boundary.config.yaml');
    await writeFile(
      path,
      validConfig.replace(
        'target:\n      type: mock',
        'approval:\n      previewPaths:\n        - /userId\n        - /reason~1code\n    target:\n      type: mock'
      )
    );
    const config = await loadConfig(path, { env: { TOOL_BOUNDARY_AGENT_TOKEN: 'token' } });
    expect(config.tools['admin.searchUsers']?.approval?.previewPaths).toEqual(['/userId', '/reason~1code']);
  });

  it('rejects invalid approval preview paths', () => {
    const config = validConfig.replace(
      'target:\n      type: mock',
      'approval:\n      previewPaths:\n        - userId\n    target:\n      type: mock'
    );
    expect(() => parseConfigContent(config)).toThrow();
  });
});
