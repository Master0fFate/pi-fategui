import { describe, expect, it } from 'vitest';
import { goalMaxBudgetSchema, goalMaxCreateInputSchema, goalMaxEventSchema } from './goalmaxxing';

describe('GoalMax contracts', () => {
  it('defaults to no invented budget', () => {
    expect(goalMaxCreateInputSchema.parse({ objective: 'Ship the feature' })).toMatchObject({
      verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null,
    });
    expect(goalMaxBudgetSchema.parse({ tokenLimit: null, timeLimitMs: null, source: null })).toEqual({ tokenLimit: null, timeLimitMs: null, source: null });
    expect(() => goalMaxBudgetSchema.parse({ tokenLimit: 1_000, timeLimitMs: null, source: null })).toThrow();
  });

  it('bounds commands and rejects malformed incremental events', () => {
    expect(() => goalMaxCreateInputSchema.parse({ objective: 'x'.repeat(200_001) })).toThrow();
    expect(() => goalMaxEventSchema.parse({ type: 'goalmax.cleared', projectPath: '/project', sessionId: 's1', goalId: '', timestamp: 1 })).toThrow();
  });
});
