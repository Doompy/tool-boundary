import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadedConfig } from '@tool-boundary/config';
import { createGatewayServer } from '../src/index.js';

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
    const app = createGatewayServer(await testConfig());
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
  });

  it('does not replay idempotency records across principals', async () => {
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
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
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
