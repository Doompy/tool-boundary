import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  approvalIsExpired,
  createApprovalRecord,
  generateApprovalToken,
  hashApprovalToken,
  type CreateApprovalInput
} from './approval.js';
import { ToolBoundaryError } from './errors.js';
import type { ApprovalRecord, AuditEvent, AuditQuery, AuditQueryResult, StoredToolCallResult } from './types.js';

type ApprovalFile = {
  readonly records: readonly ApprovalRecord[];
};

type IdempotencyRecord = {
  readonly toolName: string;
  readonly key: string;
  readonly inputHash: string;
  readonly principalName: string;
  readonly executionFingerprint?: string;
  readonly result: StoredToolCallResult;
  readonly createdAt: string;
};

type IdempotencyFile = {
  readonly records: readonly IdempotencyRecord[];
};

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
  query(filter: AuditQuery): Promise<AuditQueryResult>;
}

export interface ApprovalStore {
  get(id: string): Promise<ApprovalRecord | undefined>;
  list(): Promise<readonly ApprovalRecord[]>;
  expireDue(now?: Date): Promise<readonly ApprovalRecord[]>;
  create(input: CreateApprovalInput): Promise<ApprovalRecord>;
  approve(id: string, approvedBy: string): Promise<{ readonly record: ApprovalRecord; readonly token: string }>;
  reject(id: string): Promise<ApprovalRecord>;
  findApprovedByToken(toolName: string, inputHash: string, token: string): Promise<ApprovalRecord>;
  consume(id: string): Promise<ApprovalRecord>;
}

export type IdempotencyCheckResult =
  | { readonly status: 'miss' }
  | { readonly status: 'replay'; readonly result: StoredToolCallResult }
  | { readonly status: 'conflict'; readonly reason: IdempotencyConflictReason };

export type IdempotencyConflictReason = 'input_mismatch' | 'execution_fingerprint_mismatch' | 'legacy_record';

export interface IdempotencyStore {
  check(toolName: string, key: string, inputHash: string, principalName: string, executionFingerprint: string): Promise<IdempotencyCheckResult>;
  record(
    toolName: string,
    key: string,
    inputHash: string,
    principalName: string,
    executionFingerprint: string,
    result: StoredToolCallResult
  ): Promise<void>;
}

export class JsonlAuditSink implements AuditSink {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async write(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async readAll(): Promise<readonly AuditEvent[]> {
    try {
      const content = await readFile(this.path, 'utf8');
      return content
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AuditEvent);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  async query(filter: AuditQuery): Promise<AuditQueryResult> {
    const limit = filter.limit ?? Number.POSITIVE_INFINITY;
    const filtered = (await this.readAll()).filter((event) => {
      if (filter.toolName !== undefined && event.toolName !== filter.toolName) return false;
      if (filter.eventType !== undefined && event.eventType !== filter.eventType) return false;
      return true;
    });
    const afterIndex = filter.after === undefined ? -1 : filtered.findIndex((event) => event.id === filter.after);
    const start = afterIndex === -1 ? 0 : afterIndex + 1;
    const page = filtered.slice(start, start + limit);
    const next = filtered[start + limit];
    return {
      events: page,
      nextCursor: next === undefined ? undefined : page.at(-1)?.id
    };
  }
}

export class FileApprovalStore implements ApprovalStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    return (await this.read()).records.find((record) => record.id === id);
  }

  async list(): Promise<readonly ApprovalRecord[]> {
    return (await this.read()).records;
  }

  async expireDue(now = new Date()): Promise<readonly ApprovalRecord[]> {
    const file = await this.read();
    const materialized = materializeExpiredApprovals(file.records, now);
    if (materialized.expired.length > 0) {
      await this.write({ records: materialized.records });
    }
    return materialized.expired;
  }

  async create(input: CreateApprovalInput): Promise<ApprovalRecord> {
    const file = await this.read();
    const record = createApprovalRecord(input);
    await this.write({ records: [...file.records, record] });
    return record;
  }

