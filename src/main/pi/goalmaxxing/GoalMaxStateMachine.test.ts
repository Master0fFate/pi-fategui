import { describe, expect, it } from 'vitest';
import { canTransitionGoalMax, normalizeGoalMaxBrief } from './GoalMaxStateMachine';

describe('GoalMax state machine', () => {
  it('allows recovery paths but rejects terminal resurrection', () => {
    expect(canTransitionGoalMax('active', 'verifying')).toBe(true);
    expect(canTransitionGoalMax('active', 'completed')).toBe(false);
    expect(canTransitionGoalMax('verifying', 'active')).toBe(true);
    expect(canTransitionGoalMax('blocked', 'active')).toBe(true);
    expect(canTransitionGoalMax('completed', 'active')).toBe(false);
    expect(canTransitionGoalMax('cancelled', 'paused')).toBe(false);
  });

  it('derives bounded criteria from long briefs without discarding the source', () => {
    const result = normalizeGoalMaxBrief(`# Release\n\n${'Long source material. '.repeat(900)}\n\n- Implement the control plane\n- Run the full test suite`);
    expect(result.objective.length).toBeLessThanOrEqual(12_000);
    expect(result.preserveBrief).toBe(true);
    expect(result.criteria.map((criterion) => criterion.title)).toEqual(expect.arrayContaining([
      'Implement the control plane', 'Run the full test suite', 'Verify the delivered result',
    ]));
  });
});
