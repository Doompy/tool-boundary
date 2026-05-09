import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadedConfig } from '@tool-boundary/config';
import { FileApprovalStore, FileIdempotencyStore, JsonlAuditSink, hashUnknown, type ToolDefinition } from '@tool-boundary/core';
import { createGatewayServer, createMcpServer } from '../src/index.js';

const agentToken = 'agent-token';
const otherAgentToken = 'other-agent-token';
const operatorToken = 'operator-token';

let upstream: ReturnType<typeof Fastify> | undefined;
let upstreamUrl: string;

beforeEach(async () => {
  upstream = Fastify({ logger: false });
  upstream.post('/tools/admin.searchUsers', async () => ({ users: [{ id: 'usr_123' }] }));
  upstream.post('/tools/admin.disableUser', async (request) => ({ disabled: true, input: request.body }));
  upstream.post('/tools/secrets.echo', async (request) => request.body);
  upstream.post('/tools/slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { ok: true };
  });
  upstream.post('/tools/error', async (_request, reply) => {
    await reply.code(500).send({ error: 'fixture failure' });
  });
  upstream.post('/tools/invalid-output', async () => ({ wrong: true }));
  await upstream.listen({ host: '127.0.0.1', port: 0 });
  const address = upstream.server.address();
  if (address === null || typeof address === 'string') throw new Error('Failed to bind upstream fixture');
  upstreamUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await upstream?.close();
});

