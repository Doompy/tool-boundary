import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FileApprovalStore, FileIdempotencyStore, hashApprovalToken } from '../src/index.js';

describe('file stores', () => {
  it('stores only approval token hashes and consumes once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-core-'));
    const store = new FileApprovalStore(join(dir, 'approvals.json'));
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
      code: 'APPROVAL_ALREADY_CONSUMED'
    });
  });

  it('detects idempotency conflicts and replays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-core-'));
    const store = new FileIdempotencyStore(join(dir, 'idempotency.json'));
    expect(await store.check('tool', 'key', 'hash-a')).toEqual({ status: 'miss' });
    await store.record('tool', 'key', 'hash-a', { executionId: 'exec-1', output: { ok: true } });
    expect(await store.check('tool', 'key', 'hash-b')).toEqual({ status: 'conflict' });
    expect(await store.check('tool', 'key', 'hash-a')).toEqual({
      status: 'replay',
      result: { executionId: 'exec-1', output: { ok: true } }
    });
  });
});
