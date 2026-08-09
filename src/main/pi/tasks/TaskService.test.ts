import { describe, expect, it, vi } from 'vitest';
import type { GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import type { TaskEvent } from '../../../shared/contracts/tasks';
import { isTaskListGateSatisfied } from '../../../shared/contracts/tasks';
import { TaskService } from './TaskService';
import { InMemoryTaskRepository } from './TaskRepository';

function host() {
  const events: TaskEvent[] = [];
  return { emit: vi.fn((event: TaskEvent) => { events.push(event); }), events };
}

function goalFixture(overrides: Partial<GoalMaxState> = {}): GoalMaxState {
  const now = Date.now();
  return {
    schemaVersion: 2,
    id: 'goal-1',
    sessionId: 'session-1',
    projectPath: '/project',
    revision: 1,
    objective: 'Ship the feature',
    originalBriefRef: null,
    originalBriefHash: null,
    status: 'active',
    phase: 'implementation',
    executionState: 'idle',
    verificationLevel: 'normal',
    agentStrategy: 'auto',
    criteria: [
      { id: 'c1', title: 'Implement A', description: 'do A', required: true, status: 'pending', evidenceIds: [], ownerNodeIds: [], updatedAt: now },
      { id: 'c2', title: 'Verify the delivered result', description: 'verify', required: true, status: 'pending', evidenceIds: [], ownerNodeIds: [], updatedAt: now },
    ],
    budget: { tokenLimit: null, timeLimitMs: null, source: null },
    permission: { permissionLevel: 'edit', projectTrusted: true, revision: 1, resolvedAt: now },
    progress: { meaningfulTurnCount: 0, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0, changedFileCount: 0, baselineWorkspaceFingerprint: 'baseline', latestWorkspaceFingerprint: 'baseline', latestEvidenceAt: null, latestMeaningfulProgressAt: null, lastFailureFingerprint: null },
    evidence: [],
    continuation: { pending: false, attempt: 0, lastScheduledAt: null, lastSettledAt: null, reason: null },
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
    ...overrides,
  };
}

describe('TaskService', () => {
  it('creates ordinary tasks and advances revisions race-safely', async () => {
    const svc = new TaskService(host());
    const list = await svc.create('/project', 'session-1', { title: 'Write tests', required: true });
    expect(list.tasks).toHaveLength(1);
    expect(list.revision).toBe(1);
    expect(list.currentTaskId).toBe(list.tasks[0]!.id);
    expect(isTaskListGateSatisfied(list)).toBe(false);
  });

  it('reorders, updates, and deletes user tasks while keeping dense order', async () => {
    const svc = new TaskService(host());
    await svc.create('/project', 'session-1', { title: 'A' });
    await svc.create('/project', 'session-1', { title: 'B' });
    const ids = (await svc.create('/project', 'session-1', { title: 'C' })).tasks.map((task) => task.id);
    const reordered = await svc.reorder('/project', 'session-1', { orderedIds: [ids[2]!, ids[0]!, ids[1]!] });
    expect(reordered.tasks.map((task) => task.title)).toEqual(['C', 'A', 'B']);
    const updated = await svc.update('/project', 'session-1', { id: ids[0]!, status: 'done' });
    expect(updated.tasks.find((task) => task.id === ids[0])?.status).toBe('done');
    const deleted = await svc.delete('/project', 'session-1', { id: ids[0]! });
    expect(deleted.tasks.map((task) => task.title)).toEqual(['C', 'B']);
    expect(deleted.tasks.map((task) => task.order)).toEqual([0, 1]);
  });

  it('mirrors GoalMax criteria into the canonical list and derives verification from evidence', async () => {
    const svc = new TaskService(host());
    const goal = goalFixture();
    let synced = await svc.syncGoal('/project', 'session-1', goal);
    // Two required criteria -> two goalmax tasks; list bound to the goal.
    expect(synced.goalId).toBe('goal-1');
    expect(synced.tasks.every((task) => task.source === 'goalmax' && task.goalCriterionId)).toBe(true);
    expect(synced.tasks.map((task) => task.status)).toEqual(['todo', 'todo']);
    expect(isTaskListGateSatisfied(synced)).toBe(false);

    // Criterion satisfied with NON-VERIFIER evidence but NOT yet verified: gate still closed.
    const now = Date.now();
    const withEvidence: GoalMaxState = {
      ...goal,
      criteria: goal.criteria.map((criterion) => ({ ...criterion, status: 'satisfied', evidenceIds: criterion.id === 'c1' ? ['e1'] : [] })),
      evidence: [{ id: 'e1', kind: 'test', title: 't', summary: 's', criterionIds: ['c1'], source: 'root-tool', timestamp: now, current: true, command: 'pnpm test', exitCode: 0 }],
    };
    synced = await svc.syncGoal('/project', 'session-1', withEvidence);
    expect(synced.tasks.find((task) => task.goalCriterionId === 'c1')?.status).toBe('done');
    expect(synced.tasks.find((task) => task.goalCriterionId === 'c1')?.verified).toBe(false);
    expect(isTaskListGateSatisfied(synced)).toBe(false);

    // Verification evidence cannot turn the task green before the completed
    // state has passed validation and committed durably.
    const verificationPending: GoalMaxState = {
      ...withEvidence,
      status: 'verifying',
      phase: 'verification',
      evidence: [...withEvidence.evidence, { id: 'v1', kind: 'verification', title: 'passed', summary: 'ok', criterionIds: ['c1', 'c2'], source: 'verifier', timestamp: now, current: true }],
    };
    synced = await svc.syncGoal('/project', 'session-1', verificationPending);
    expect(synced.tasks.find((task) => task.goalCriterionId === 'c1')?.verified).toBe(false);
    expect(isTaskListGateSatisfied(synced)).toBe(false);
  });

  it('treats stale verification as unverified (workspace change invalidates verifier evidence)', async () => {
    const svc = new TaskService(host());
    const now = Date.now();
    const verified: GoalMaxState = {
      ...goalFixture(),
      status: 'completed',
      phase: 'handoff',
      completedAt: now,
      criteria: goalFixture().criteria.map((criterion) => ({ ...criterion, status: 'satisfied', evidenceIds: criterion.id === 'c1' ? ['e1'] : ['e2'] })),
      evidence: [
        { id: 'e1', kind: 'test', title: 't', summary: 's', criterionIds: ['c1'], source: 'root-tool', timestamp: now, current: true, command: 'pnpm test', exitCode: 0 },
        { id: 'e2', kind: 'test', title: 't2', summary: 's2', criterionIds: ['c2'], source: 'root-tool', timestamp: now, current: true, command: 'pnpm test', exitCode: 0 },
        { id: 'v1', kind: 'verification', title: 'passed', summary: 'ok', criterionIds: ['c1', 'c2'], source: 'verifier', timestamp: now, current: true },
      ],
    };
    let synced = await svc.syncGoal('/project', 'session-1', verified);
    expect(isTaskListGateSatisfied(synced)).toBe(true);

    // Workspace change invalidates the verifier evidence (current: false).
    const stale: GoalMaxState = {
      ...verified,
      status: 'active',
      phase: 'implementation',
      completedAt: null,
      evidence: verified.evidence.map((evidence) => evidence.kind === 'verification' ? { ...evidence, current: false } : evidence),
    };
    synced = await svc.syncGoal('/project', 'session-1', stale);
    expect(synced.tasks.every((task) => !task.verified)).toBe(true);
    expect(isTaskListGateSatisfied(synced)).toBe(false);
  });

  it('refuses to delete or mutate GoalMax-managed tasks through ordinary CRUD', async () => {
    const svc = new TaskService(host());
    await svc.syncGoal('/project', 'session-1', goalFixture());
    const goalTask = (await svc.get('/project', 'session-1'))!.tasks[0]!;
    await expect(svc.delete('/project', 'session-1', { id: goalTask.id })).rejects.toThrow(/managed by the active goal/);
  });

  it('detaches goal tasks on clear, restoring an ordinary goal-free list', async () => {
    const svc = new TaskService(host());
    await svc.syncGoal('/project', 'session-1', goalFixture());
    await svc.create('/project', 'session-1', { title: 'User task' });
    await svc.detachGoal('/project', 'session-1', 'goal-1');
    const cleared = await svc.get('/project', 'session-1');
    expect(cleared!.goalId).toBeNull();
    expect(cleared!.tasks.every((task) => task.source !== 'goalmax')).toBe(true);
  });

  it('emits a snapshot event for every committed revision', async () => {
    const h = host();
    const svc = new TaskService(h);
    await svc.create('/project', 'session-1', { title: 'A' });
    await svc.create('/project', 'session-1', { title: 'B' });
    await svc.create('/project', 'session-1', { title: 'C' });
    const snapshots = h.events.filter((event) => event.type === 'tasklist.snapshot');
    // Three creates each commit and emit exactly one snapshot (revision 1, 2, 3).
    expect(snapshots.length).toBe(3);
    expect(snapshots.at(-1)!.list!.revision).toBe(3);
  });
});
