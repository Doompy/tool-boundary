import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { FileApprovalStore } from '@tool-boundary/core';
import { runCli } from '../src/index.js';

describe('cli', () => {
  it('initializes config and reports doctor diagnostics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-cli-'));
    const output: string[] = [];
    const initCode = await runCli(['init'], {
      cwd: dir,
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text)
    });
    expect(initCode).toBe(0);
    expect(await readFile(join(dir, 'tool-boundary.config.yaml'), 'utf8')).toContain('admin.searchUsers');

    const doctorOutput: string[] = [];
    const doctorCode = await runCli(['doctor'], {
      cwd: dir,
      env: {},
      stdout: (text) => doctorOutput.push(text),
      stderr: (text) => doctorOutput.push(text)
    });
    expect(doctorCode).toBe(1);
    expect(doctorOutput.join('')).toContain('STATIC_TOKEN_ENV_MISSING');
  });

  it('lists tools, approvals, and audit lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-boundary-cli-'));
    await runCli(['init'], { cwd: dir, stdout: () => undefined, stderr: () => undefined });

    const toolsOutput: string[] = [];
    expect(await runCli(['tools:list'], { cwd: dir, stdout: (text) => toolsOutput.push(text), stderr: () => undefined })).toBe(0);
    expect(toolsOutput.join('')).toContain('admin.searchUsers');

    const stateDir = join(dir, '.tool-boundary');
    const approvals = new FileApprovalStore(join(stateDir, 'approvals.json'));
    const approval = await approvals.create({
      toolName: 'admin.disableUser',
      inputHash: 'hash',
      requestedBy: 'local-agent'
    });
    const approvalsOutput: string[] = [];
    expect(await runCli(['approvals:list'], { cwd: dir, stdout: (text) => approvalsOutput.push(text), stderr: () => undefined })).toBe(0);
    expect(approvalsOutput.join('')).toContain(approval.id);

    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'audit.jsonl'), '{"id":"1"}\n{"id":"2"}\n');
    const auditOutput: string[] = [];
    expect(await runCli(['audit:tail', '--lines', '1'], { cwd: dir, stdout: (text) => auditOutput.push(text), stderr: () => undefined })).toBe(0);
    expect(auditOutput.join('').trim()).toBe('{"id":"2"}');
  });
});
