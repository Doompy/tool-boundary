import { describe, expect, it } from 'vitest';
import { evaluatePolicy, requiresIdempotency, type ToolDefinition, type ToolPolicyDefinition } from '../src/index.js';

const baseTool: ToolDefinition = {
  name: 'admin.searchUsers',
  mode: 'read',
  target: { type: 'mock', result: {} }
};

describe('policy', () => {
  it('allows configured modes', () => {
    expect(evaluatePolicy({ tool: baseTool, policy: { allowedModes: ['read'] } })).toEqual({
      verdict: 'allow',
      reason: 'Policy allowed tool call'
    });
  });

  it('denies modes outside policy', () => {
    const tool: ToolDefinition = { ...baseTool, mode: 'mutate' };
    expect(evaluatePolicy({ tool, policy: { allowedModes: ['read'] } }).verdict).toBe('deny');
  });

  it('requires approval for configured modes', () => {
    const tool: ToolDefinition = { ...baseTool, mode: 'mutate' };
    const policy: ToolPolicyDefinition = {
      allowedModes: ['read', 'mutate'],
      requireApprovalForModes: ['mutate']
    };
    expect(evaluatePolicy({ tool, policy }).verdict).toBe('approval_required');
    expect(evaluatePolicy({ tool, policy, hasValidApproval: true }).verdict).toBe('allow');
  });

  it('detects idempotency requirements', () => {
    const tool: ToolDefinition = { ...baseTool, mode: 'mutate' };
    expect(requiresIdempotency(tool, { requireIdempotencyForModes: ['mutate'] })).toBe(true);
    expect(requiresIdempotency({ ...tool, idempotency: { required: true } }, {})).toBe(true);
  });
});
