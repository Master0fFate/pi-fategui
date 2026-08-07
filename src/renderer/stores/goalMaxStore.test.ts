import { beforeEach, describe, expect, it } from 'vitest';
import type { GoalMaxState } from '../../shared/contracts/goalmaxxing';
import { useGoalMaxStore } from './goalMaxStore';

function goal(revision = 1): GoalMaxState {
  return {
    schemaVersion: 2, id: 'goal-1', sessionId: 's1', projectPath: '/project', revision, objective: 'Ship', originalBriefRef: null, originalBriefHash: null,
    status: 'active', phase: 'implementation', executionState: 'idle', verificationLevel: 'normal', agentStrategy: 'auto',
    criteria: [{ id: 'criterion-1', title: 'Ship', description: '', required: true, status: 'pending', evidenceIds: [], ownerNodeIds: [], updatedAt: 1 }],
    budget: { tokenLimit: null, timeLimitMs: null, source: null }, permission: { permissionLevel: 'edit', projectTrusted: true, revision: 1, resolvedAt: 1 },
    progress: { meaningfulTurnCount: 0, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0, changedFileCount: 0, baselineWorkspaceFingerprint: 'a', latestWorkspaceFingerprint: 'a', latestEvidenceAt: null, latestMeaningfulProgressAt: null, lastFailureFingerprint: null },
    evidence: [], continuation: { pending: false, attempt: 0, lastScheduledAt: null, lastSettledAt: null, reason: null }, steering: [], childAssignments: [],
    tokensUsed: 0, tokenBaseline: 0, elapsedMs: 0, timeline: [], createdAt: 1, updatedAt: 1, startedAt: 1, completedAt: null, blockedReason: null, failure: null,
  };
}

beforeEach(() => useGoalMaxStore.setState({ projectPath: null, sessionId: null, goal: null, loading: false, selectionGeneration: 0 }));

describe('GoalMax renderer store', () => {
  it('rejects stale hydration after a session switch', () => {
    const first = useGoalMaxStore.getState().selectSession('/project', 's1');
    const second = useGoalMaxStore.getState().selectSession('/project', 's2');
    expect(useGoalMaxStore.getState().hydrate(first, goal())).toBe(false);
    expect(useGoalMaxStore.getState().hydrate(second, null)).toBe(true);
    expect(useGoalMaxStore.getState().goal).toBeNull();
  });

  it('does not let a slower hydration overwrite a newer live event', () => {
    const generation = useGoalMaxStore.getState().selectSession('/project', 's1');
    useGoalMaxStore.getState().setGoal(goal(3));

    expect(useGoalMaxStore.getState().hydrate(generation, goal(2))).toBe(true);
    expect(useGoalMaxStore.getState().hydrate(generation, null)).toBe(true);
    useGoalMaxStore.getState().setGoal(goal(1));
    expect(useGoalMaxStore.getState().goal?.revision).toBe(3);
    expect(useGoalMaxStore.getState().loading).toBe(false);
  });

  it('applies bounded incremental evidence without rebuilding unrelated runtime state', () => {
    const generation = useGoalMaxStore.getState().selectSession('/project', 's1');
    useGoalMaxStore.getState().hydrate(generation, goal());
    useGoalMaxStore.getState().applyEvents([{
      type: 'goalmax.evidence', projectPath: '/project', sessionId: 's1', goalId: 'goal-1', revision: 2, timestamp: 2,
      evidence: { id: 'evidence-1', kind: 'test', title: 'Tests passed', summary: 'ok', criterionIds: [], source: 'root-tool', timestamp: 2, current: true, exitCode: 0 },
    }]);
    expect(useGoalMaxStore.getState().goal).toMatchObject({ revision: 2, evidence: [{ id: 'evidence-1', kind: 'test' }] });
    useGoalMaxStore.getState().applyEvents([{ type: 'goalmax.cleared', projectPath: '/project', sessionId: 's1', goalId: 'goal-1', timestamp: 3 }]);
    expect(useGoalMaxStore.getState().goal).toBeNull();
  });
});