  async approve(id: string, approvedBy: string): Promise<{ readonly record: ApprovalRecord; readonly token: string }> {
    const token = generateApprovalToken();
    const updated = await this.updateRecord(id, (record, now) => {
      throwIfExpired(record, now);
      if (record.status !== 'requested') throw new ToolBoundaryError('APPROVAL_INVALID', `Approval ${id} is not requestable`);
      return {
        ...record,
        status: 'approved',
        approvedBy,
        approvalTokenHash: hashApprovalToken(token),
        updatedAt: now.toISOString()
      };
    });
    return { record: updated, token };
  }

  async reject(id: string): Promise<ApprovalRecord> {
    return this.updateRecord(id, (record, now) => {
      throwIfExpired(record, now);
      if (record.status !== 'requested') throw new ToolBoundaryError('APPROVAL_INVALID', `Approval ${id} cannot be rejected`);
      return {
        ...record,
        status: 'rejected',
        updatedAt: now.toISOString()
      };
    });
  }

  async findApprovedByToken(toolName: string, inputHash: string, token: string): Promise<ApprovalRecord> {
    const tokenHash = hashApprovalToken(token);
    const file = await this.read();
    const record = file.records.find((candidate) => candidate.toolName === toolName && candidate.approvalTokenHash === tokenHash);
    if (record === undefined) {
      throw new ToolBoundaryError('APPROVAL_INVALID', 'Approval token is invalid', {
        details: { approvalTokenHash: tokenHash },
        publicDetails: {}
      });
    }
    if (record.status === 'expired') {
      throw approvalExpiredError(record, tokenHash);
    }
    if (record.status === 'consumed') {
      throw new ToolBoundaryError('APPROVAL_ALREADY_CONSUMED', 'Approval token has already been consumed', {
        details: { approvalId: record.id, approvalTokenHash: tokenHash, toolName: record.toolName },
        publicDetails: { approvalId: record.id }
      });
    }
    if (approvalIsExpired(record)) {
      await this.markExpired(record.id);
      throw new ToolBoundaryError('APPROVAL_EXPIRED', 'Approval token is expired', {
        details: { approvalId: record.id, approvalTokenHash: tokenHash, toolName: record.toolName },
        publicDetails: { approvalId: record.id }
      });
    }
    if (record.status !== 'approved') {
      throw new ToolBoundaryError('APPROVAL_INVALID', `Approval is ${record.status}`, {
        details: { approvalId: record.id, approvalTokenHash: tokenHash, toolName: record.toolName },
        publicDetails: { approvalId: record.id }
      });
    }
    if (record.inputHash !== inputHash) {
      throw new ToolBoundaryError('APPROVAL_INVALID', 'Approval input hash does not match this call', {
        details: { approvalId: record.id, approvalTokenHash: tokenHash, toolName: record.toolName },
        publicDetails: { approvalId: record.id }
      });
    }
    return record;
  }

  async consume(id: string): Promise<ApprovalRecord> {
    return this.updateRecord(id, (record, now) => {
      throwIfExpired(record, now);
      if (record.status !== 'approved') throw new ToolBoundaryError('APPROVAL_INVALID', `Approval ${id} cannot be consumed`);
      return {
        ...record,
        status: 'consumed',
        updatedAt: now.toISOString()
      };
    });
  }

  private async markExpired(id: string): Promise<ApprovalRecord> {
    return this.updateRecord(id, (record, now) => ({
      ...record,
      status: 'expired',
      updatedAt: now.toISOString()
    }));
  }

