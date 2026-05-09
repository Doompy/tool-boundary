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
import type { ApprovalRecord, AuditEvent, StoredToolCallResult } from './types.js';

type ApprovalFile = {
  readonly records: readonly ApprovalRecord[];
};

type IdempotencyRecord = {
  readonly toolName: string;
  readonly key: string;
  readonly inputHash: string;
  readonly result: StoredToolCallResult;
  readonly createdAt: string;
};

type IdempotencyFile = {
  readonly records: readonly IdempotencyRecord[];
};

export class JsonlAuditSink {
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
}

export class FileApprovalStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async list(): Promise<readonly ApprovalRecord[]> {
    return (await this.read()).records;
  }

  async create(input: CreateApprovalInput): Promise<ApprovalRecord> {
    const file = await this.read();
    const record = createApprovalRecord(input);
    await this.write({ records: [...file.records, record] });
    return record;
  }

  async approve(id: string, approvedBy: string): Promise<{ readonly record: ApprovalRecord; readonly token: string }> {
    const token = generateApprovalToken();
    const updated = await this.updateRecord(id, (record) => {
      if (record.status !== 'requested') {
        throw new ToolBoundaryError('APPROVAL_INVALID', `Approval ${id} is not requestable`);
      }
      return {
        ...record,
        status: 'approved',
        approvedBy,
        approvalTokenHash: hashApprovalToken(token),
        updatedAt: new Date().toISOString()
      };
    });
    return { record: updated, token };
  }

  async reject(id: string): Promise<ApprovalRecord> {
    return this.updateRecord(id, (record) => {
      if (record.status !== 'requested') {
        throw new ToolBoundaryError('APPROVAL_INVALID', `Approval ${id} cannot be rejected`);
      }
      return {
        ...record,
        status: 'rejected',
        updatedAt: new Date().toISOString()
      };
    });
  }

  async findApprovedByToken(toolName: string, inputHash: string, token: string): Promise<ApprovalRecord> {
    const tokenHash = hashApprovalToken(token);
    const file = await this.read();
    const record = file.records.find((candidate) => candidate.toolName === toolName && candidate.approvalTokenHash === tokenHash);
    if (record === undefined) {
      throw new ToolBoundaryError('APPROVAL_INVALID', 'Approval token is invalid');
    }
    if (record.status === 'consumed') {
      throw new ToolBoundaryError('APPROVAL_ALREADY_CONSUMED', 'Approval token has already been consumed');
    }
    if (approvalIsExpired(record)) {
      await this.markExpired(record.id);
      throw new ToolBoundaryError('APPROVAL_EXPIRED', 'Approval token is expired');
    }
    if (record.status !== 'approved') {
      throw new ToolBoundaryError('APPROVAL_INVALID', `Approval is ${record.status}`);
    }
    if (record.inputHash !== inputHash) {
      throw new ToolBoundaryError('APPROVAL_INVALID', 'Approval input hash does not match this call');
    }
    return record;
  }

  async consume(id: string): Promise<ApprovalRecord> {
    return this.updateRecord(id, (record) => {
      if (record.status !== 'approved') {
        throw new ToolBoundaryError('APPROVAL_INVALID', `Approval ${id} cannot be consumed`);
      }
      return {
        ...record,
        status: 'consumed',
        updatedAt: new Date().toISOString()
      };
    });
  }

  private async markExpired(id: string): Promise<ApprovalRecord> {
    return this.updateRecord(id, (record) => ({
      ...record,
      status: 'expired',
      updatedAt: new Date().toISOString()
    }));
  }

  private async updateRecord(id: string, update: (record: ApprovalRecord) => ApprovalRecord): Promise<ApprovalRecord> {
    const file = await this.read();
    let found: ApprovalRecord | undefined;
    const records = file.records.map((record) => {
      if (record.id !== id) return record;
      found = update(record);
      return found;
    });
    if (found === undefined) {
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

export class FileIdempotencyStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async check(
    toolName: string,
    key: string,
    inputHash: string
  ): Promise<{ readonly status: 'miss' } | { readonly status: 'replay'; readonly result: StoredToolCallResult } | { readonly status: 'conflict' }> {
    const file = await this.read();
    const record = file.records.find((candidate) => candidate.toolName === toolName && candidate.key === key);
    if (record === undefined) return { status: 'miss' };
    if (record.inputHash !== inputHash) return { status: 'conflict' };
    return { status: 'replay', result: record.result };
  }

  async record(toolName: string, key: string, inputHash: string, result: StoredToolCallResult): Promise<void> {
    const file = await this.read();
    const records = file.records.filter((candidate) => !(candidate.toolName === toolName && candidate.key === key));
    records.push({
      toolName,
      key,
      inputHash,
      result,
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
