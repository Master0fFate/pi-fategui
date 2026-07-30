import { describe, expect, it } from 'vitest';
import { budgetViolation, subagentChildBoundary, usageFromMessages } from './SubagentSessionFactory';

describe('SubagentSessionFactory boundaries', () => {
  it('passes arbitrary role and profile labels without inventing scenario instructions', () => {
    const boundary = subagentChildBoundary('database-migration-specialist', 'project/db-expert', 'edit', ['read', 'grep', 'write']);

    expect(boundary).toContain('Delegated role label: database-migration-specialist');
    expect(boundary).toContain('Agent profile: project/db-expert');
    expect(boundary).toContain('Enforced authority: edit');
    expect(boundary).toContain('perform the edits, commands, and verification directly');
    expect(boundary).toContain('intermediate tool output remain in this child session');
    expect(boundary).toContain('Nested Fate subagent orchestration is unavailable');
    expect(boundary).not.toMatch(/scout|planner|reviewer|implementation plan/iu);
  });

  it('audits observable SDK usage and reports exact budget boundaries', () => {
    const usage = usageFromMessages([
      { role: 'assistant', usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { total: 0.02 } } },
      { role: 'assistant', usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { total: 0.01 } } },
      { role: 'user', usage: { input: 1_000 } },
    ]);

    expect(usage).toEqual({ input: 15, output: 7, cacheRead: 2, cacheWrite: 1, cost: 0.03, contextTokens: 8, turns: 2 });
    expect(budgetViolation(usage, { maxTotalTokens: 25 })).toBeUndefined();
    expect(budgetViolation(usage, { maxOutputTokens: 6 })).toBe('output tokens 7 exceeded 6');
  });
});
