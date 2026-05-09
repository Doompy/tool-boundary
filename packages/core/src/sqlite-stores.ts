import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import {
  approvalIsExpired,
  createApprovalRecord,
  generateApprovalToken,
  hashApprovalToken,
  type CreateApprovalInput
} from './approval.js';
import { ToolBoundaryError } from './errors.js';
import type { ApprovalRecord, AuditEvent, AuditQuery, AuditQueryResult, StoredToolCallResult } from './types.js';
import type {
  ApprovalStore,
  AuditSink,
  IdempotencyCheckResult,
  IdempotencyConflictReason,
  IdempotencyStore
} from './stores.js';

type ApprovalRow = {
  readonly record_json: string;
};

type IdempotencyRow = {
  readonly input_hash: string;
  readonly execution_fingerprint: string | null;
  readonly result_json: string;
};

type AuditRow = {
  readonly id: string;
  readonly event_json: string;
};

type AuditAfterRow = {
  readonly sequence: number;
};

export class SqliteApprovalStore implements ApprovalStore {
  readonly path: string;
  private readonly db: Database.Database;

  constructor(path: string) {
    this.path = path;
    this.db = openDatabase(path);
    migrate(this.db);
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    const row = this.db.prepare<[string], ApprovalRow>('select record_json from approvals where id = ?').get(id);
    return row === undefined ? undefined : parseApprovalRecord(row.record_json);
  }

  async list(): Promise<readonly ApprovalRecord[]> {
    return this.db
      .prepare<[], ApprovalRow>('select record_json from approvals order by created_at asc')
      .all()
      .map((row) => parseApprovalRecord(row.record_json));
  }

  async expireDue(now = new Date()): Promise<readonly ApprovalRecord[]> {
    const expire = this.db.transaction(() => {
      const records = this.listSync();
      const expired: ApprovalRecord[] = [];
      for (const record of records) {
        if (isExpirable(record) && approvalIsExpired(record, now)) {
          const next = { ...record, status: 'expired' as const, updatedAt: now.toISOString() };
          expired.push(next);
          this.upsert(next);
        }
      }
      return expired;
    });
    return expire();
  }

  async create(input: CreateApprovalInput): Promise<ApprovalRecord> {
    const record = createApprovalRecord(input);
    const create = this.db.transaction(() => {
      this.upsert(record);
      return record;
    });
    return create();
  }

  async approve(id: string, approvedBy: string): Promise<{ readonly record: ApprovalRecord; readonly token: string }> {
    const token = generateApprovalToken();
    const approve = this.db.transaction(() => {
      const record = this.getRequired(id);
      throwIfExpired(record);
      if (record.status !== 'requested') throw new ToolBoundaryError('APPROVAL_INVALID', `Approval ${id} is not requestable`);
      const next: ApprovalRecord = {
        ...record,
        status: 'approved',
        approvedBy,
        approvalTokenHash: hashApprovalToken(token),
        updatedAt: new Date().toISOString()
      };
      this.upsert(next);
      return { record: next, token };
    });
    return approve();
  }

  async reject(id: string): Promise<ApprovalRecord> {
    const reject = this.db.transaction(() => {
      const record = this.getRequired(id);
      throwIfExpired(record);
      if (record.status !== 'requested') throw new ToolBoundaryError('APPROVAL_INVALID', `Approval ${id} cannot be rejected`);
      const next: ApprovalRecord = {
        ...record,
        status: 'rejected',
        updatedAt: new Date().toISOString()
      };
      this.upsert(next);
      return next;
    });
    return reject();
  }

