import { describe, expect, it } from 'vitest';
import { applyAuditMode, buildApprovalReview, defaultSummary, hashUnknown, redactValue } from '../src/index.js';

describe('audit redaction', () => {
  it('redacts JSON Pointer paths before hashing', () => {
    const value = { user: { password: 'secret', name: 'Ada' } };
    const redacted = redactValue(value, ['/user/password']);
    expect(redacted).toEqual({ user: { password: '[REDACTED]', name: 'Ada' } });
    expect(applyAuditMode(value, 'hash', ['/user/password'])).toBe(hashUnknown(redacted));
  });

  it('supports arrays, escaped paths, and missing paths', () => {
    const value = { users: [{ 'api/key': 'secret', keep: true }] };
    expect(redactValue(value, ['/users/0/api~1key', '/missing/path'])).toEqual({
      users: [{ 'api/key': '[REDACTED]', keep: true }]
    });
  });

  it('uses structural summary without serializing full objects', () => {
    const payload = { secret: 'do-not-leak', nested: { token: 'hidden' } };
    expect(defaultSummary(payload)).toBe('object');
    expect(JSON.stringify(applyAuditMode(payload, 'summary'))).not.toContain('do-not-leak');
  });

  it('converts Error objects safely', () => {
    const error = new Error('secret failure');
    expect(applyAuditMode(error, 'summary')).toBe('object');
    expect(JSON.stringify(applyAuditMode(error, 'redacted', ['/message']))).not.toContain('secret failure');
  });

  it('builds approval preview from redacted JSON Pointer paths only', () => {
    const review = buildApprovalReview(
      { userId: 'usr_123', reason: 'sensitive', nested: { 'reason/code': 'policy' } },
      { previewPaths: ['/userId', '/reason', '/nested/reason~1code'], redactPaths: ['/reason'] }
    );
    expect(review.inputPreview).toEqual({
      '/userId': 'usr_123',
      '/reason': '[REDACTED]',
      '/nested/reason~1code': 'policy'
    });
    expect(JSON.stringify(review)).not.toContain('sensitive');
  });
});
