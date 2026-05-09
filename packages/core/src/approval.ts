import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { ApprovalRecord } from './types.js';

export type CreateApprovalInput = {
  readonly toolName: string;
  readonly inputHash: string;
  readonly requestedBy: string;
  readonly resourceIds?: readonly string[];
  readonly dryRunHash?: string;
  readonly expiresAt?: string;
};

export function createApprovalRecord(input: CreateApprovalInput): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    status: 'requested',
    toolName: input.toolName,
    inputHash: input.inputHash,
    resourceIds: input.resourceIds,
    dryRunHash: input.dryRunHash,
    requestedBy: input.requestedBy,
    expiresAt: input.expiresAt,
    createdAt: now,
    updatedAt: now
  };
}

export function generateApprovalToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashApprovalToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

export function approvalIsExpired(record: ApprovalRecord, now = new Date()): boolean {
  return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now.getTime();
}
