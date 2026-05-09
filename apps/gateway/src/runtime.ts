import { isAbsolute, resolve } from 'node:path';
import {
  FileApprovalStore,
  FileIdempotencyStore,
  JsonlAuditSink,
  SqliteApprovalStore,
  SqliteAuditSink,
  SqliteIdempotencyStore,
  type ApprovalStore,
  type AuditSink,
  type IdempotencyStore
} from '@tool-boundary/core';
import type { LoadedConfig, UnresolvedLoadedConfig } from '@tool-boundary/config';

export type RuntimeStores = {
  readonly auditSink: AuditSink;
  readonly approvalStore: ApprovalStore;
  readonly idempotencyStore: IdempotencyStore;
};

export type RuntimeStoreOverrides = {
  readonly auditSink?: AuditSink;
  readonly approvalStore?: ApprovalStore;
  readonly idempotencyStore?: IdempotencyStore;
};

export function createRuntimeStores(config: LoadedConfig | UnresolvedLoadedConfig, overrides: RuntimeStoreOverrides = {}): RuntimeStores {
  const defaults = createDefaultStores(config);
  return {
    auditSink: overrides.auditSink ?? defaults.auditSink,
    approvalStore: overrides.approvalStore ?? defaults.approvalStore,
    idempotencyStore: overrides.idempotencyStore ?? defaults.idempotencyStore
  };
}

function createDefaultStores(config: LoadedConfig | UnresolvedLoadedConfig): RuntimeStores {
  if (config.storage.type === 'sqlite') {
    const path = resolveConfigPath(config.configDir, config.storage.path);
    return {
      auditSink: new SqliteAuditSink(path),
      approvalStore: new SqliteApprovalStore(path),
      idempotencyStore: new SqliteIdempotencyStore(path)
    };
  }

  const stateDir = resolve(config.configDir, '.tool-boundary');
  return {
    auditSink: new JsonlAuditSink(resolveConfigPath(config.configDir, config.audit.path)),
    approvalStore: new FileApprovalStore(resolve(stateDir, 'approvals.json')),
    idempotencyStore: new FileIdempotencyStore(resolve(stateDir, 'idempotency.json'))
  };
}

function resolveConfigPath(configDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(configDir, path);
}
