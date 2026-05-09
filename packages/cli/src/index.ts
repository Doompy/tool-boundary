#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ToolBoundaryError, toToolBoundaryError } from '@tool-boundary/core';
import { doctorConfig, loadConfig, loadConfigUnresolved } from '@tool-boundary/config';
import { createRuntimeStores, resolveMcpPrincipal, startGateway, startMcpServer } from 'tool-boundary-gateway';

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
      case 'mcp:serve':
        return await mcpServeCommand(argv.slice(1), fullIo);
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

async function mcpServeCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const tokenEnv = getOption(argv, '--token-env');
  if (tokenEnv === undefined) throw new ToolBoundaryError('CONFIG_INVALID', 'mcp:serve requires --token-env');
  const config = await loadConfig(resolveConfigPath(argv, io.cwd), { env: io.env });
  const principal = resolveMcpPrincipal(config, tokenEnv, io.env);
  await startMcpServer(config, { principal });
  return 0;
}

async function doctorCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const config = await loadConfigUnresolved(resolveConfigPath(argv, io.cwd));
  const diagnostics = doctorConfig(config, io.env);
  const format = getOption(argv, '--format') ?? 'text';
  const ci = argv.includes('--ci');
  if (format === 'json') {
    io.stdout(`${JSON.stringify({ diagnostics }, null, 2)}\n`);
  } else if (format === 'sarif') {
    io.stdout(`${JSON.stringify(toSarif(diagnostics), null, 2)}\n`);
  } else if (format !== 'text') {
    throw new ToolBoundaryError('CONFIG_INVALID', `Unsupported doctor format ${format}`);
  } else {
    if (diagnostics.length === 0) {
      io.stdout('OK: no issues found\n');
    } else {
      for (const diagnostic of diagnostics) {
        const tool = diagnostic.toolName === undefined ? '' : ` ${diagnostic.toolName}`;
        io.stdout(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}${tool}: ${diagnostic.message}\n`);
      }
    }
  }
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error') || (ci && diagnostics.length > 0) ? 1 : 0;
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
  const approvals = await createRuntimeStores(config).approvalStore.list();
  for (const approval of approvals) {
    io.stdout(`${approval.id}\t${approval.status}\t${approval.toolName}\t${approval.requestedBy}\n`);
  }
  return 0;
}

async function auditTailCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const config = await loadConfigUnresolved(resolveConfigPath(argv, io.cwd));
  const lines = Number(getOption(argv, '--lines') ?? '20');
  const events = await createRuntimeStores(config).auditSink.query({ limit: 100_000 });
  for (const event of events.events.slice(-lines)) {
    io.stdout(`${JSON.stringify(event)}\n`);
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

function helpText(): string {
  return `Usage: tool-boundary <command> [options]

Commands:
  init [--config path]
  serve --config path
  mcp:serve --config path --token-env env
  doctor --config path [--format text|json|sarif] [--ci]
  tools:list --config path
  approvals:list --config path
  audit:tail --config path [--lines n]
`;
}

function toSarif(diagnostics: readonly { readonly severity: 'error' | 'warning'; readonly code: string; readonly message: string; readonly toolName?: string }[]): object {
  const rules = new Map(diagnostics.map((diagnostic) => [diagnostic.code, diagnostic]));
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'tool-boundary doctor',
            rules: [...rules.values()].map((diagnostic) => ({
              id: diagnostic.code,
              shortDescription: { text: diagnostic.code },
              fullDescription: { text: diagnostic.message }
            }))
          }
        },
        results: diagnostics.map((diagnostic) => ({
          ruleId: diagnostic.code,
          level: diagnostic.severity === 'error' ? 'error' : 'warning',
          message: { text: diagnostic.message },
          locations:
            diagnostic.toolName === undefined
              ? []
              : [
                  {
                    logicalLocations: [{ name: diagnostic.toolName, kind: 'function' }]
                  }
                ]
        }))
      }
    ]
  };
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
        - approvals:request
    - name: local-operator
      tokenEnv: TOOL_BOUNDARY_OPERATOR_TOKEN
      scopes:
        - tools:read
        - approvals:read
        - approvals:approve
        - approvals:reject
        - audit:read

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

storage:
  type: file

policies:
  default:
    allowedModes: [read, draft, dryRun]
  allow-mutating-approved:
    allowedModes: [read, draft, dryRun, mutate]
    requireApprovalForModes: [mutate]
    requireIdempotencyForModes: [mutate]

tools:
  admin.searchUsers:
    version: "2026-05-10.1"
    mode: read
    riskLevel: low
    description: Search users by query and status.
    inputSchema:
      type: object
    outputSchema:
      type: object
    outputValidation:
      enabled: true
      mode: enforce
    target:
      type: http
      method: POST
      url: http://localhost:4001/tools/admin.searchUsers
    audit:
      input: hash
      output: summary
      error: summary

  admin.disableUser:
    version: "2026-05-10.1"
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
    outputValidation:
      enabled: true
      mode: enforce
    target:
      type: http
      method: POST
      url: http://localhost:4001/tools/admin.disableUser
      timeoutMs: 5000
    policy: allow-mutating-approved
    approval:
      previewPaths:
        - /userId
        - /reason
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