describe('gateway', () => {
  it('serves health, tools, and read tool calls', async () => {
    const app = createGatewayServer(await testConfig());
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const tools = await app.inject({ method: 'GET', url: '/v1/tools', headers: agentHeaders() });
    expect(tools.statusCode).toBe(200);
    expect(JSON.stringify(tools.json())).not.toContain('authorization');

    const call = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.searchUsers/call',
      headers: agentHeaders(),
      payload: { input: { query: 'ada' } }
    });
    expect(call.statusCode).toBe(200);
    expect(call.json()).toMatchObject({ ok: true, toolName: 'admin.searchUsers' });
  });

  it('uses injected stores instead of default file store paths', async () => {
    const config = await testConfig();
    const customDir = await mkdtemp(join(tmpdir(), 'tool-boundary-custom-stores-'));
    const app = createGatewayServer(config, {
      stores: {
        approvalStore: new FileApprovalStore(join(customDir, 'approvals.json')),
        idempotencyStore: new FileIdempotencyStore(join(customDir, 'idempotency.json')),
        auditSink: new JsonlAuditSink(join(customDir, 'audit.jsonl'))
      }
    });

    const call = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.searchUsers/call',
      headers: agentHeaders(),
      payload: { idempotencyKey: 'custom-store-key', input: { query: 'ada' } }
    });
    expect(call.statusCode).toBe(200);
    expect(await readFile(join(customDir, 'idempotency.json'), 'utf8')).toContain('custom-store-key');
    expect(await readFile(join(customDir, 'audit.jsonl'), 'utf8')).toContain('tool_call_succeeded');
    await expect(readFile(join(config.configDir, '.tool-boundary', 'idempotency.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires approval and idempotency for mutating tools, then consumes approval once', async () => {
    const app = createGatewayServer(await testConfig());
    const requested = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.disableUser/call',
      headers: agentHeaders(),
      payload: { input: { userId: 'usr_123', reason: 'contains-secret-reason' } }
    });
    expect(requested.statusCode).toBe(400);
    const approvalId = requested.json().error.details.approvalId as string;

    const forbiddenApprove = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/approve`,
      headers: agentHeaders(),
      payload: {}
    });
    expect(forbiddenApprove.statusCode).toBe(403);

    const approved = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/approve`,
      headers: operatorHeaders(),
      payload: {}
    });
    expect(approved.statusCode).toBe(200);
    const approvalToken = approved.json().approvalToken as string;

    const missingKey = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.disableUser/call',
      headers: agentHeaders(),
      payload: { approvalToken, input: { userId: 'usr_123', reason: 'contains-secret-reason' } }
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const executed = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.disableUser/call',
      headers: agentHeaders(),
      payload: {
        approvalToken,
        idempotencyKey: 'disable-usr-123',
        input: { userId: 'usr_123', reason: 'contains-secret-reason' }
      }
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ ok: true, approvalId });

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.disableUser/call',
      headers: agentHeaders(),
      payload: {
        approvalToken,
        idempotencyKey: 'disable-usr-123',
        input: { userId: 'usr_123', reason: 'contains-secret-reason' }
      }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ ok: true, approvalId, idempotencyReplay: true });

    const consumed = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.disableUser/call',
      headers: agentHeaders(),
      payload: {
        approvalToken,
        idempotencyKey: 'disable-usr-123-again',
        input: { userId: 'usr_123', reason: 'contains-secret-reason' }
      }
    });
    expect(consumed.statusCode).toBe(400);
    expect(consumed.json().error.code).toBe('APPROVAL_ALREADY_CONSUMED');
    expect(JSON.stringify(consumed.json())).not.toContain('approvalTokenHash');
  });

  it('does not let a requester approve its own approval even with approve scope', async () => {
    const config = await testConfig();
    const app = createGatewayServer({
      ...config,
      auth: {
        ...config.auth,
        tokens: config.auth.tokens.map((token) =>
          token.name === 'local-agent' ? { ...token, scopes: [...token.scopes, 'approvals:approve'] } : token
        )
      }
    });
    const requested = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.disableUser/call',
      headers: agentHeaders(),
      payload: { input: { userId: 'usr_123', reason: 'self-approval-test' } }
    });
    const approvalId = requested.json().error.details.approvalId as string;
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/approve`,
      headers: agentHeaders(),
      payload: {}
    });
    expect(approved.statusCode).toBe(403);
    expect(approved.json().error.message).toBe('Approval requester cannot approve the same approval');
  });

  it('does not write raw approval tokens or configured secret fields to audit JSONL', async () => {
    const config = await testConfig();
    const app = createGatewayServer(config);
    const requested = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.disableUser/call',
      headers: agentHeaders(),
      payload: { input: { userId: 'usr_123', reason: 'do-not-leak' } }
    });
    const approvalId = requested.json().error.details.approvalId as string;
    const approvals = await app.inject({ method: 'GET', url: '/v1/approvals', headers: operatorHeaders() });
    expect(approvals.statusCode).toBe(200);
    expect(JSON.stringify(approvals.json())).toContain('usr_123');
    expect(JSON.stringify(approvals.json())).not.toContain('do-not-leak');
    expect(JSON.stringify(approvals.json())).not.toContain('approvalTokenHash');

    const approved = await app.inject({ method: 'POST', url: `/v1/approvals/${approvalId}/approve`, headers: operatorHeaders(), payload: {} });
    const approvalToken = approved.json().approvalToken as string;
    expect(JSON.stringify(approved.json().approval)).not.toContain('approvalTokenHash');
    await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.disableUser/call',
      headers: agentHeaders(),
      payload: {
        approvalToken,
        idempotencyKey: 'audit-key',
        input: { userId: 'usr_123', reason: 'do-not-leak' }
      }
    });
    await app.inject({
      method: 'POST',
      url: '/v1/tools/secrets.echo/call',
      headers: agentHeaders(),
      payload: { input: { secret: 'super-secret', value: true } }
    });

    const audit = await readFile(join(config.configDir, '.tool-boundary', 'audit.jsonl'), 'utf8');
    expect(audit).not.toContain(approvalToken);
    expect(audit).not.toContain('do-not-leak');
    expect(audit).not.toContain('super-secret');

    const events = audit
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { readonly eventType: string });
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['approval_required', 'approval_requested', 'approval_approved', 'approval_consumed'])
    );

    const agentAudit = await app.inject({ method: 'GET', url: '/v1/audit', headers: agentHeaders() });
    expect(agentAudit.statusCode).toBe(403);
    const operatorAudit = await app.inject({ method: 'GET', url: '/v1/audit', headers: operatorHeaders() });
    expect(operatorAudit.statusCode).toBe(200);

    const filteredAudit = await app.inject({
      method: 'GET',
      url: '/v1/audit?limit=1&toolName=admin.disableUser&eventType=approval_requested',
      headers: operatorHeaders()
    });
    expect(filteredAudit.statusCode).toBe(200);
    expect(filteredAudit.json().events).toHaveLength(1);
    expect(filteredAudit.json().events[0]).toMatchObject({ toolName: 'admin.disableUser', eventType: 'approval_requested' });
    expect(filteredAudit.json().nextCursor === undefined || typeof filteredAudit.json().nextCursor === 'string').toBe(true);
  });

  it('expires approvals during list and audits the lifecycle event', async () => {
    const config = await testConfig();
    const app = createGatewayServer(config);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/approvals',
      headers: agentHeaders(),
      payload: {
        toolName: 'admin.disableUser',
        input: { userId: 'usr_123', reason: 'expired-list-test' },
        expiresAt: '2000-01-01T00:00:00.000Z'
      }
    });
    expect(created.statusCode).toBe(201);
    const approvalId = created.json().id as string;

    const approvals = await app.inject({ method: 'GET', url: '/v1/approvals', headers: operatorHeaders() });
    expect(approvals.statusCode).toBe(200);
    const approval = approvals.json().approvals.find((item: { readonly id: string }) => item.id === approvalId);
    expect(approval.status).toBe('expired');
    expect(await readFile(join(config.configDir, '.tool-boundary', 'audit.jsonl'), 'utf8')).toContain('approval_expired');
  });

  it('rejects approving expired approvals and audits the expiry', async () => {
    const config = await testConfig();
    const app = createGatewayServer(config);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/approvals',
      headers: agentHeaders(),
      payload: {
        toolName: 'admin.disableUser',
        input: { userId: 'usr_123', reason: 'expired-approve-test' },
        expiresAt: '2000-01-01T00:00:00.000Z'
      }
    });
    const approvalId = created.json().id as string;
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/approve`,
      headers: operatorHeaders(),
      payload: {}
    });
    expect(approved.statusCode).toBe(400);
    expect(approved.json().error).toEqual({
      code: 'APPROVAL_EXPIRED',
      message: 'Approval is expired',
      details: { approvalId }
    });
    expect(JSON.stringify(approved.json())).not.toContain('approvalTokenHash');
    expect(await readFile(join(config.configDir, '.tool-boundary', 'audit.jsonl'), 'utf8')).toContain('approval_expired');
  });

  it('returns approval expiry before self-approval denial for expired approvals', async () => {
    const config = await testConfig();
    const app = createGatewayServer({
      ...config,
      auth: {
        ...config.auth,
        tokens: config.auth.tokens.map((token) =>
          token.name === 'local-agent' ? { ...token, scopes: [...token.scopes, 'approvals:approve'] } : token
        )
      }
    });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/approvals',
      headers: agentHeaders(),
      payload: {
        toolName: 'admin.disableUser',
        input: { userId: 'usr_123', reason: 'expired-self-approve-test' },
        expiresAt: '2000-01-01T00:00:00.000Z'
      }
    });
    const approvalId = created.json().id as string;
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/approve`,
      headers: agentHeaders(),
      payload: {}
    });
    expect(approved.statusCode).toBe(400);
    expect(approved.json().error).toMatchObject({ code: 'APPROVAL_EXPIRED', details: { approvalId } });
    expect(approved.json().error.code).not.toBe('FORBIDDEN');
    expect(await readFile(join(config.configDir, '.tool-boundary', 'audit.jsonl'), 'utf8')).toContain('approval_expired');
  });

  it('maps upstream timeout and error responses', async () => {
    const app = createGatewayServer(await testConfig());
    const timeout = await app.inject({
      method: 'POST',
      url: '/v1/tools/fixture.slow/call',
      headers: agentHeaders(),
      payload: { input: {} }
    });
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json().error.code).toBe('TOOL_UPSTREAM_TIMEOUT');

    const error = await app.inject({
      method: 'POST',
      url: '/v1/tools/fixture.error/call',
      headers: agentHeaders(),
      payload: { input: {} }
    });
    expect(error.statusCode).toBe(502);
    expect(error.json().error.code).toBe('TOOL_UPSTREAM_ERROR');
  });

  it('detects idempotency conflicts', async () => {
    const config = await testConfig();
    const app = createGatewayServer(config);
    const first = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.searchUsers/call',
      headers: agentHeaders(),
      payload: { idempotencyKey: 'read-key', input: { query: 'ada' } }
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.searchUsers/call',
      headers: agentHeaders(),
      payload: { idempotencyKey: 'read-key', input: { query: 'grace' } }
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    const audit = await readFile(join(config.configDir, '.tool-boundary', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('Idempotency conflict: input_mismatch');
  });

  it('scopes idempotency records by principal', async () => {
    const app = createGatewayServer(await testConfig());
    const first = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.searchUsers/call',
      headers: agentHeaders(),
      payload: { idempotencyKey: 'principal-key', input: { query: 'ada' } }
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.searchUsers/call',
      headers: otherAgentHeaders(),
      payload: { idempotencyKey: 'principal-key', input: { query: 'ada' } }
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().idempotencyReplay).toBeUndefined();
  });

  it('does not replay idempotency records after policy changes', async () => {
    const config = await testConfig();
    const app = createGatewayServer(config);
    const first = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.searchUsers/call',
      headers: agentHeaders(),
      payload: { idempotencyKey: 'policy-key', input: { query: 'ada' } }
    });
    expect(first.statusCode).toBe(200);

    (config.policies as Record<string, unknown>).default = {
      allowedModes: ['read', 'draft', 'dryRun'],
      requireApprovalForModes: ['read']
    };
    const second = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.searchUsers/call',
      headers: agentHeaders(),
      payload: { idempotencyKey: 'policy-key', input: { query: 'ada' } }
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('does not replay idempotency records after execution fingerprint changes', async () => {
    const cases: readonly {
      readonly name: string;
      readonly change: (config: LoadedConfig) => LoadedConfig;
    }[] = [
      {
        name: 'target-url',
        change: (config) =>
          withSearchTool(config, {
            target: { type: 'http', method: 'POST', url: `${upstreamUrl}/tools/admin.searchUsers-v2` }
          })
      },
      {
        name: 'target-headers',
        change: (config) =>
          withSearchTool(config, {
            target: { type: 'http', method: 'POST', url: `${upstreamUrl}/tools/admin.searchUsers`, headers: { 'x-tool-version': '2' } }
          })
      },
      {
        name: 'timeout',
        change: (config) =>
          withSearchTool(config, {
            target: { type: 'http', method: 'POST', url: `${upstreamUrl}/tools/admin.searchUsers`, timeoutMs: 2000 }
          })
      },
      {
        name: 'input-schema',
        change: (config) =>
          withSearchTool(config, {
            inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } }
          })
      },
      {
        name: 'policy',
        change: (config) => ({
          ...config,
          policies: { ...config.policies, default: { allowedModes: ['read', 'draft', 'dryRun'], denyDeprecatedTools: true } }
        })
      },
      {
        name: 'version',
        change: (config) => withSearchTool(config, { version: '2026-05-10.2' })
      }
    ];

    for (const item of cases) {
      const config = await testConfig();
      const firstApp = createGatewayServer(config);
      const first = await firstApp.inject({
        method: 'POST',
        url: '/v1/tools/admin.searchUsers/call',
        headers: agentHeaders(),
        payload: { idempotencyKey: `fingerprint-${item.name}`, input: { query: 'ada' } }
      });
      expect(first.statusCode).toBe(200);

      const secondApp = createGatewayServer(item.change(config));
      const second = await secondApp.inject({
        method: 'POST',
        url: '/v1/tools/admin.searchUsers/call',
        headers: agentHeaders(),
        payload: { idempotencyKey: `fingerprint-${item.name}`, input: { query: 'ada' } }
      });
      expect(second.statusCode).toBe(400);
      expect(second.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    }
  });

  it('does not replay legacy policyHash-only idempotency records', async () => {
    const config = await testConfig();
    const stateDir = join(config.configDir, '.tool-boundary');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'idempotency.json'),
      JSON.stringify({
        records: [
          {
            toolName: 'admin.searchUsers',
            key: 'legacy-policy-hash-key',
            inputHash: hashUnknown({ hasInput: true, input: { query: 'ada' } }),
            principalName: 'local-agent',
            policyHash: 'legacy-policy-hash',
            result: { executionId: 'exec-legacy', output: { users: [] }, policyHash: 'legacy-policy-hash' },
            createdAt: new Date().toISOString()
          }
        ]
      })
    );
    const app = createGatewayServer(config);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.searchUsers/call',
      headers: agentHeaders(),
      payload: { idempotencyKey: 'legacy-policy-hash-key', input: { query: 'ada' } }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('keeps missing input distinct from empty object for idempotency hashing', async () => {
    const app = createGatewayServer(await testConfig());
    const first = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.searchUsers/call',
      headers: agentHeaders(),
      payload: { idempotencyKey: 'input-shape-key' }
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.searchUsers/call',
      headers: agentHeaders(),
      payload: { idempotencyKey: 'input-shape-key', input: {} }
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('enforces output validation when configured', async () => {
    const app = createGatewayServer(await testConfig());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/fixture.invalidOutputEnforce/call',
      headers: agentHeaders(),
      payload: { input: {} }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('TOOL_OUTPUT_SCHEMA_VALIDATION_FAILED');
  });

  it('audits output validation failures in auditOnly mode', async () => {
    const config = await testConfig();
    const app = createGatewayServer(config);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/fixture.invalidOutputAuditOnly/call',
      headers: agentHeaders(),
      payload: { input: {} }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, output: { wrong: true } });
    expect(await readFile(join(config.configDir, '.tool-boundary', 'audit.jsonl'), 'utf8')).toContain('tool_output_validation_failed');
  });

  it('calls an MCP upstream read target through ToolCallService', async () => {
    const base = await testConfig();
    const fixture = await writeMcpFixtureServer(base.configDir);
    const config = withMcpFixtureTools(base, fixture);
    const app = createGatewayServer(config);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/mcp.searchUsers/call',
      headers: agentHeaders(),
      payload: { input: { query: 'ada' } }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, output: { users: [{ id: 'usr_123', query: 'ada' }] } });
  });

  it('requires approval and idempotency for MCP upstream mutating targets', async () => {
    const base = await testConfig();
    const fixture = await writeMcpFixtureServer(base.configDir);
    const config = withMcpFixtureTools(base, fixture);
    const app = createGatewayServer(config);

    const requested = await app.inject({
      method: 'POST',
      url: '/v1/tools/mcp.disableUser/call',
      headers: agentHeaders(),
      payload: { input: { userId: 'usr_123', reasonCode: 'policy-review' } }
    });
    expect(requested.statusCode).toBe(400);
    expect(requested.json().error.code).toBe('APPROVAL_REQUIRED');
    const approvalId = requested.json().error.details.approvalId as string;

    const approved = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/approve`,
      headers: operatorHeaders(),
      payload: {}
    });
    const approvalToken = approved.json().approvalToken as string;

    const executed = await app.inject({
      method: 'POST',
      url: '/v1/tools/mcp.disableUser/call',
      headers: agentHeaders(),
      payload: {
        approvalToken,
        idempotencyKey: 'mcp-disable-user',
        input: { userId: 'usr_123', reasonCode: 'policy-review' }
      }
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ ok: true, output: { disabled: true, userId: 'usr_123' } });

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/tools/mcp.disableUser/call',
      headers: agentHeaders(),
      payload: {
        approvalToken,
        idempotencyKey: 'mcp-disable-user',
        input: { userId: 'usr_123', reasonCode: 'policy-review' }
      }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ idempotencyReplay: true });
  });

  it('maps MCP upstream errors and timeouts to stable ToolBoundary errors', async () => {
    const base = await testConfig();
    const fixture = await writeMcpFixtureServer(base.configDir);
    const config = withMcpFixtureTools(base, fixture);
    const app = createGatewayServer(config);

    const error = await app.inject({
      method: 'POST',
      url: '/v1/tools/mcp.error/call',
      headers: agentHeaders(),
      payload: { input: {} }
    });
    expect(error.statusCode).toBe(502);
    expect(error.json().error.code).toBe('TOOL_UPSTREAM_ERROR');

    const timeout = await app.inject({
      method: 'POST',
      url: '/v1/tools/mcp.slow/call',
      headers: agentHeaders(),
      payload: { input: {} }
    });
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json().error.code).toBe('TOOL_UPSTREAM_TIMEOUT');
  });

  it('applies output validation to MCP upstream results', async () => {
    const base = await testConfig();
    const fixture = await writeMcpFixtureServer(base.configDir);
    const config = withMcpFixtureTools(base, fixture);
    const app = createGatewayServer(config);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/mcp.invalidOutput/call',
      headers: agentHeaders(),
      payload: { input: {} }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('TOOL_OUTPUT_SCHEMA_VALIDATION_FAILED');
    expect(await readFile(join(config.configDir, '.tool-boundary', 'audit.jsonl'), 'utf8')).toContain('tool_output_validation_failed');
  });

  it('exposes configured tools through MCP and reuses ToolCallService', async () => {
    const config = await testConfig();
    const server = createMcpServer(config, { principal: { name: 'local-agent', scopes: ['tools:read', 'tools:call', 'approvals:request'] } });
    const client = new Client({ name: 'tool-boundary-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('admin.searchUsers');
      const readCall = await client.callTool({
        name: 'admin.searchUsers',
        arguments: { input: { query: 'ada' } }
      });
      expect(readCall.isError).toBeFalsy();
      expect(readCall.content[0]).toMatchObject({ type: 'text' });

      const mutateCall = await client.callTool({
        name: 'admin.disableUser',
        arguments: { input: { userId: 'usr_123', reason: 'mcp-approval-required' } }
      });
      expect(mutateCall.isError).toBe(true);
      expect(JSON.parse((mutateCall.content[0] as { readonly text: string }).text)).toMatchObject({ code: 'APPROVAL_REQUIRED' });
      expect(await readFile(join(config.configDir, '.tool-boundary', 'audit.jsonl'), 'utf8')).toContain('approval_requested');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('exposes MCP-backed tools through the ToolBoundary MCP server', async () => {
    const base = await testConfig();
    const fixture = await writeMcpFixtureServer(base.configDir);
    const config = withMcpFixtureTools(base, fixture);
    const server = createMcpServer(config, { principal: { name: 'local-agent', scopes: ['tools:read', 'tools:call', 'approvals:request'] } });
    const client = new Client({ name: 'tool-boundary-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('mcp.searchUsers');
      const readCall = await client.callTool({
        name: 'mcp.searchUsers',
        arguments: { input: { query: 'ada' } }
      });
      expect(readCall.isError).toBeFalsy();
      expect(readCall.structuredContent).toEqual({ users: [{ id: 'usr_123', query: 'ada' }] });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects missing runtime policy references instead of falling back silently', async () => {
    const config = await testConfig();
    const app = createGatewayServer({
      ...config,
      tools: {
        ...config.tools,
        'admin.searchUsers': {
          ...config.tools['admin.searchUsers'],
          policy: 'missing-policy'
        }
      }
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tools/admin.searchUsers/call',
      headers: agentHeaders(),
      payload: { input: { query: 'ada' } }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'CONFIG_INVALID' });
  });
});

function withSearchTool(config: LoadedConfig, patch: Partial<ToolDefinition>): LoadedConfig {
  const current = config.tools['admin.searchUsers'];
  if (current === undefined) throw new Error('Missing admin.searchUsers test tool');
  return {
    ...config,
    tools: {
      ...config.tools,
      'admin.searchUsers': {
        ...current,
        ...patch
      } as ToolDefinition
    }
  };
}

function withMcpFixtureTools(config: LoadedConfig, fixturePath: string): LoadedConfig {
  return {
    ...config,
    mcp: {
      upstreams: {
        localFixture: {
          transport: 'stdio',
          command: process.execPath,
          args: [fixturePath],
          cwd: config.configDir
        }
      }
    },
    tools: {
      ...config.tools,
      'mcp.searchUsers': {
        name: 'mcp.searchUsers',
        mode: 'read',
        description: 'Search users through MCP',
        inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
        outputSchema: { type: 'object', required: ['users'], properties: { users: { type: 'array' } } },
        outputValidation: { enabled: true, mode: 'enforce' },
        target: { type: 'mcp', upstream: 'localFixture', toolName: 'searchUsers', timeoutMs: 1000 }
      },
      'mcp.disableUser': {
        name: 'mcp.disableUser',
        mode: 'mutate',
        riskLevel: 'high',
        approvalRequired: true,
        description: 'Disable users through MCP',
        inputSchema: {
          type: 'object',
          required: ['userId', 'reasonCode'],
          properties: { userId: { type: 'string' }, reasonCode: { type: 'string' } }
        },
        outputSchema: { type: 'object', required: ['disabled', 'userId'], properties: { disabled: { type: 'boolean' }, userId: { type: 'string' } } },
        outputValidation: { enabled: true, mode: 'enforce' },
        target: { type: 'mcp', upstream: 'localFixture', toolName: 'disableUser', timeoutMs: 1000 },
        policy: 'allowMutatingApproved',
        approval: { previewPaths: ['/userId', '/reasonCode'] },
        idempotency: { required: true },
        audit: { input: 'redacted', output: 'summary', error: 'summary', redactPaths: ['/reasonCode'] }
      },
      'mcp.error': {
        name: 'mcp.error',
        mode: 'read',
        description: 'MCP error fixture',
        target: { type: 'mcp', upstream: 'localFixture', toolName: 'errorTool', timeoutMs: 1000 }
      },
      'mcp.slow': {
        name: 'mcp.slow',
        mode: 'read',
        description: 'MCP slow fixture',
        target: { type: 'mcp', upstream: 'localFixture', toolName: 'slowTool', timeoutMs: 50 }
      },
      'mcp.invalidOutput': {
        name: 'mcp.invalidOutput',
        mode: 'read',
        description: 'MCP invalid output fixture',
        outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        outputValidation: { enabled: true, mode: 'enforce' },
        target: { type: 'mcp', upstream: 'localFixture', toolName: 'invalidOutput', timeoutMs: 1000 }
      }
    }
  };
}

async function writeMcpFixtureServer(dir: string): Promise<string> {
  const path = join(dir, 'mcp-fixture-server.mjs');
  const sdkRoot = join(process.cwd(), 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');
  const serverUrl = pathToFileURL(join(sdkRoot, 'server', 'index.js')).href;
  const stdioUrl = pathToFileURL(join(sdkRoot, 'server', 'stdio.js')).href;
  const typesUrl = pathToFileURL(join(sdkRoot, 'types.js')).href;
  await writeFile(
    path,
    `
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from '${serverUrl}';
import { StdioServerTransport } from '${stdioUrl}';
import { CallToolRequestSchema, ListToolsRequestSchema } from '${typesUrl}';

const server = new Server({ name: 'fixture-mcp-upstream', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'searchUsers', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'disableUser', inputSchema: { type: 'object', properties: { userId: { type: 'string' }, reasonCode: { type: 'string' } }, required: ['userId', 'reasonCode'] } },
    { name: 'errorTool', inputSchema: { type: 'object' } },
    { name: 'slowTool', inputSchema: { type: 'object' } },
    { name: 'invalidOutput', inputSchema: { type: 'object' } }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  if (request.params.name === 'searchUsers') return json({ users: [{ id: 'usr_123', query: args.query }] });
  if (request.params.name === 'disableUser') return json({ disabled: true, userId: args.userId });
  if (request.params.name === 'errorTool') return { isError: true, content: [{ type: 'text', text: 'fixture failure' }] };
  if (request.params.name === 'slowTool') {
    await delay(150);
    return json({ ok: true });
  }
  if (request.params.name === 'invalidOutput') return json({ wrong: true });
  return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
});

await server.connect(new StdioServerTransport());

function json(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}
`,
    'utf8'
  );
  return path;
}

async function testConfig(): Promise<LoadedConfig> {
  const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-gateway-'));
  return {
    server: { host: '127.0.0.1', port: 3050 },
    auth: {
      mode: 'static-token',
      tokens: [
        {
          name: 'local-agent',
          tokenEnv: 'TOOL_BOUNDARY_AGENT_TOKEN',
          token: agentToken,
          scopes: ['tools:read', 'tools:call', 'approvals:request']
        },
        {
          name: 'other-agent',
          tokenEnv: 'TOOL_BOUNDARY_OTHER_AGENT_TOKEN',
          token: otherAgentToken,
          scopes: ['tools:read', 'tools:call', 'approvals:request']
        },
        {
          name: 'local-operator',
          tokenEnv: 'TOOL_BOUNDARY_OPERATOR_TOKEN',
          token: operatorToken,
          scopes: ['tools:read', 'approvals:read', 'approvals:approve', 'approvals:reject', 'audit:read']
        }
      ]
    },
    audit: {
      sink: 'jsonl',
      path: '.tool-boundary/audit.jsonl',
      defaults: {
        input: 'hash',
        output: 'summary',
        error: 'summary',
        redactPaths: ['/secret', '/token', '/authorization']
      }
    },
    storage: { type: 'file' },
    mcp: { upstreams: {} },
    policies: {
      default: { allowedModes: ['read', 'draft', 'dryRun'] },
      allowMutatingApproved: {
        allowedModes: ['read', 'draft', 'dryRun', 'mutate'],
        requireApprovalForModes: ['mutate'],
        requireIdempotencyForModes: ['mutate']
      }
    },
    tools: {
      'admin.searchUsers': {
        name: 'admin.searchUsers',
        mode: 'read',
        description: 'Search users',
        target: { type: 'http', method: 'POST', url: `${upstreamUrl}/tools/admin.searchUsers`, headers: { authorization: 'Bearer upstream-secret' } },
        audit: { input: 'hash', output: 'summary', error: 'summary' }
      },
      'admin.disableUser': {
        name: 'admin.disableUser',
        mode: 'mutate',
        riskLevel: 'high',
        approvalRequired: true,
        description: 'Disable user',
        inputSchema: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: { type: 'string' }
          }
        },
        target: { type: 'http', method: 'POST', url: `${upstreamUrl}/tools/admin.disableUser` },
        policy: 'allowMutatingApproved',
        approval: { previewPaths: ['/userId', '/reason'] },
        idempotency: { required: true },
        audit: { input: 'hash', output: 'summary', error: 'summary', redactPaths: ['/reason'] }
      },
      'secrets.echo': {
        name: 'secrets.echo',
        mode: 'read',
        description: 'Echo secrets',
        target: { type: 'http', method: 'POST', url: `${upstreamUrl}/tools/secrets.echo` },
        audit: { input: 'redacted', output: 'summary', error: 'summary' }
      },
      'fixture.slow': {
        name: 'fixture.slow',
        mode: 'read',
        description: 'Slow tool',
        target: { type: 'http', method: 'POST', url: `${upstreamUrl}/tools/slow`, timeoutMs: 50 }
      },
      'fixture.error': {
        name: 'fixture.error',
        mode: 'read',
        description: 'Error tool',
        target: { type: 'http', method: 'POST', url: `${upstreamUrl}/tools/error` }
      },
      'fixture.invalidOutputEnforce': {
        name: 'fixture.invalidOutputEnforce',
        mode: 'read',
        description: 'Invalid output enforce fixture',
        target: { type: 'http', method: 'POST', url: `${upstreamUrl}/tools/invalid-output` },
        outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        outputValidation: { enabled: true, mode: 'enforce' }
      },
      'fixture.invalidOutputAuditOnly': {
        name: 'fixture.invalidOutputAuditOnly',
        mode: 'read',
        description: 'Invalid output audit-only fixture',
        target: { type: 'http', method: 'POST', url: `${upstreamUrl}/tools/invalid-output` },
        outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        outputValidation: { enabled: true, mode: 'auditOnly' }
      }
    },
    configPath: join(dir, 'tool-boundary.config.yaml'),
    configDir: dir
  };
}

function agentHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${agentToken}`,
    'content-type': 'application/json'
  };
}

function operatorHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${operatorToken}`,
    'content-type': 'application/json'
  };
}

function otherAgentHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${otherAgentToken}`,
    'content-type': 'application/json'
  };
}