  async findApprovedByToken(toolName: string, inputHash: string, token: string): Promise<ApprovalRecord> {
    const tokenHash = hashApprovalToken(token);
    const row = this.db
      .prepare<[string, string], ApprovalRow>('select record_json from approvals where tool_name = ? and approval_token_hash = ?')
      .get(toolName, tokenHash);
    if (row === undefined) {
      throw new ToolBoundaryError('APPROVAL_INVALID', 'Approval token is invalid', {
        details: { approvalTokenHash: tokenHash },
        publicDetails: {}
      });
    }
    const record = parseApprovalRecord(row.record_json);
    if (record.status === 'expired') throw approvalExpiredError(record, tokenHash);
    if (record.status === 'consumed') {
      throw new ToolBoundaryError('APPROVAL_ALREADY_CONSUMED', 'Approval token has already been consumed', {
        details: { approvalId: record.id, approvalTokenHash: tokenHash, toolName: record.toolName },
        publicDetails: { approvalId: record.id }
      });
    }
    if (approvalIsExpired(record)) {
      const expired = this.markExpired(record);
      throw approvalExpiredError(expired, tokenHash);
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
    const consume = this.db.transaction(() => {
      const record = this.getRequired(id);
      throwIfExpired(record);
      if (record.status !== 'approved') throw new ToolBoundaryError('APPROVAL_INVALID', `Approval ${id} cannot be consumed`);
      const next: ApprovalRecord = {
        ...record,
        status: 'consumed',
        updatedAt: new Date().toISOString()
      };
      this.upsert(next);
      return next;
    });
    return consume();
  }

  private listSync(): readonly ApprovalRecord[] {
    return this.db
      .prepare<[], ApprovalRow>('select record_json from approvals order by created_at asc')
      .all()
      .map((row) => parseApprovalRecord(row.record_json));
  }

  private getRequired(id: string): ApprovalRecord {
    const row = this.db.prepare<[string], ApprovalRow>('select record_json from approvals where id = ?').get(id);
    if (row === undefined) throw new ToolBoundaryError('APPROVAL_INVALID', `Approval ${id} was not found`);
    return parseApprovalRecord(row.record_json);
  }

  private markExpired(record: ApprovalRecord): ApprovalRecord {
    const next: ApprovalRecord = {
      ...record,
      status: 'expired',
      updatedAt: new Date().toISOString()
    };
    this.upsert(next);
    return next;
  }

  private upsert(record: ApprovalRecord): void {
    this.db
      .prepare<
        {
          id: string;
          status: string;
          toolName: string;
          inputHash: string;
          approvalTokenHash: string | null;
          expiresAt: string | null;
          createdAt: string;
          recordJson: string;
        }
      >(
        `insert into approvals (id, status, tool_name, input_hash, approval_token_hash, expires_at, created_at, record_json)
         values (@id, @status, @toolName, @inputHash, @approvalTokenHash, @expiresAt, @createdAt, @recordJson)
         on conflict(id) do update set
           status = excluded.status,
           tool_name = excluded.tool_name,
           input_hash = excluded.input_hash,
           approval_token_hash = excluded.approval_token_hash,
           expires_at = excluded.expires_at,
           record_json = excluded.record_json`
      )
      .run({
        id: record.id,
        status: record.status,
        toolName: record.toolName,
        inputHash: record.inputHash,
        approvalTokenHash: record.approvalTokenHash ?? null,
        expiresAt: record.expiresAt ?? null,
        createdAt: record.createdAt,
        recordJson: JSON.stringify(record)
      });
  }
}

export class SqliteIdempotencyStore implements IdempotencyStore {
  readonly path: string;
  private readonly db: Database.Database;

  constructor(path: string) {
    this.path = path;
    this.db = openDatabase(path);
    migrate(this.db);
  }

  async check(
    toolName: string,
    key: string,
    inputHash: string,
    principalName: string,
    executionFingerprint: string
  ): Promise<IdempotencyCheckResult> {
    const row = this.db
      .prepare<[string, string, string], IdempotencyRow>(
        'select input_hash, execution_fingerprint, result_json from idempotency_records where tool_name = ? and key = ? and principal_name = ?'
      )
      .get(toolName, key, principalName);
    if (row === undefined) return { status: 'miss' };
    if (row.input_hash !== inputHash) return conflict('input_mismatch');
    if (row.execution_fingerprint === null) return conflict('legacy_record');
    if (row.execution_fingerprint !== executionFingerprint) return conflict('execution_fingerprint_mismatch');
    return { status: 'replay', result: parseStoredToolCallResult(row.result_json) };
  }

