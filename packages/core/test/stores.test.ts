import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  FileApprovalStore,
  FileIdempotencyStore,
  JsonlAuditSink,
  hashApprovalToken,
  type ApprovalStore,
  type AuditSink,
  type IdempotencyStore
} from '../src/index.js';

describe('file stores', () => {
  it('stores only approval token hashes and consumes once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-core-'));
    const store: ApprovalStore = new FileApprovalStore(join(dir, 'approvals.json'));
    const requested = await store.create({
      toolName: 'admin.disableUser',
      inputHash: 'input-hash',
      requestedBy: 'local-agent'
    });
    const approved = await store.approve(requested.id, 'operator');
    expect(approved.record.approvalTokenHash).toBe(hashApprovalToken(approved.token));
    expect(JSON.stringify(await store.list())).not.toContain(approved.token);
    const found = await store.findApprovedByToken('admin.disableUser', 'input-hash', approved.token);
    expect(found.id).toBe(requested.id);
    await store.consume(found.id);
    await expect(store.findApprovedByToken('admin.disableUser', 'input-hash', approved.token)).rejects.toMatchObject({
      code: 'APPROVAL_ALREADY_CONSUMED',
      publicDetails: { approvalId: requested.id }
    });
  });

  it('detects idempotency conflicts and replays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-core-'));
    const store: IdempotencyStore = new FileIdempotencyStore(join(dir, 'idempotency.json'));
    expect(await store.check('tool', 'key', 'hash-a', 'agent-a', 'policy-a')).toEqual({ status: 'miss' });
    await store.record('tool', 'key', 'hash-a', 'agent-a', 'policy-a', { executionId: 'exec-1', output: { ok: true } });
    expect(await store.check('tool', 'key', 'hash-b', 'agent-a', 'policy-a')).toEqual({ status: 'conflict' });
    expect(await store.check('tool', 'key', 'hash-a', 'agent-b', 'policy-a')).toEqual({ status: 'miss' });
    expect(await store.check('tool', 'key', 'hash-a', 'agent-a', 'policy-b')).toEqual({ status: 'conflict' });
    expect(await store.check('tool', 'key', 'hash-a', 'agent-a', 'policy-a')).toEqual({
      status: 'replay',
      result: { executionId: 'exec-1', output: { ok: true }, policyHash: 'policy-a' }
    });
  });

  it('does not replay legacy idempotency records without principal and policy binding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-core-'));
    const path = join(dir, 'idempotency.json');
    await writeFile(
      path,
      JSON.stringify({
        records: [
          {
            toolName: 'tool',
            key: 'legacy',
            inputHash: 'hash-a',
            result: { executionId: 'exec-1', output: { ok: true } },
            createdAt: new Date().toISOString()
          }
        ]
      })
    );
    const store = new FileIdempotencyStore(path);
    expect(await store.check('tool', 'legacy', 'hash-a', 'agent-a', 'policy-a')).toEqual({ status: 'miss' });
  });

  it('keeps list read-only and materializes expired approvals through expireDue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-core-'));
    const store = new FileApprovalStore(join(dir, 'approvals.json'));
    const record = await store.create({
      toolName: 'admin.disableUser',
      inputHash: 'input-hash',
      requestedBy: 'local-agent',
      expiresAt: '2000-01-01T00:00:00.000Z'
    });
    expect((await store.list()).find((item) => item.id === record.id)?.status).toBe('requested');
    expect((await store.expireDue()).map((item) => item.id)).toEqual([record.id]);
    expect((await store.list()).find((item) => item.id === record.id)?.status).toBe('expired');
    expect(await store.expireDue()).toEqual([]);
  });

  it('rejects expired approvals inside approve', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-core-'));
    const store = new FileApprovalStore(join(dir, 'approvals.json'));
    const record = await store.create({
      toolName: 'admin.disableUser',
      inputHash: 'input-hash',
      requestedBy: 'local-agent',
      expiresAt: '2000-01-01T00:00:00.000Z'
    });
    await expect(store.approve(record.id, 'operator')).rejects.toMatchObject({
      code: 'APPROVAL_EXPIRED',
      publicDetails: { approvalId: record.id }
    });
    expect((await store.list()).find((item) => item.id === record.id)?.status).toBe('expired');
  });

  it('uses JsonlAuditSink through the AuditSink interface', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-core-'));
    const sink: AuditSink = new JsonlAuditSink(join(dir, 'audit.jsonl'));
    await sink.write({
      id: 'audit-1',
      eventType: 'tool_call_started',
      toolName: 'tool',
      mode: 'read',
      createdAt: new Date().toISOString()
    });
    expect((await sink.readAll()).map((event) => event.id)).toEqual(['audit-1']);
  });
});
