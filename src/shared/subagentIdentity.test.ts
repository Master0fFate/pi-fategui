import { describe, expect, it } from 'vitest';
import {
  allocateSubagentIdentity,
  deriveSubagentDisplayName,
  ensureSubagentIdentity,
  normalizeSubagentHandle,
  subagentHandle,
} from './subagentIdentity';

describe('subagent identity', () => {
  it('derives compact task-aware names without exposing the direct profile', () => {
    expect(deriveSubagentDisplayName('reviewer', 'Review the authentication flow')).toBe('Auth Reviewer');
    expect(deriveSubagentDisplayName('worker', 'Run the Playwright tests')).toBe('Test Runner');
    expect(deriveSubagentDisplayName('scout', 'Inspect the architecture boundary')).toBe('Architecture Scout');
    expect(deriveSubagentDisplayName('agent', 'Implement the API migration')).toBe('API Implementer');
  });

  it('allocates canonical numbered handles and skips collisions', () => {
    const first = allocateSubagentIdentity({ role: 'reviewer', task: 'Review auth' }, new Set());
    const second = allocateSubagentIdentity({ role: 'reviewer', task: 'Review auth' }, new Set([first.handle]));

    expect(first).toEqual({ handle: 'auth-reviewer-1', displayName: 'Auth Reviewer' });
    expect(second).toEqual({ handle: 'auth-reviewer-2', displayName: 'Auth Reviewer' });
  });

  it('preserves a valid durable handle but never reuses a collision', () => {
    expect(ensureSubagentIdentity({ handle: 'security-scout-1', displayName: 'Max', role: 'scout', task: 'Security review' }, new Set()))
      .toEqual({ handle: 'security-scout-1', displayName: 'Max' });
    expect(ensureSubagentIdentity({ handle: 'security-scout-1', displayName: 'Max', role: 'scout', task: 'Security review' }, new Set(['security-scout-1'])))
      .toEqual({ handle: 'max-1', displayName: 'Max' });
  });

  it('normalizes mention targets and provides a deterministic legacy fallback', () => {
    expect(normalizeSubagentHandle('@Auth-Reviewer-1')).toBe('auth-reviewer-1');
    expect(normalizeSubagentHandle('@bad_handle')).toBeNull();
    expect(subagentHandle({ id: 'legacy-run', role: 'reviewer', task: 'Review auth' })).toMatch(/^auth-reviewer-[a-z0-9]{6}$/u);
  });
});