  private async updateRecord(id: string, update: (record: ApprovalRecord, now: Date) => ApprovalRecord): Promise<ApprovalRecord> {
    const file = await this.read();
    let found: ApprovalRecord | undefined;
    let expired: ApprovalRecord | undefined;
    const now = new Date();
    const records = file.records.map((record) => {
      if (record.id !== id) return record;
      try {
        found = update(record, now);
        return found;
      } catch (error) {
        if (isApprovalExpiredError(error) && isExpirable(record) && approvalIsExpired(record, now)) {
          expired = {
            ...record,
            status: 'expired',
            updatedAt: now.toISOString()
          };
          return expired;
        }
        throw error;
      }
    });
    if (found === undefined) {
      if (expired !== undefined) {
        await this.write({ records });
        throw approvalExpiredError(expired);
      }
      throw new ToolBoundaryError('APPROVAL_INVALID', `Approval ${id} was not found`);
    }
    await this.write({ records });
    return found;
  }

  private async read(): Promise<ApprovalFile> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as ApprovalFile;
    } catch (error) {
      if (isMissingFile(error)) return { records: [] };
      throw error;
    }
  }

  private async write(file: ApprovalFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  }
}

export class FileIdempotencyStore implements IdempotencyStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async check(
    toolName: string,
    key: string,
    inputHash: string,
    principalName: string,
    executionFingerprint: string
  ): Promise<IdempotencyCheckResult> {
    const file = await this.read();
    const record = file.records.find(
      (candidate) => candidate.toolName === toolName && candidate.key === key && candidate.principalName === principalName
    );
    if (record === undefined) return { status: 'miss' };
    if (record.inputHash !== inputHash) return { status: 'conflict', reason: 'input_mismatch' };
    if (record.executionFingerprint === undefined) return { status: 'conflict', reason: 'legacy_record' };
    if (record.executionFingerprint !== executionFingerprint) return { status: 'conflict', reason: 'execution_fingerprint_mismatch' };
    return { status: 'replay', result: record.result };
  }

  async record(
    toolName: string,
    key: string,
    inputHash: string,
    principalName: string,
    executionFingerprint: string,
    result: StoredToolCallResult
  ): Promise<void> {
    const file = await this.read();
    const records = file.records.filter((candidate) => !(candidate.toolName === toolName && candidate.key === key && candidate.principalName === principalName));
    records.push({
      toolName,
      key,
      inputHash,
      principalName,
      executionFingerprint,
      result: { ...result, executionFingerprint },
      createdAt: new Date().toISOString()
    });
    await this.write({ records });
  }

  private async read(): Promise<IdempotencyFile> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as IdempotencyFile;
    } catch (error) {
      if (isMissingFile(error)) return { records: [] };
      throw error;
    }
  }

  private async write(file: IdempotencyFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { readonly code?: unknown }).code === 'ENOENT';
}

function materializeExpiredApprovals(
  records: readonly ApprovalRecord[],
  now = new Date()
): { readonly records: readonly ApprovalRecord[]; readonly expired: readonly ApprovalRecord[] } {
  const expired: ApprovalRecord[] = [];
  const updatedAt = now.toISOString();
  const materialized = records.map((record) => {
    if ((record.status === 'requested' || record.status === 'approved') && approvalIsExpired(record, now)) {
      const next = { ...record, status: 'expired' as const, updatedAt };
      expired.push(next);
      return next;
    }
    return record;
  });
  return { records: materialized, expired };
}

function isExpirable(record: ApprovalRecord): boolean {
  return record.status === 'requested' || record.status === 'approved';
}

function approvalExpiredError(record: ApprovalRecord, approvalTokenHash = record.approvalTokenHash): ToolBoundaryError {
  return new ToolBoundaryError('APPROVAL_EXPIRED', 'Approval is expired', {
    details: { approvalId: record.id, toolName: record.toolName, approvalTokenHash },
    publicDetails: { approvalId: record.id }
  });
}

function throwIfExpired(record: ApprovalRecord, now: Date): void {
  if (record.status === 'expired') {
    throw approvalExpiredError(record);
  }
  if (isExpirable(record) && approvalIsExpired(record, now)) {
    throw approvalExpiredError(record);
  }
}

function isApprovalExpiredError(error: unknown): boolean {
  return error instanceof ToolBoundaryError && error.code === 'APPROVAL_EXPIRED';
}
