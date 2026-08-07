import { describe, expect, it } from 'vitest';
import { sanitizeGeneratedSessionTitle } from './PiSessionTitleGenerator';

describe('sanitizeGeneratedSessionTitle', () => {
  it('normalizes model output into a bounded single-line sidebar title', () => {
    expect(sanitizeGeneratedSessionTitle('  "Fix Git worktree workflow"\nextra text  ')).toBe('Fix Git worktree workflow');
    expect(sanitizeGeneratedSessionTitle('')).toBe('New session');
    expect([...sanitizeGeneratedSessionTitle('🚀'.repeat(80))]).toHaveLength(50);
    expect(sanitizeGeneratedSessionTitle('🚀'.repeat(80)).endsWith('...')).toBe(true);
  });
});
