import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { ApprovalRecord } from './types.js';
import { defaultSummary, getJsonPointerValue, redactValue } from './redaction.js';

export type CreateApprovalInput = {
  readonly toolName: string;
  readonly inputHash: string;
  readonly requestedBy: string;
  readonly resourceIds?: readonly string[];
  readonly dryRunHash?: string;
  readonly inputSummary?: string;
  readonly inputPreview?: unknown;
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
    inputSummary: input.inputSummary,
    inputPreview: input.inputPreview,
    expiresAt: input.expiresAt,
    createdAt: now,
    updatedAt: now
  };
}

export function buildApprovalReview(
  input: unknown,
  options: { readonly previewPaths?: readonly string[]; readonly redactPaths?: readonly string[] } = {}
): { readonly inputSummary?: string; readonly inputPreview?: unknown } {
  const previewPaths = options.previewPaths ?? [];
  if (previewPaths.length === 0) {
    return { inputSummary: defaultSummary(input) };
  }

  const redacted = redactValue(input, options.redactPaths ?? []);
  const preview: Record<string, unknown> = {};
  for (const path of previewPaths) {
    const value = getJsonPointerValue(redacted, path);
    if (value.found) preview[path] = value.value;
  }

  return {
    inputSummary: summarizePreview(preview),
    inputPreview: preview
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

function summarizePreview(preview: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(preview);
  if (entries.length === 0) return 'preview(empty)';
  return `preview(${entries.map(([path, value]) => `${path}=${defaultSummary(value)}`).join(', ')})`;
}
