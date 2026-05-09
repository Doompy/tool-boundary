import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  FileApprovalStore,
  FileIdempotencyStore,
  JsonlAuditSink,
  SqliteApprovalStore,
  SqliteAuditSink,
  SqliteIdempotencyStore,
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
    expect(await store.check('tool', 'key', 'hash-a', 'agent-a', 'fingerprint-a')).toEqual({ status: 'miss' });
    await store.record('tool', 'key', 'hash-a', 'agent-a', 'fingerprint-a', { executionId: 'exec-1', output: { ok: true } });
    expect(await store.check('tool', 'key', 'hash-b', 'agent-a', 'fingerprint-a')).toEqual({ status: 'conflict', reason: 'input_mismatch' });
    expect(await store.check('tool', 'key', 'hash-a', 'agent-b', 'fingerprint-a')).toEqual({ status: 'miss' });
    expect(await store.check('tool', 'key', 'hash-a', 'agent-a', 'fingerprint-b')).toEqual({ status: 'conflict', reason: 'execution_fingerprint_mismatch' });
    expect(await store.check('tool', 'key', 'hash-a', 'agent-a', 'fingerprint-a')).toEqual({
      status: 'replay',
      result: { executionId: 'exec-1', output: { ok: true }, executionFingerprint: 'fingerprint-a' }
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
    expect(await store.check('tool', 'legacy', 'hash-a', 'agent-a', 'fingerprint-a')).toEqual({ status: 'miss' });
  });

  it('does not replay legacy idempotency records without execution fingerprint', async () => {
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
            principalName: 'agent-a',
            policyHash: 'policy-a',
            result: { executionId: 'exec-1', output: { ok: true }, policyHash: 'policy-a' },
            createdAt: new Date().toISOString()
          }
        ]
      })
    );
    const store = new FileIdempotencyStore(path);
    expect(await store.check('tool', 'legacy', 'hash-a', 'agent-a', 'fingerprint-a')).toEqual({ status: 'conflict', reason: 'legacy_record' });
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
    expect((await store.get(record.id))?.status).toBe('requested');
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
    await expect(store.approve(record.id, 'operator')).rejects.toMatchObject({
      code: 'APPROVAL_EXPIRED',
      publicDetails: { approvalId: record.id }
    });
  });

  it('uses JsonlAuditSink through the AuditSink interface and supports query filters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-core-'));
    const sink = new JsonlAuditSink(join(dir, 'audit.jsonl'));
    const interfaceSink: AuditSink = sink;
    await sink.write({
      id: 'audit-1',
      eventType: 'tool_call_started',
      toolName: 'tool',
      mode: 'read',
      createdAt: new Date().toISOString()
    });
    await sink.write({
      id: 'audit-2',
      eventType: 'approval_expired',
      toolName: 'tool',
      mode: 'mutate',
      createdAt: new Date().toISOString()
    });
    await sink.write({
      id: 'audit-3',
      eventType: 'approval_expired',
      toolName: 'other',
      mode: 'mutate',
      createdAt: new Date().toISOString()
    });
    expect((await sink.readAll()).map((event) => event.id)).toEqual(['audit-1', 'audit-2', 'audit-3']);
    expect((await interfaceSink.query({ toolName: 'tool', eventType: 'approval_expired' })).events.map((event) => event.id)).toEqual(['audit-2']);
    expect(await interfaceSink.query({ limit: 1 })).toMatchObject({ events: [{ id: 'audit-1' }], nextCursor: 'audit-1' });
    expect((await interfaceSink.query({ after: 'audit-1', limit: 1 })).events.map((event) => event.id)).toEqual(['audit-2']);
    expect(await readFile(join(dir, 'audit.jsonl'), 'utf8')).toContain('audit-3');
  });

  it('supports SQLite approval, idempotency, and audit stores', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-core-sqlite-'));
    const dbPath = join(dir, 'toolboundary.db');
    const approvals: ApprovalStore = new SqliteApprovalStore(dbPath);
    const idempotency: IdempotencyStore = new SqliteIdempotencyStore(dbPath);
    const audit: AuditSink = new SqliteAuditSink(dbPath);

    const requested = await approvals.create({
      toolName: 'admin.disableUser',
      inputHash: 'input-hash',
      requestedBy: 'local-agent'
    });
    const approved = await approvals.approve(requested.id, 'operator');
    expect(approved.record.approvalTokenHash).toBe(hashApprovalToken(approved.token));
    await approvals.consume(approved.record.id);
    await expect(approvals.consume(approved.record.id)).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });

    expect(await idempotency.check('tool', 'key', 'hash-a', 'agent-a', 'fingerprint-a')).toEqual({ status: 'miss' });
    await idempotency.record('tool', 'key', 'hash-a', 'agent-a', 'fingerprint-a', { executionId: 'exec-1', output: { ok: true } });
    expect(await idempotency.check('tool', 'key', 'hash-a', 'agent-b', 'fingerprint-a')).toEqual({ status: 'miss' });
    expect(await idempotency.check('tool', 'key', 'hash-b', 'agent-a', 'fingerprint-a')).toEqual({ status: 'conflict', reason: 'input_mismatch' });
    expect((await idempotency.check('tool', 'key', 'hash-a', 'agent-a', 'fingerprint-a')).status).toBe('replay');

    await audit.write({ id: 'audit-1', eventType: 'tool_call_started', toolName: 'tool', mode: 'read', createdAt: '2026-05-10T00:00:00.000Z' });
    await audit.write({ id: 'audit-2', eventType: 'approval_expired', toolName: 'tool', mode: 'mutate', createdAt: '2026-05-10T00:00:01.000Z' });
    await audit.write({ id: 'audit-3', eventType: 'approval_expired', toolName: 'other', mode: 'mutate', createdAt: '2026-05-10T00:00:02.000Z' });
    expect((await audit.query({ toolName: 'tool', eventType: 'approval_expired' })).events.map((event) => event.id)).toEqual(['audit-2']);
    expect(await audit.query({ limit: 1 })).toMatchObject({ events: [{ id: 'audit-1' }], nextCursor: 'audit-1' });
    expect((await audit.query({ after: 'audit-1', limit: 1 })).events.map((event) => event.id)).toEqual(['audit-2']);
  });

  it('SQLite approval store materializes expiry idempotently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-core-sqlite-'));
    const store = new SqliteApprovalStore(join(dir, 'toolboundary.db'));
    const record = await store.create({
      toolName: 'admin.disableUser',
      inputHash: 'input-hash',
      requestedBy: 'local-agent',
      expiresAt: '2000-01-01T00:00:00.000Z'
    });
    expect((await store.get(record.id))?.status).toBe('requested');
    expect((await store.expireDue()).map((item) => item.id)).toEqual([record.id]);
    expect((await store.get(record.id))?.status).toBe('expired');
    expect(await store.expireDue()).toEqual([]);
    await expect(store.approve(record.id, 'operator')).rejects.toMatchObject({
      code: 'APPROVAL_EXPIRED',
      publicDetails: { approvalId: record.id }
    });
  });
});
