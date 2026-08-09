import { describe, expect, it } from 'vitest';
import type { GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import { canTransitionGoalMax, isGoalMaxCriterionEvidence, normalizeGoalMaxBrief, transitionGoalMax } from './GoalMaxStateMachine';

function baseGoal(): GoalMaxState {
  const now = 1_700_000_000_000;
  return {
    schemaVersion: 2,
    id: 'goal-1',
    sessionId: 'session-1',
    projectPath: '/project',
    revision: 1,
    objective: 'Ship the feature',
    originalBriefRef: null,
    originalBriefHash: null,
    status: 'verifying',
    phase: 'verification',
    executionState: 'idle',
    verificationLevel: 'normal',
    agentStrategy: 'auto',
    criteria: [
      { id: 'c1', title: 'Implement A', description: 'do A', required: true, status: 'satisfied', evidenceIds: ['e1'], ownerNodeIds: [], updatedAt: now },
    ],
    budget: { tokenLimit: null, timeLimitMs: null, source: null },
    permission: { permissionLevel: 'edit', projectTrusted: true, revision: 1, resolvedAt: now },
    progress: { meaningfulTurnCount: 1, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0, changedFileCount: 1, baselineWorkspaceFingerprint: 'base', latestWorkspaceFingerprint: 'base', latestEvidenceAt: now, latestMeaningfulProgressAt: now, lastFailureFingerprint: null },
    evidence: [],
    continuation: { pending: false, attempt: 0, lastScheduledAt: null, lastSettledAt: now, reason: null },
    steering: [],
    childAssignments: [],
    tokensUsed: 0,
    tokenBaseline: 0,
    elapsedMs: 0,
    timeline: [],
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    blockedReason: null,
    failure: null,
  };
}

describe('GoalMax Gate A (strict non-verifier evidence)', () => {
  it('classifies only current non-verifier evidence as criterion-supporting', () => {
    expect(isGoalMaxCriterionEvidence({ id: 'x', current: true, source: 'verifier' } as never)).toBe(false);
    expect(isGoalMaxCriterionEvidence({ id: 'x', current: true, source: 'root-tool' } as never)).toBe(true);
    expect(isGoalMaxCriterionEvidence({ id: 'x', current: false, source: 'root-tool' } as never)).toBe(false);
  });

  it('refuses to complete when a required criterion has only verifier evidence', () => {
    const now = 1_700_000_000_001;
    const goal: GoalMaxState = {
      ...baseGoal(),
      evidence: [{ id: 'e1', kind: 'verification', title: 'verifier', summary: 'ok', criterionIds: ['c1'], source: 'verifier', timestamp: now, current: true }],
    };
    expect(() => transitionGoalMax(goal, 'completed', now)).toThrow(/non-verifier evidence/);
  });

  it('completes when a required criterion has current non-verifier evidence', () => {
    const now = 1_700_000_000_002;
    const goal: GoalMaxState = {
      ...baseGoal(),
      evidence: [{ id: 'e1', kind: 'test', title: 'tests', summary: 'passed', criterionIds: ['c1'], source: 'root-tool', timestamp: now, current: true, command: 'pnpm test', exitCode: 0 }],
    };
    const completed = transitionGoalMax(goal, 'completed', now);
    expect(completed.status).toBe('completed');
  });

  it('refuses to complete while a required criterion is still unverified', () => {
    const now = 1_700_000_000_003;
    const goal: GoalMaxState = {
      ...baseGoal(),
      criteria: baseGoal().criteria.map((criterion) => ({ ...criterion, status: 'active' as const })),
      evidence: [{ id: 'e1', kind: 'test', title: 'tests', summary: 'passed', criterionIds: ['c1'], source: 'root-tool', timestamp: now, current: true, command: 'pnpm test', exitCode: 0 }],
    };
    expect(() => transitionGoalMax(goal, 'completed', now)).toThrow(/non-verifier evidence/);
  });
});

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