  async record(
    toolName: string,
    key: string,
    inputHash: string,
    principalName: string,
    executionFingerprint: string,
    result: StoredToolCallResult
  ): Promise<void> {
    const write = this.db.transaction(() => {
      this.db
        .prepare<
          {
            toolName: string;
            key: string;
            inputHash: string;
            principalName: string;
            executionFingerprint: string;
            resultJson: string;
            createdAt: string;
          }
        >(
          `insert into idempotency_records (tool_name, key, input_hash, principal_name, execution_fingerprint, result_json, created_at)
           values (@toolName, @key, @inputHash, @principalName, @executionFingerprint, @resultJson, @createdAt)
           on conflict(tool_name, key, principal_name) do update set
             input_hash = excluded.input_hash,
             execution_fingerprint = excluded.execution_fingerprint,
             result_json = excluded.result_json,
             created_at = excluded.created_at`
        )
        .run({
          toolName,
          key,
          inputHash,
          principalName,
          executionFingerprint,
          resultJson: JSON.stringify({ ...result, executionFingerprint }),
          createdAt: new Date().toISOString()
        });
    });
    write();
  }
}

export class SqliteAuditSink implements AuditSink {
  readonly path: string;
  private readonly db: Database.Database;

  constructor(path: string) {
    this.path = path;
    this.db = openDatabase(path);
    migrate(this.db);
  }

  async write(event: AuditEvent): Promise<void> {
    const write = this.db.transaction(() => {
      this.db
        .prepare<
          {
            id: string;
            eventType: string;
            toolName: string;
            mode: string;
            createdAt: string;
            eventJson: string;
          }
        >(
          `insert into audit_events (id, event_type, tool_name, mode, created_at, event_json)
           values (@id, @eventType, @toolName, @mode, @createdAt, @eventJson)`
        )
        .run({
          id: event.id,
          eventType: event.eventType,
          toolName: event.toolName,
          mode: event.mode,
          createdAt: event.createdAt,
          eventJson: JSON.stringify(event)
        });
    });
    write();
  }

  async query(filter: AuditQuery): Promise<AuditQueryResult> {
    const limit = filter.limit ?? 100;
    const afterSequence = this.afterSequence(filter.after);
    const clauses = ['sequence > @afterSequence'];
    if (filter.toolName !== undefined) clauses.push('tool_name = @toolName');
    if (filter.eventType !== undefined) clauses.push('event_type = @eventType');
    const rows = this.db
      .prepare<
        {
          afterSequence: number;
          toolName?: string;
          eventType?: string;
          limit: number;
        },
        AuditRow
      >(
        `select id, event_json from audit_events
         where ${clauses.join(' and ')}
         order by sequence asc
         limit @limit`
      )
      .all({
        afterSequence,
        toolName: filter.toolName,
        eventType: filter.eventType,
        limit: limit + 1
      });
    const page = rows.slice(0, limit).map((row) => parseAuditEvent(row.event_json));
    return {
      events: page,
      nextCursor: rows.length > limit ? page.at(-1)?.id : undefined
    };
  }

  private afterSequence(after: string | undefined): number {
    if (after === undefined) return 0;
    const row = this.db.prepare<[string], AuditAfterRow>('select sequence from audit_events where id = ?').get(after);
    return row?.sequence ?? 0;
  }
}

function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    create table if not exists approvals (
      id text primary key,
      status text not null,
      tool_name text not null,
      input_hash text not null,
      approval_token_hash text,
      expires_at text,
      created_at text not null,
      record_json text not null
    );
    create index if not exists approvals_tool_token_idx on approvals(tool_name, approval_token_hash);

    create table if not exists idempotency_records (
      tool_name text not null,
      key text not null,
      principal_name text not null,
      input_hash text not null,
      execution_fingerprint text,
      result_json text not null,
      created_at text not null,
      primary key (tool_name, key, principal_name)
    );

    create table if not exists audit_events (
      sequence integer primary key autoincrement,
      id text not null unique,
      event_type text not null,
      tool_name text not null,
      mode text not null,
      created_at text not null,
      event_json text not null
    );
    create index if not exists audit_events_tool_idx on audit_events(tool_name, sequence);
    create index if not exists audit_events_type_idx on audit_events(event_type, sequence);
  `);
}

function parseApprovalRecord(value: string): ApprovalRecord {
  return JSON.parse(value) as ApprovalRecord;
}

function parseStoredToolCallResult(value: string): StoredToolCallResult {
  return JSON.parse(value) as StoredToolCallResult;
}

function parseAuditEvent(value: string): AuditEvent {
  return JSON.parse(value) as AuditEvent;
}

function conflict(reason: IdempotencyConflictReason): IdempotencyCheckResult {
  return { status: 'conflict', reason };
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

function throwIfExpired(record: ApprovalRecord): void {
  if (record.status === 'expired' || (isExpirable(record) && approvalIsExpired(record))) {
    throw approvalExpiredError(record);
  }
}
