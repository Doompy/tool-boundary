#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileApprovalStore, ToolBoundaryError, toToolBoundaryError } from '@tool-boundary/core';
import { doctorConfig, loadConfig, loadConfigUnresolved } from '@tool-boundary/config';
import { startGateway } from 'tool-boundary-gateway';

export type CliIo = {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

export async function runCli(argv: readonly string[], io: Partial<CliIo> = {}): Promise<number> {
  const fullIo: CliIo = {
    cwd: io.cwd ?? process.cwd(),
    env: io.env ?? process.env,
    stdout: io.stdout ?? ((text) => process.stdout.write(text)),
    stderr: io.stderr ?? ((text) => process.stderr.write(text))
  };

  const [command] = argv;
  try {
    switch (command) {
      case 'init':
        return await initCommand(argv.slice(1), fullIo);
      case 'serve':
        return await serveCommand(argv.slice(1), fullIo);
      case 'doctor':
        return await doctorCommand(argv.slice(1), fullIo);
      case 'tools:list':
        return await toolsListCommand(argv.slice(1), fullIo);
      case 'approvals:list':
        return await approvalsListCommand(argv.slice(1), fullIo);
      case 'audit:tail':
        return await auditTailCommand(argv.slice(1), fullIo);
      case '--help':
      case '-h':
      case undefined:
        fullIo.stdout(helpText());
        return 0;
      default:
        fullIo.stderr(`Unknown command: ${command}\n\n${helpText()}`);
        return 1;
    }
  } catch (error) {
    const normalized = toToolBoundaryError(error);
    fullIo.stderr(`${normalized.code}: ${normalized.message}\n`);
    return normalized.statusCode >= 500 ? 2 : 1;
  }
}

async function initCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const configPath = resolveOptionPath(io.cwd, getOption(argv, '--config') ?? 'tool-boundary.config.yaml');
  if (await exists(configPath)) {
    throw new ToolBoundaryError('CONFIG_INVALID', `${configPath} already exists`);
  }
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, defaultConfigYaml(), { encoding: 'utf8', flag: 'wx' });
  io.stdout(`Created ${configPath}\n`);
  return 0;
}

async function serveCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const configPath = resolveConfigPath(argv, io.cwd);
  const config = await loadConfig(configPath, { env: io.env });
  await startGateway(config, { logger: true });
  io.stdout(`ToolBoundary listening on http://${config.server.host}:${config.server.port}\n`);
  return 0;
}

async function doctorCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const config = await loadConfigUnresolved(resolveConfigPath(argv, io.cwd));
  const diagnostics = doctorConfig(config, io.env);
  if (diagnostics.length === 0) {
    io.stdout('OK: no issues found\n');
    return 0;
  }
  for (const diagnostic of diagnostics) {
    const tool = diagnostic.toolName === undefined ? '' : ` ${diagnostic.toolName}`;
    io.stdout(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}${tool}: ${diagnostic.message}\n`);
  }
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 1 : 0;
}

async function toolsListCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const config = await loadConfigUnresolved(resolveConfigPath(argv, io.cwd));
  for (const tool of Object.values(config.tools)) {
    io.stdout(`${tool.name}\t${tool.mode}\t${tool.target.type}\n`);
  }
  return 0;
}

async function approvalsListCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const config = await loadConfigUnresolved(resolveConfigPath(argv, io.cwd));
  const store = new FileApprovalStore(resolve(config.configDir, '.tool-boundary', 'approvals.json'));
  const approvals = await store.list();
  for (const approval of approvals) {
    io.stdout(`${approval.id}\t${approval.status}\t${approval.toolName}\t${approval.requestedBy}\n`);
  }
  return 0;
}

async function auditTailCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const config = await loadConfigUnresolved(resolveConfigPath(argv, io.cwd));
  const auditPath = resolveOptionPath(config.configDir, config.audit.path);
  const lines = Number(getOption(argv, '--lines') ?? '20');
  const content = await readFile(auditPath, 'utf8').catch((error: unknown) => {
    if (isMissingFile(error)) return '';
    throw error;
  });
  for (const line of content.split(/\r?\n/).filter(Boolean).slice(-lines)) {
    io.stdout(`${line}\n`);
  }
  return 0;
}

function resolveConfigPath(argv: readonly string[], cwd: string): string {
  return resolveOptionPath(cwd, getOption(argv, '--config') ?? 'tool-boundary.config.yaml');
}

function resolveOptionPath(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function getOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { readonly code?: unknown }).code === 'ENOENT';
}

function helpText(): string {
  return `Usage: tool-boundary <command> [options]

Commands:
  init [--config path]
  serve --config path
  doctor --config path
  tools:list --config path
  approvals:list --config path
  audit:tail --config path [--lines n]
`;
}

function defaultConfigYaml(): string {
  return `server:
  host: 127.0.0.1
  port: 3050

auth:
  mode: static-token
  tokens:
    - name: local-agent
      tokenEnv: TOOL_BOUNDARY_AGENT_TOKEN
      scopes:
        - tools:read
        - tools:call

audit:
  sink: jsonl
  path: .tool-boundary/audit.jsonl
  defaults:
    input: hash
    output: summary
    error: summary
    redactPaths:
      - /password
      - /token
      - /secret
      - /authorization

policies:
  default:
    allowedModes: [read, draft, dryRun]
  allow-mutating-approved:
    allowedModes: [read, draft, dryRun, mutate]
    requireApprovalForModes: [mutate]
    requireIdempotencyForModes: [mutate]

tools:
  admin.searchUsers:
    mode: read
    riskLevel: low
    description: Search users by query and status.
    inputSchema:
      type: object
    outputSchema:
      type: object
    target:
      type: http
      method: POST
      url: http://localhost:4001/tools/admin.searchUsers
    audit:
      input: hash
      output: summary
      error: summary

  admin.disableUser:
    mode: mutate
    riskLevel: high
    approvalRequired: true
    description: Disable a user account after operator approval.
    inputSchema:
      type: object
      required: [userId]
      properties:
        userId:
          type: string
    outputSchema:
      type: object
    target:
      type: http
      method: POST
      url: http://localhost:4001/tools/admin.disableUser
      timeoutMs: 5000
    policy: allow-mutating-approved
    idempotency:
      required: true
    audit:
      input: hash
      output: summary
      error: summary
      redactPaths:
        - /reason
`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
