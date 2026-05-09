import { createHash } from 'node:crypto';
import type { AuditPayloadPolicy, AuditInputMode, AuditOutputMode, AuditErrorMode } from './types.js';

type AuditMode = AuditInputMode | AuditOutputMode | AuditErrorMode;

export const REDACTED_VALUE = '[REDACTED]';

export function defaultSummary(value: unknown): string {
  if (Array.isArray(value)) return `array(length=${value.length})`;
  if (value === null) return 'null';
  if (value instanceof Error) return `error(name=${value.name})`;
  if (typeof value === 'object') return 'object';
  return typeof value;
}

export function redactValue(value: unknown, redactPaths: readonly string[] = []): unknown {
  const cloned = cloneForAudit(value, new WeakSet<object>());
  for (const path of redactPaths) {
    applyJsonPointerRedaction(cloned, path);
  }
  return cloned;
}

export function applyAuditMode(value: unknown, mode: AuditMode, redactPaths: readonly string[] = []): unknown {
  if (mode === 'omit') return undefined;
  const redacted = redactValue(value, redactPaths);
  if (mode === 'full' || mode === 'redacted') return redacted;
  if (mode === 'hash') return hashUnknown(redacted);
  if (mode === 'summary') return defaultSummary(redacted);
  return redacted;
}

export function applyAuditPolicy(
  value: unknown,
  kind: 'input' | 'output' | 'error',
  policy: AuditPayloadPolicy
): { readonly field: 'value' | 'summary' | 'omit'; readonly value?: unknown; readonly summary?: string } {
  const mode = resolveMode(kind, policy);
  const transformed = applyAuditMode(value, mode, policy.redactPaths ?? []);
  if (mode === 'omit') return { field: 'omit' };
  if (mode === 'summary') return { field: 'summary', summary: String(transformed) };
  return { field: 'value', value: transformed };
}

export function hashUnknown(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableSerialize(value)).digest('hex')}`;
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(sortForStableSerialization(value, new WeakSet<object>()));
}

function resolveMode(kind: 'input' | 'output' | 'error', policy: AuditPayloadPolicy): AuditMode {
  if (kind === 'input') return policy.input ?? 'hash';
  if (kind === 'output') return policy.output ?? 'summary';
  return policy.error ?? 'summary';
}

function cloneForAudit(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    const errorObject: Record<string, unknown> = {
      name: value.name,
      message: value.message
    };
    const maybeCode = (value as { readonly code?: unknown }).code;
    if (maybeCode !== undefined) errorObject.code = maybeCode;
    return errorObject;
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => cloneForAudit(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = cloneForAudit(item, seen);
  }
  return output;
}

function sortForStableSerialization(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sortForStableSerialization(item, seen));
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = sortForStableSerialization((value as Record<string, unknown>)[key], seen);
  }
  return output;
}

function applyJsonPointerRedaction(root: unknown, pointer: string): void {
  if (pointer === '') return;
  if (!pointer.startsWith('/')) return;
  const segments = pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = getChild(current, segments[index]);
    if (current === undefined) return;
  }
  const finalSegment = segments.at(-1);
  if (finalSegment === undefined) return;
  setChild(current, finalSegment, REDACTED_VALUE);
}

function getChild(value: unknown, segment: string): unknown {
  if (Array.isArray(value)) {
    const index = Number(segment);
    if (!Number.isInteger(index) || index < 0) return undefined;
    return value[index];
  }
  if (value !== null && typeof value === 'object') {
    return (value as Record<string, unknown>)[segment];
  }
  return undefined;
}

function setChild(value: unknown, segment: string, replacement: unknown): void {
  if (Array.isArray(value)) {
    const index = Number(segment);
    if (Number.isInteger(index) && index >= 0 && index < value.length) {
      value[index] = replacement;
    }
    return;
  }
  if (value !== null && typeof value === 'object' && Object.hasOwn(value, segment)) {
    (value as Record<string, unknown>)[segment] = replacement;
  }
}
