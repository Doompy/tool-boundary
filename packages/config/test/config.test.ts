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
});
